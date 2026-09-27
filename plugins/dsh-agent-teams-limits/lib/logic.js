/**
 * AgentTeams limits - dependency-free decision logic.
 *
 * The whole behaviour lives here so it can be tested without a DSH runtime:
 * which loader fiber is the AgentTeams row, how the settings section becomes the
 * two numbers, what gets injected into that fiber's config, how the live bridge
 * is reached, and the model-facing prompt line.
 *
 * Two numbers, both optional:
 *   * `maxMembers` - how many members one team's roster may hold. AgentTeams'
 *     own default is `8` (`z.natural().min(1).default(8)`), used in
 *     `profiles.js` (inline/configured roster size) and `tools.js` (the
 *     `agent_teams_add_member` cap). Injecting a higher value is what lets a
 *     10-member plan be created at all.
 *   * `maxConcurrentMembers` - how many members of ONE team may work at the same
 *     time. This knob does not exist upstream: it arrives with
 *     `scripts/patch-agent-teams-limits.mjs` (config field + scheduler gate +
 *     `__limits` bridge). `0`/absent means "no cap", the stock behaviour.
 *
 * @module dsh-agent-teams-limits/logic
 */

/** Cordis plugin name (matches the bundle patch row id). */
export const NAME = 'agent-teams-limits';

/** User-settings namespace (`settings.yaml` section key) and the card's slot key. */
export const SETTINGS_NS = 'agent-teams-limits';

/** Roster cap field. */
export const MAX_MEMBERS_FIELD = 'maxMembers';

/** Per-team concurrency field. */
export const MAX_CONCURRENT_FIELD = 'maxConcurrentMembers';

/** The third-party package that owns the rows this plugin configures. */
export const TARGET_PACKAGE = '@nanmicoder/dsh-agent-teams';

/** Bundle row id of that package (`- id: agent-teams` in its bundle patch). */
export const TARGET_ROW_ID = 'agent-teams';

/** Cordis plugin name of that package (`export const name = 'agent-teams'`). */
export const TARGET_PLUGIN_NAME = 'agent-teams';

/**
 * Process-stable symbol the patch publishes its live limits bridge on. Kept in
 * sync with `patch-agent-teams-limits.mjs`; a mismatch silently degrades to
 * "settings change needs a restart", which the host logs as a warning.
 */
export const LIMITS_SYMBOL_KEY = 'dsh.agent-teams.limits';

/** Accepted range of the roster cap. */
export const MEMBERS_MIN = 1;
/** Upper bound: well past any real team, still a deliberate ceiling. */
export const MEMBERS_MAX = 64;
/** Accepted range of the concurrency cap (`0` = unlimited). */
export const CONCURRENT_MIN = 0;
/** Upper bound for the concurrency cap. */
export const CONCURRENT_MAX = 32;

/**
 * System-prompt section order. AgentTeams registers its captain protocol at 117
 * and the approval override at 118; this note follows both and is empty (dropped)
 * while no limit is configured.
 */
export const PROMPT_SECTION_ORDER = 119;

/** Log prefix for every diagnostic this plugin writes. */
export const LOG_TAG = 'dsh-agent-teams-limits';

/**
 * Clamp one candidate value into an integer range.
 *
 * Anything that is not a finite number (or a numeric string) answers
 * `undefined`, which means "not configured" — the same state as leaving the card
 * field empty. A hand-edited out-of-range value is clamped rather than dropped,
 * so a typo cannot silently disable the cap the user asked for.
 *
 * @param value - raw value from the settings document.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the clamped integer, or undefined when the value is unusable.
 */
export function clampInt(value, min, max) {
    if (value === undefined || value === null || value === '') return undefined;
    const numeric = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(numeric)) return undefined;
    const integer = Math.trunc(numeric);
    if (integer < min) return min;
    if (integer > max) return max;
    return integer;
}

/**
 * Resolve one settings section into the limits to enforce.
 *
 * Absent fields stay absent: an empty section means "contribute nothing at all",
 * which keeps an unconfigured install byte-identical to one without this plugin.
 *
 * @param section - resolved `agent-teams-limits` section (or anything else).
 * @returns `{ maxMembers?, maxConcurrentMembers? }`.
 */
