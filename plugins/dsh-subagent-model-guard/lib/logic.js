/**
 * Subagent model guard — dependency-free decision logic.
 *
 * This module owns every rule the plugin applies; `index.js` only wires it onto
 * a Cordis context. Keeping the rules here is what lets the whole behavior be
 * unit-tested without a DSH runtime, and it is why this file imports nothing:
 * on this machine the `@deepseek-ai/*` packages resolve out of `app.asar` as
 * one built-in copy, and a plugin importing them would risk a second instance.
 *
 * Why the plugin exists
 * --------------------
 * `subagent-model-selection.allowedModels` is enforced by exactly one place in
 * the shipped harness: the guard inside `@deepseek-ai/dsh-tool-subagent`. Two
 * paths bypass it:
 *
 *   1. AgentTeams spawns members straight through `ctx.subagents.startContinuable`
 *      with a fully resolved `agentOptions`, never passing the tool guard.
 *   2. A delegation that names no provider/model at all inherits the parent's
 *      route, and the built-in guard deliberately returns early for it.
 *
 * The plugin therefore enforces the whitelist at the one operation that creates
 * a child: `ctx.subagents.start` / `startContinuable`. The rule the user chose
 * is *strict*: the route a child would actually run on must be on the list,
 * wherever that route came from — an explicit field, a roster profile, or
 * inheritance from the delegating parent.
 *
 * @module dsh-subagent-model-guard/logic
 */

/** Cordis plugin name (matches the bundle patch row id). */
export const NAME = 'subagent-model-guard';

/** User-settings namespace this plugin reads; the owner is `dsh-tool-subagent`. */
export const SETTINGS_NS = 'subagent-model-selection';

/** Supported enforcement modes. `strict` is the only shipped mode. */
export const ENFORCE_STRICT = 'strict';

/** Tool-name marker: every delegation tool is `subagent` or `subagent_<provider>`. */
const SUBAGENT_TOOL_MARKER = 'subagent';

/**
 * AgentTeams tools whose arguments introduce a member LLM route. They snapshot
 * the route into the durable team record WITHOUT creating a child Agent, so the
 * runtime gate cannot see them: without this list, an off-list roster is only
 * refused later, when the scheduler tries to spawn the member and the whole
 * team dead-locks on `start failed`.
 */
export const TEAM_CREATE_TOOL = 'agent_teams_create';
export const TEAM_ADD_MEMBER_TOOL = 'agent_teams_add_member';
export const TEAM_EDIT_PLAN_TOOL = 'agent_teams_edit_plan';

/**
 * Read-only or control tools in the same name family. They never create a
 * child, so a `provider`/`model` argument on them is not a delegation request —
 * `subagent_report` and the `subagent_report_*` variants stay outside the gate.
 */
const CONTROL_TOOL_PREFIX = 'subagent_report';

/**
 * Whether a tool name belongs to the subagent delegation family.
 *
 * The family is `subagent` plus `subagent_<provider>` for every installed
 * provider (`subagent_fork`, `subagent_codex`, `subagent_claude_code`).
 * Reporting tools are deliberately excluded: missing a genuine delegation tool
 * only costs the early error (the runtime gate still refuses the creation),
 * while guarding a reporting tool would refuse a call that creates no child.
 * @param name - tool name from the tool registry.
 * @returns whether an explicit model request on this tool is intercepted early.
 */
export function isDelegationToolName(name) {
    if (typeof name !== 'string' || name === '') return false;
    if (name === CONTROL_TOOL_PREFIX || name.startsWith(`${CONTROL_TOOL_PREFIX}_`)) return false;
    if (name === SUBAGENT_TOOL_MARKER) return true;
    return name.startsWith(`${SUBAGENT_TOOL_MARKER}_`);
}

/**
 * Stable identity for one provider/model pair.
 * @param route - exact provider/model route.
 * @returns an opaque key for equality checks.
 */
export function modelRouteKey(route) {
    return `${route.provider}\u0000${route.model}`;
}

/**
 * Normalize a settings section into the policy this plugin enforces.
 *
 * Anything that is not an explicitly enabled list with at least one usable
 * route means "no whitelist", and the plugin stays inert. That is deliberate:
 * an absent or unreadable namespace (a profile that never mounted
 * `subagent-model-selection-settings`) must never lock a working deployment.
 * @param section - resolved `subagent-model-selection` value, or anything else.
 * @returns whether the whitelist is active, and its usable routes.
 */
