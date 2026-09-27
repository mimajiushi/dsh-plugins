/**
 * Subagent model guard for DeepSeek Harness — host half.
 *
 * A host-plane plugin with no tools of its own. It enforces the
 * `subagent-model-selection` whitelist at the one operation that creates a
 * child Agent — `ctx.subagents.start` / `ctx.subagents.startContinuable` — so
 * that AgentTeams members, `subagent`, `subagent_fork`, and workflow-created
 * children all resolve through the same list. A second, earlier layer registers
 * one tool guard that rejects an explicit out-of-list `provider`/`model` on a
 * delegation tool before the call body runs, and — because AgentTeams
 * snapshots member routes into the team record WITHOUT creating a child —
 * also rejects `agent_teams_create` / `agent_teams_add_member` /
 * `agent_teams_edit_plan` calls whose roster would only fail at spawn time.
 *
 * Both layers reject only: nothing is rewritten, no child is created, and the
 * error the model reads names the offending route, every allowed route, and the
 * settings page that owns the list.
 *
 * Installation (bundle): add `link:<this directory>` to the profile's
 * `dependencies` and this package's name to `dsh.profile.bundles`, then restart
 * DSH. See README.md.
 *
 * @module dsh-subagent-model-guard
 */
import {
    NAME,
    SETTINGS_NS,
    decideDelegation,
    delegationErrorText,
    formatRoute,
    guardDecision,
    guardTeamToolDecision,
    parseAllowedModels,
    resolveGuardConfig,
} from './logic.js';

export const name = NAME;

/**
 * Required services. `settings` is taken lazily inside `install` because it is
 * optional: a composition without a settings provider keeps the plugin inert
 * rather than failing to mount.
 */
export const inject = ['subagents', 'tools'];

/**
 * Deliberately NO `Config` export.
 *
 * Cordis treats a plugin's `Config` as a Standard Schema and calls
 * `Config['~standard'].validate(raw)` on every mount; a plain defaults object
 * would make the mount throw before `apply` ever ran. Omitting it hands
 * `resolveGuardConfig()` the raw composition config, which is where the
 * defaults and the loud `enforce` typo check live.
 */
export {
    NAME,
    SETTINGS_NS,
    decideDelegation,
    delegationErrorText,
    effectiveChildRoute,
    formatAllowedRoutes,
    formatRoute,
    guardDecision,
    guardTeamToolDecision,
    isDelegationToolName,
    modelRouteKey,
    parseAllowedModels,
    resolveGuardConfig,
    resolveParentRoute,
} from './logic.js';

/**
 * Runtimes this module has already wrapped. Module-level so two plugin
 * instances (or an HMR reload whose disposer has not run yet) cannot double
 * wrap the same `SubagentRuntime`.
 */
const patchedRuntimes = new WeakSet();

/** Runtimes that already own a registered delegation tool guard. */
const guardedRuntimes = new WeakSet();

/**
 * Wire the plugin onto a host context.
 * @param ctx - host plugin context (`subagents`, `tools`; `settings` optional).
 * @param config - composition entry config (`{ enabled, enforce }`).
 * @returns the live reader used by tests and diagnostics.
 */
