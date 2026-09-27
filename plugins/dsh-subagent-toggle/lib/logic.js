/**
 * Subagent capability toggle — dependency-free decision logic.
 *
 * This module owns every rule the plugin applies; `index.js` only wires it
 * onto a Cordis context. Keeping the rules here is what lets the whole
 * behavior be unit-tested without a DSH runtime, and it is why this file
 * imports nothing: on this machine the `@deepseek-ai/*` packages resolve out
 * of `app.asar` as one built-in copy, and a plugin importing them would risk
 * a second instance.
 *
 * Why the plugin exists
 * ---------------------
 * The user wants a Settings switch for the subagent capability. While the
 * switch is off, every tool that can create or wake a subagent is denied with
 * a message that redirects the model to Agent Teams.
 *
 * The gate sits at exactly one layer: `ctx.tools.guard`, the tool registry's
 * own monotonic denial hook. On this machine every model-reachable subagent
 * entry point is a registered tool (verified by scanning the packaged core
 * and every installed profile plugin):
 *
 *   blocked when off        left alone (by design)
 *   ----------------        ----------------------
 *   subagent                agent_teams_* (the replacement)
 *   subagent_fork           list_agents (read-only)
 *   subagent_<provider>     interrupt_agent (stops leftover children)
 *   workflow                everything else
 *   ralph
 *   list_subagent_models
 *   send_message (can wake an idle child into a new turn)
 *
 * Paths that create agents WITHOUT a tool call — AgentTeams member spawning
 * (`ctx.subagents.startContinuable`, label prefix `agent-teams:`), the Mnemon
 * memory system's internal delegations (idle review, recall answers,
 * writeback, archiving), goal continuation rounds, and the task board — are
 * NOT gated. That is deliberate (confirmed with the user): they are host
 * infrastructure, not the model-facing capability being switched.
 *
 * @module dsh-subagent-toggle/logic
 */

/** Cordis plugin name (matches the bundle patch row id). */
export const NAME = 'subagent-toggle';

/** User-settings namespace this plugin owns and reads. */
export const SETTINGS_NS = 'dsh-subagent-toggle';

/** The single settings field: whether the subagent capability is ON. */
export const ENABLED_FIELD = 'enabled';

/**
 * Non-family tool names blocked while the switch is off.
 *
 * - `workflow` / `ralph` fan out subagents (the workflow engine calls
 *   `subagents.start` per `agent()` from dsh-workflow-worker-thread).
 * - `list_subagent_models` only serves delegation; with delegation off it
 *   would advertise routes the model cannot use.
 * - `send_message` can start a NEW turn for an idle or ready child, which is
 *   subagent work by another name.
 *
 * `list_agents` (read-only) and `interrupt_agent` (stops children) stay
 * allowed on purpose: switching the capability off must not orphan or
 * unstoppable-ize children that already exist.
 */
export const DEFAULT_EXTRA_BLOCKED = ['workflow', 'ralph', 'list_subagent_models', 'send_message'];

/** Tool-name marker: every delegation tool is `subagent` or `subagent_<provider>`. */
const SUBAGENT_TOOL_MARKER = 'subagent';

/**
 * Reporting tools in the same name family. They never create a child, so
 * they stay outside the gate even while the switch is off.
 */
const CONTROL_TOOL_PREFIX = 'subagent_report';

/**
 * Whether a tool name belongs to the subagent delegation family.
 *
 * The family is `subagent` plus `subagent_<provider>` for every installed
 * provider (`subagent_fork`, `subagent_codex`, …). Reporting tools are
 * deliberately excluded: they create nothing.
 * @param name - tool name from the tool registry.
 * @returns whether this name is a delegation tool.
 */
export function isSubagentToolName(name) {
    if (typeof name !== 'string' || name === '') return false;
    if (name === CONTROL_TOOL_PREFIX || name.startsWith(`${CONTROL_TOOL_PREFIX}_`)) return false;
    if (name === SUBAGENT_TOOL_MARKER) return true;
    return name.startsWith(`${SUBAGENT_TOOL_MARKER}_`);
}