export function parseAllowedModels(section) {
    if (section === null || typeof section !== 'object') return { enabled: false, routes: [] };
    if (section.enabled !== true) return { enabled: false, routes: [] };
    const raw = section.allowedModels;
    if (!Array.isArray(raw)) return { enabled: false, routes: [] };
    const routes = [];
    const seen = new Set();
    for (const candidate of raw) {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const provider = candidate.provider;
        const model = candidate.model;
        if (typeof provider !== 'string' || provider === '') continue;
        if (typeof model !== 'string' || model === '') continue;
        const key = modelRouteKey({ provider, model });
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push({ provider, model });
    }
    return routes.length === 0 ? { enabled: false, routes: [] } : { enabled: true, routes };
}

/**
 * Resolve the exact route a delegating parent is currently running on.
 * Mirrors `parentAgentOptionsForDelegation()` from `dsh-subagent`: the latest
 * request header owns the route as one unit after request-time selection, and
 * the agent's creation options are the whole fallback only before the first
 * request. Mixing a field from each source would invent a route the parent
 * never ran on.
 * @param parentAgent - the live delegating Agent.
 * @returns the parent route, or `undefined` when the owning source is incomplete.
 */
export function resolveParentRoute(parentAgent) {
    const config = parentAgent?.session?.requestHeader?.()?.config;
    const source = config ?? parentAgent?.options;
    const provider = source?.provider;
    const model = source?.model;
    if (typeof provider !== 'string' || provider === '') return undefined;
    if (typeof model !== 'string' || model === '') return undefined;
    return { provider, model };
}

/**
 * Resolve the route a child would actually run on.
 * A request field overrides the parent route field by field, exactly as
 * `resolveChildAgentOptions()` merges them before creating the child.
 * @param parentAgent - the live delegating Agent.
 * @param agentOptions - the request's child options, when it supplied any.
 * @returns the effective route, or `undefined` when it cannot be resolved.
 */
export function effectiveChildRoute(parentAgent, agentOptions) {
    const parentRoute = resolveParentRoute(parentAgent);
    const requestedProvider = typeof agentOptions?.provider === 'string' && agentOptions.provider !== ''
        ? agentOptions.provider
        : undefined;
    const requestedModel = typeof agentOptions?.model === 'string' && agentOptions.model !== ''
        ? agentOptions.model
        : undefined;
    const provider = requestedProvider ?? parentRoute?.provider;
    const model = requestedModel ?? parentRoute?.model;
    if (provider === undefined || model === undefined) return undefined;
    return { provider, model };
}

/**
 * Decide whether one proposed child creation may proceed.
 * @param input - the policy, the delegating parent, and the request's child options.
 * @returns an allow verdict, or the denial reason plus the offending route.
 */
export function decideDelegation(input) {
    const { policy, parentAgent, agentOptions } = input;
    if (policy?.enabled !== true) return { allowed: true };
    const requestedProvider = typeof agentOptions?.provider === 'string' && agentOptions.provider !== '';
    const requestedModel = typeof agentOptions?.model === 'string' && agentOptions.model !== '';
    const route = effectiveChildRoute(parentAgent, agentOptions);
    if (route === undefined) {
        return {
            allowed: false,
            reason: 'unresolvable',
            route: undefined,
            explicit: requestedProvider || requestedModel,
        };
    }
    const explicit = requestedProvider || requestedModel;
    if (policy.routes.some((candidate) => candidate.provider === route.provider && candidate.model === route.model)) {
        return { allowed: true, route, explicit };
    }
    return {
        allowed: false,
        reason: explicit ? 'not-whitelisted' : 'parent-route-not-whitelisted',
        route,
        explicit,
    };
}

/**
 * Render the allowed routes as the bullet list every denial carries.
 * @param routes - the configured whitelist.
 * @returns one `- provider/model` line per route.
 */
export function formatAllowedRoutes(routes) {
    if (!Array.isArray(routes) || routes.length === 0) return '  - （无）';
    return routes.map((route) => `  - ${route.provider}/${route.model}`).join('\n');
}

/**
 * Model-facing denial text. The model reads it as `Error: <text>`, so it names
 * the offending route, the complete set of usable routes, and the exact place
 * to change the list.
 * @param input - denial reason, offending route, whitelist, and delegation source.
 * @returns the complete error text.
 */