export function install(ctx, config) {
    if (ctx === null || typeof ctx !== 'object') {
        throw new TypeError(`${NAME}: a plugin context is required`);
    }
    const settings = resolveGuardConfig(config);
    if (settings.enabled !== true) {
        ctx.logger?.info?.(`${NAME}: disabled by configuration; the subagent model whitelist is not enforced`);
        return { enabled: () => false, policy: () => ({ enabled: false, routes: [] }) };
    }
    const runtime = ctx.subagents;
    if (runtime === null || typeof runtime !== 'object') {
        throw new Error(`${NAME}: the \`subagents\` service is unavailable; mount @deepseek-ai/dsh-subagent first`);
    }

    /** Read the whitelist from the live settings document on every decision. */
    const readPolicy = () => {
        try {
            const service = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
            if (service === undefined || typeof service.get !== 'function') return { enabled: false, routes: [] };
            return parseAllowedModels(service.get(SETTINGS_NS));
        }
        catch (error) {
            ctx.logger?.warn?.(`${NAME}: reading the "${SETTINGS_NS}" settings section failed: ${String(error)}`);
            return { enabled: false, routes: [] };
        }
    };

    /** One warning per distinct refused route per install, so a retry loop stays quiet. */
    let lastRefusal;
    const warnRefusal = (verdict, source) => {
        const key = `${formatRoute(verdict.route)}\u0000${verdict.reason}\u0000${source}`;
        if (key === lastRefusal) return;
        lastRefusal = key;
        ctx.logger?.warn?.(
            `${NAME}: refused to create a child for ${source} — route ${formatRoute(verdict.route)}`
            + ` is not in the "${SETTINGS_NS}" whitelist (${verdict.reason})`,
        );
    };

    /**
     * The shared gate. Runs before the original method, so a refusal cannot
     * leave a partially created child behind.
     * @param parentAgent - the delegating parent Agent.
     * @param agentOptions - the request's child options, when it supplied any.
     * @param source - human-readable delegation source for diagnostics.
     */
    const gateDelegation = (parentAgent, agentOptions, source) => {
        if (parentAgent === undefined || parentAgent === null) return;
        const policy = readPolicy();
        const verdict = decideDelegation({ policy, parentAgent, agentOptions });
        if (verdict.allowed) return;
        warnRefusal(verdict, source);
        throw new Error(delegationErrorText({
            reason: verdict.reason,
            route: verdict.route,
            routes: policy.routes,
            source,
        }));
    };

    // Layer 1 (authoritative): wrap the child-creation operations themselves.
    // Own properties shadow the prototype methods, so both this plugin and
    // AgentTeams' own delegation guard wrap the same instance.
    if (!patchedRuntimes.has(runtime)) {
        ctx.effect(() => {
            const start = runtime.start;
            const startContinuable = runtime.startContinuable;
            const startDescriptor = Object.getOwnPropertyDescriptor(runtime, 'start');
            const continuableDescriptor = Object.getOwnPropertyDescriptor(runtime, 'startContinuable');
            const guardedStart = async (providerName, request) => {
                gateDelegation(
                    request?.parent,
                    request?.agentOptions,
                    `subagent 工具（provider "${providerName}"）`,
                );
                return start.call(runtime, providerName, request);
            };
            const guardedStartContinuable = async (spec) => {
                gateDelegation(
                    spec?.request?.parent,
                    spec?.request?.agentOptions,
                    `continuable 子 Agent（provider "${spec?.provider}"）`,
                );
                return startContinuable.call(runtime, spec);
            };
            patchedRuntimes.add(runtime);
            runtime.start = guardedStart;
            runtime.startContinuable = guardedStartContinuable;

            return () => {
                // Only undo a property this mount still owns: a later mount (or
                // an HMR reload) may already have replaced it.
                for (const [key, wrapper, descriptor] of [
                    ['start', guardedStart, startDescriptor],
                    ['startContinuable', guardedStartContinuable, continuableDescriptor],
                ]) {
                    if (Object.getOwnPropertyDescriptor(runtime, key)?.value !== wrapper) continue;
                    if (descriptor === undefined) Reflect.deleteProperty(runtime, key);
                    else Object.defineProperty(runtime, key, descriptor);
                }
                patchedRuntimes.delete(runtime);
            };
        }, `${NAME}: child-creation gate`);
    }

    // Layer 2 (early feedback): reject an explicit out-of-list request at the
    // tool boundary, so `subagent`/`subagent_fork` fail before any preflight,
    // and an AgentTeams roster that could never spawn is refused while the
    // team is being created rather than after it dead-locks.
    if (typeof ctx.tools?.guard === 'function') {
        const tools = ctx.tools;
        if (!guardedRuntimes.has(runtime)) {
            ctx.effect(() => {
                guardedRuntimes.add(runtime);
                const dispose = tools.guard((execution) => {
                    const policy = readPolicy();
                    return guardDecision(execution, policy) ?? guardTeamToolDecision(execution, policy);
                });
                return () => {
                    if (typeof dispose === 'function') dispose();
                    guardedRuntimes.delete(runtime);
                };
            }, `${NAME}: delegation tool guard`);
        }
    }
    else {
        ctx.logger?.warn?.(
            `${NAME}: \`ctx.tools.guard\` is unavailable on this host; only the child-creation gate enforces the whitelist`,
        );
    }

    return { enabled: () => true, policy: readPolicy, gate: gateDelegation };
}

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 * @param config - composition entry config.
 */
export function apply(ctx, config) {
    install(ctx, config);
}