/**
 * Whether a tool call must be denied while the switch is off.
 * @param name - tool name from the tool registry.
 * @param extras - extra exact names from the composition config.
 * @returns whether the call is part of the switched capability.
 */
export function isBlockedToolName(name, extras) {
    if (isSubagentToolName(name)) return true;
    if (!Array.isArray(extras)) return false;
    return extras.includes(name);
}

/**
 * Normalize a settings section into the policy this plugin enforces.
 *
 * Only an explicit `enabled: false` switches the capability off. Anything
 * else — a missing section, a malformed one, a missing field — means ON.
 * That is deliberate: an absent or unreadable namespace must never silently
 * disable a working deployment.
 * @param section - resolved `dsh-subagent-toggle` value, or anything else.
 * @returns the effective policy.
 */
export function parsePolicy(section) {
    if (section === null || typeof section !== 'object') return { enabled: true };
    return { enabled: section[ENABLED_FIELD] !== false };
}

/**
 * Model-facing denial text. The tool registry wraps the returned string as
 * `Error: <text>` in an error tool result, so this is the exact message the
 * model reads. It names what happened, what to use instead, and where the
 * switch lives.
 * @param toolName - the denied tool's name.
 * @returns the complete denial reason.
 */
export function denialText(toolName) {
    const tool = typeof toolName === 'string' && toolName !== '' ? `\`${toolName}\`` : '该工具';
    return `subagent 能力已被用户在设置中关闭：${tool} 调用未执行，没有创建或唤醒任何子 Agent。\n`
        + '请改用 Agent Teams 完成需要并行或分工的工作：\n'
        + '- `agent_teams_create` 创建团队（本机已关闭计划审批，用 `approval: "automatic"`）；\n'
        + '- `agent_teams_add_member` 添加成员、`agent_teams_create_task` 创建任务；\n'
        + '- `agent_teams_send_message` / `agent_teams_status` 协调与查看进度。\n'
        + '（团队成员需要联系队长时请用 `agent_teams_send_message`；`interrupt_agent` 仍可用于停止遗留的子 Agent。）\n'
        + '如需恢复 subagent，请用户在「设置 → 插件 → 插件配置 → Subagent 开关」中打开。';
}

/**
 * The guard callback itself: monotonic, synchronous, side-effect free.
 * @param execution - one pending tool call (`{ name, arguments, … }`).
 * @param policy - the active policy from `parsePolicy`.
 * @param extras - extra exact tool names from the composition config.
 * @returns a denial reason, or `undefined` to leave the call allowed.
 */
export function guardDecision(execution, policy, extras) {
    if (policy?.enabled !== false) return undefined;
    if (execution === null || typeof execution !== 'object') return undefined;
    if (!isBlockedToolName(execution.name, extras)) return undefined;
    return denialText(execution.name);
}

/**
 * Validate the plugin's own composition config, failing loud on a typo
 * rather than silently running with a different block list than the file
 * says.
 * @param config - the composition entry config.
 * @returns the effective `{ enabled, extraBlockedTools }`.
 */
export function resolvePluginConfig(config) {
    const source = config === null || typeof config !== 'object' ? {} : config;
    if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
        throw new TypeError(`${NAME}: \`enabled\` must be a boolean`);
    }
    if (source.extraBlockedTools !== undefined) {
        if (!Array.isArray(source.extraBlockedTools)
            || source.extraBlockedTools.some((name) => typeof name !== 'string' || name === '')) {
            throw new TypeError(`${NAME}: \`extraBlockedTools\` must be an array of non-empty tool names`);
        }
    }
    return {
        enabled: source.enabled ?? true,
        extraBlockedTools: source.extraBlockedTools ?? [...DEFAULT_EXTRA_BLOCKED],
    };
}