export function normalizeLimits(section) {
    const limits = {};
    const source = section !== null && typeof section === 'object' ? section : {};
    const members = clampInt(source[MAX_MEMBERS_FIELD], MEMBERS_MIN, MEMBERS_MAX);
    if (members !== undefined) limits[MAX_MEMBERS_FIELD] = members;
    const concurrent = clampInt(source[MAX_CONCURRENT_FIELD], CONCURRENT_MIN, CONCURRENT_MAX);
    if (concurrent !== undefined) limits[MAX_CONCURRENT_FIELD] = concurrent;
    return limits;
}

/**
 * Whether any limit is configured.
 * @param limits - normalized limits.
 * @returns true when at least one field is set.
 */
export function hasLimits(limits) {
    return limits !== null && typeof limits === 'object'
        && (limits[MAX_MEMBERS_FIELD] !== undefined || limits[MAX_CONCURRENT_FIELD] !== undefined);
}

/**
 * Identify whether one loader fiber is the AgentTeams row this plugin configures.
 *
 * Three independent signals, mirroring `dsh-compact-model`'s proven guard: the
 * stable one is the entry's package name; the other two are diagnostics so a miss
 * can be explained from the log.
 *
 * @param fiber - the emitting fiber (`this` inside an `internal/config` listener).
 * @returns `{ isTarget, rowId?, packageName?, pluginName?, reasons }`.
 */
export function identifyAgentTeamsFiber(fiber) {
    if (fiber === null || typeof fiber !== 'object') return { isTarget: false, reasons: ['no-fiber'] };
    const reasons = [];
    const options = fiber.entry !== undefined && fiber.entry !== null ? fiber.entry.options : undefined;
    const packageName = options !== undefined && options !== null && typeof options.name === 'string'
        ? options.name
        : undefined;
    const rowId = options !== undefined && options !== null && typeof options.id === 'string' ? options.id : undefined;
    const callback = fiber.runtime !== undefined && fiber.runtime !== null ? fiber.runtime.callback : undefined;
    const pluginName = callback !== undefined && callback !== null && typeof callback === 'object'
        && typeof callback.name === 'string'
        ? callback.name
        : undefined;

    if (packageName === TARGET_PACKAGE) reasons.push('entry-name');
    if (pluginName === TARGET_PLUGIN_NAME) reasons.push('plugin-name');
    if (packageName === undefined && pluginName === undefined && rowId === TARGET_ROW_ID) reasons.push('row-id');

    return {
        isTarget: reasons.length > 0,
        rowId,
        packageName,
        pluginName,
        reasons,
    };
}

/**
 * The config one AgentTeams fiber should load with.
 *
 * `null` means "leave this fiber completely alone": no limit configured, or the
 * config already carries exactly these values (an unchanged config must not
 * trigger a fiber reload). Every other key of the incoming config is preserved —
 * a loader patch replaces `config` wholesale, and this injection must not drop
 * `stateDir`, `memberProvider`, `profiles`, …
 *
 * @param config - the config the loader was about to resolve (may be undefined).
 * @param limits - normalized limits.
 * @returns the replacement config, or `null` to leave it alone.
 */
export function injectLimits(config, limits) {
    if (!hasLimits(limits)) return null;
    const base = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
    const next = { ...base };
    let changed = false;
    for (const field of [MAX_MEMBERS_FIELD, MAX_CONCURRENT_FIELD]) {
        const value = limits[field];
        if (value === undefined || next[field] === value) continue;
        next[field] = value;
        changed = true;
    }
    return changed ? next : null;
}

/**
 * Whether a value looks like the patch's live limits bridge.
 * @param candidate - anything.
 * @returns true when it exposes `apply` and `read`.
 */
export function isLimitsBridge(candidate) {
    return candidate !== null && candidate !== undefined && typeof candidate === 'object'
        && typeof candidate.apply === 'function' && typeof candidate.read === 'function';
}