export function delegationErrorText(input) {
    const source = input.source === undefined || input.source === '' ? '未知来源' : input.source;
    const detail = `${input.detail === undefined ? '' : input.detail}`;
    const route = input.route === undefined ? '（无法解析）' : `${input.route.provider}/${input.route.model}`;
    const header = `subagent 模型白名单拦截：${source} 被拒绝，未创建任何子 Agent。`;
    if (input.reason === 'unresolvable') {
        return `${header}\n原因：无法从队长路由或本次参数解析出最终 provider/model。\n`
            + '请显式提供 `provider` 与 `model`（使用 `list_subagent_models` 查询可用组合），或确认队长会话已有路由。';
    }
    if (input.reason === 'parent-route-not-whitelisted') {
        return `${header}\n原因：本次没有显式选择模型，子 Agent 会继承队长的路由 "${route}"，该路由不在白名单内。\n`
            + `当前允许的模型（${input.routes.length} 个）：\n${formatAllowedRoutes(input.routes)}\n`
            + '可选做法：把队长的模型切到上面的某个模型后重试；或在设置里放行该路由。';
    }
    if (input.reason === 'not-whitelisted') {
        return `${header}\n原因：路由 "${route}" 不在白名单内。\n`
            + `当前允许的模型（${input.routes.length} 个）：\n${formatAllowedRoutes(input.routes)}\n`
            + '请把 `provider` 与 `model` 改成上面之一（用 `list_subagent_models` 可查看每个模型的 reasoning effort），'
            + '或在「设置 → 插件 → subagent-model-selection」里加入该模型。';
    }
    return `${header}\n原因：${input.reason}${detail}\n`
        + `当前允许的模型（${input.routes.length} 个）：\n${formatAllowedRoutes(input.routes)}`;
}

/**
 * Format a route for a log line.
 * @param route - a resolved or offending route.
 * @returns `provider/model`, or a placeholder.
 */
export function formatRoute(route) {
    return route === undefined ? '(unresolved)' : `${route.provider}/${route.model}`;
}

/**
 * Tool-layer guard: reject an explicit model request that cannot be satisfied.
 *
 * Monotonic and side-effect free — it returns a denial string or `undefined`.
 * Only `provider`/`model` are judged here: an explicit `reasoning_effort` is
 * left to the runtime gate, because effort ids are validated against the target
 * model by the LLM runtime rather than by this list.
 * @param execution - one pending tool call.
 * @param policy - the active whitelist.
 * @returns a denial reason, or `undefined` to leave the call allowed.
 */
export function guardDecision(execution, policy) {
    if (policy?.enabled !== true) return undefined;
    if (execution === null || typeof execution !== 'object') return undefined;
    if (!isDelegationToolName(execution.name)) return undefined;
    const args = execution.arguments;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const provider = args.provider;
    const model = args.model;
    if (typeof provider !== 'string' || provider === '') return undefined;
    if (typeof model !== 'string' || model === '') return undefined;
    if (policy.routes.some((route) => route.provider === provider && route.model === model)) return undefined;
    return delegationErrorText({
        reason: 'not-whitelisted',
        route: { provider, model },
        routes: policy.routes,
        source: `工具调用 \`${execution.name}\``,
    });
}

/**
 * Trim a route field the way AgentTeams does (`args.provider?.trim()`), so an
 * empty or blank value means "absent", exactly as `resolveMemberLlmSelection`
 * treats it.
 * @param value - a raw provider/model argument.
 * @returns the trimmed value, or `undefined` when absent or blank.
 */
function trimmedRouteField(value) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

/**
 * Lift the member-route candidates out of one AgentTeams tool call.
 *
 * The resolution mirrors `resolveMemberLlmSelection()` from
 * `@nanmicoder/dsh-agent-teams`: an explicit field wins, and a missing field
 * falls back to the captain's current route (this deployment does not
 * configure `memberModel`; if one ever is, a member that omits only `model`
 * would actually resolve to it instead — noted in README).
 *
 * Skipped on purpose:
 *  - `agent_teams_create` with `profile` and no inline `plan`: the roster is
 *    expanded inside the tool from files this guard cannot see. Those members
 *    are still refused by the runtime gate at spawn time.
 *  - a candidate with `provider` but no `model` on create/add_member: the
 *    AgentTeams tool itself rejects that combination with its own error.
 *  - `update_member` operations that change only one half of the route: the
 *    other half merges with the member's stored route, which this guard does
 *    not read. A complete `provider`+`model` replacement IS judged here.
 * @param name - tool name from the tool registry.
 * @param args - the tool call arguments.
 * @returns zero or more `{ source, agentOptions, fullyExplicit }` candidates.
 */
function teamRouteCandidates(name, args) {
    const candidates = [];
    if (name === TEAM_CREATE_TOOL) {
        const plan = args.plan;
        if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return candidates;
        const members = plan.members;
        if (!Array.isArray(members)) return candidates;
        for (let index = 0; index < members.length; index++) {
            const member = members[index];
            if (member === null || typeof member !== 'object' || Array.isArray(member)) continue;
            const provider = trimmedRouteField(member.provider);
            const model = trimmedRouteField(member.model);
            if (provider !== undefined && model === undefined) continue;
            const label = typeof member.name === 'string' && member.name.trim() !== ''
                ? `成员 "${member.name.trim()}"`
                : `第 ${index + 1} 个成员`;
            candidates.push({
                source: `工具调用 \`${TEAM_CREATE_TOOL}\` 的${label}`,
                agentOptions: { provider, model },
                fullyExplicit: provider !== undefined && model !== undefined,
            });
        }
        return candidates;
    }
    if (name === TEAM_ADD_MEMBER_TOOL) {
        const provider = trimmedRouteField(args.provider);
        const model = trimmedRouteField(args.model);
        if (provider !== undefined && model === undefined) return candidates;
        const label = typeof args.name === 'string' && args.name.trim() !== ''
            ? `（成员 "${args.name.trim()}"）`
            : '';
        candidates.push({
            source: `工具调用 \`${TEAM_ADD_MEMBER_TOOL}\`${label}`,
            agentOptions: { provider, model },
            fullyExplicit: provider !== undefined && model !== undefined,
        });
        return candidates;
    }
    if (name === TEAM_EDIT_PLAN_TOOL) {
        const operations = args.operations;
        if (!Array.isArray(operations)) return candidates;
        for (const operation of operations) {
            if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) continue;
            if (operation.action !== 'update_member') continue;
            const provider = trimmedRouteField(operation.provider);
            const model = trimmedRouteField(operation.model);
            if (provider === undefined || model === undefined) continue;
            const label = typeof operation.member_name === 'string' && operation.member_name.trim() !== ''
                ? `（成员 "${operation.member_name.trim()}"）`
                : '';
            candidates.push({
                source: `工具调用 \`${TEAM_EDIT_PLAN_TOOL}\` 的 update_member${label}`,
                agentOptions: { provider, model },
                fullyExplicit: true,
            });
        }
        return candidates;
    }
    return candidates;
}

/**
 * Tool-layer guard for AgentTeams roster tools: refuse the call BEFORE the
 * team record is written when any member's effective route is off-list.
 *
 * Semantics match the runtime gate: with no calling agent available, only a
 * fully explicit route can be judged here and everything else is left to the
 * spawn-time gate ("nothing to resolve is not a refusal"). With an agent,
 * inheritance is judged exactly like `decideDelegation` does at spawn.
 * @param execution - one pending tool call.
 * @param policy - the active whitelist.
 * @returns a denial reason, or `undefined` to leave the call allowed.
 */
export function guardTeamToolDecision(execution, policy) {
    if (policy?.enabled !== true) return undefined;
    if (execution === null || typeof execution !== 'object') return undefined;
    const args = execution.arguments;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const parentAgent = execution.agent ?? undefined;
    for (const candidate of teamRouteCandidates(execution.name, args)) {
        if (parentAgent === undefined && candidate.fullyExplicit !== true) continue;
        const verdict = decideDelegation({ policy, parentAgent, agentOptions: candidate.agentOptions });
        if (verdict.allowed) continue;
        return delegationErrorText({
            reason: verdict.reason,
            route: verdict.route,
            routes: policy.routes,
            source: candidate.source,
        });
    }
    return undefined;
}

/**
 * Validate the plugin's own composition config, failing loud on a typo rather
 * than silently running in a weaker mode.
 * @param config - the composition entry config.
 * @returns the effective `{ enabled, enforce }`.
 */
export function resolveGuardConfig(config) {
    const source = config === null || typeof config !== 'object' ? {} : config;
    if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
        throw new TypeError(`${NAME}: \`enabled\` must be a boolean`);
    }
    if (source.enforce !== undefined && source.enforce !== ENFORCE_STRICT) {
        throw new TypeError(`${NAME}: \`enforce\` must be "${ENFORCE_STRICT}" (got ${JSON.stringify(source.enforce)})`);
    }
    return { enabled: source.enabled ?? true, enforce: source.enforce ?? ENFORCE_STRICT };
}