/**
 * Find the live limits bridge.
 *
 * The fiber handle is the primary route (`fiber.runtime.callback` is that
 * plugin's module namespace, exactly what `dsh-compact-model` reads its own name
 * from); the process-stable symbol the patch also publishes is the fallback, so a
 * changed fiber shape degrades to "still works" instead of "silently inert".
 *
 * @param fiber - the AgentTeams fiber handle seen in `internal/config`, if any.
 * @param globalObject - the process global object (injected so tests stay pure).
 * @returns `{ bridge, via }`, or undefined when no bridge exists (patch absent).
 */
export function findLimitsBridge(fiber, globalObject) {
    const fromFiber = fiber !== undefined && fiber !== null && fiber.runtime !== undefined && fiber.runtime !== null
        ? fiber.runtime.callback?.__limits
        : undefined;
    if (isLimitsBridge(fromFiber)) return { bridge: fromFiber, via: 'fiber' };
    if (globalObject !== undefined && globalObject !== null) {
        let fromGlobal;
        try {
            fromGlobal = globalObject[Symbol.for(LIMITS_SYMBOL_KEY)];
        }
        catch {
            fromGlobal = undefined;
        }
        if (isLimitsBridge(fromGlobal)) return { bridge: fromGlobal, via: 'global' };
    }
    return undefined;
}

/**
 * Apply live limits through the bridge.
 * @param bridge - a value accepted by {@link isLimitsBridge}.
 * @param limits - normalized limits.
 * @returns `{ applied }` (updated instance count) or `{ error }`.
 */
export function bridgeApply(bridge, limits) {
    if (!isLimitsBridge(bridge)) return { error: 'the limits bridge is unavailable' };
    if (!hasLimits(limits)) return { applied: 0 };
    const next = {};
    if (limits[MAX_MEMBERS_FIELD] !== undefined) next[MAX_MEMBERS_FIELD] = limits[MAX_MEMBERS_FIELD];
    if (limits[MAX_CONCURRENT_FIELD] !== undefined) next[MAX_CONCURRENT_FIELD] = limits[MAX_CONCURRENT_FIELD];
    try {
        const applied = bridge.apply(next);
        return { applied: typeof applied === 'number' && Number.isFinite(applied) ? applied : 0 };
    }
    catch (error) {
        return { error: String(error !== null && typeof error === 'object' && 'message' in error ? error.message : error) };
    }
}

/**
 * Human-readable limits, for logs.
 * @param limits - normalized limits.
 * @returns e.g. `成员上限 16、并发上限 2`, or `(未配置)`.
 */
export function formatLimits(limits) {
    if (!hasLimits(limits)) return '(未配置)';
    const parts = [];
    if (limits[MAX_MEMBERS_FIELD] !== undefined) parts.push(`成员上限 ${limits[MAX_MEMBERS_FIELD]}`);
    if (limits[MAX_CONCURRENT_FIELD] !== undefined) {
        parts.push(limits[MAX_CONCURRENT_FIELD] === 0 ? '并发不限' : `并发上限 ${limits[MAX_CONCURRENT_FIELD]}`);
    }
    return parts.join('、');
}

/**
 * The model-facing note, appended after AgentTeams' captain protocol.
 *
 * Empty string while nothing is configured, so the composed prompt is identical
 * to one without this plugin; once a limit is set the captain knows the ceiling
 * instead of discovering it through a rejected call.
 *
 * @param limits - normalized limits.
 * @returns the section text, or `''` so the section is dropped.
 */
export function promptSectionText(limits) {
    if (!hasLimits(limits)) return '';
    const parts = [];
    if (limits[MAX_MEMBERS_FIELD] !== undefined) parts.push(`单个团队最多 ${limits[MAX_MEMBERS_FIELD]} 名成员`);
    if (limits[MAX_CONCURRENT_FIELD] !== undefined) {
        parts.push(limits[MAX_CONCURRENT_FIELD] === 0
            ? '成员并发不限'
            : `单个团队最多 ${limits[MAX_CONCURRENT_FIELD]} 名成员同时干活`);
    }
    return `AgentTeams limits ("${SETTINGS_NS}" settings namespace): ${parts.join('；')}。`
        + '超过上限的建队/加人/唤醒请求会被拒绝或延后（唤醒消息会留在邮箱里等空位）。'
        + '需要更大规模时先向用户说明，让他在 设置 → 插件 → 插件配置 → 「Agent Teams 限制」里调高，不要反复重试同一个请求。';
}
