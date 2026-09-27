/**
 * AgentTeams limits - host half.
 *
 * A host-plane plugin with no tools of its own. It registers one user-settings
 * namespace (`agent-teams-limits`, rendered as a card by the client half under
 * Settings → Plugins → Plugin configuration) and feeds the two values it holds
 * into `@nanmicoder/dsh-agent-teams`:
 *
 *   1. **Load time**: the loader's global `internal/config` waterfall lets a
 *      host-plane plugin rewrite any fiber's config — the same seam
 *      `dsh-compact-model` uses. Every (re)load of the AgentTeams row, including
 *      a restart, therefore gets `maxMembers` (the roster cap AgentTeams itself
 *      enforces) and `maxConcurrentMembers` (the per-team concurrency cap the
 *      local patch adds) without touching that package's configuration or files.
 *   2. **Immediately**: the local patch publishes a live limits bridge
 *      (`__limits`) on the plugin's module namespace and on a process-stable
 *      symbol. A settings edit calls it, which mutates the mounted instance's
 *      resolved config — both caps are read at use time, so the new numbers apply
 *      without a restart.
 *
 * With nothing configured the plugin contributes **nothing**: no injection point
 * matches, the prompt section is empty (and dropped), and no bridge call happens.
 * A missing bridge (patch not applied, or the package was updated) degrades to
 * "takes effect at the next start" with one warning — never a silent no-op.
 *
 * Installation (bundle): `dsh plugin --profile <name> add link:<this directory>`
 * (or `node scripts/install.mjs --profile <name>`), then restart DSH.
 *
 * @module dsh-agent-teams-limits
 */
import z from '@deepseek-ai/schemastery';
import {
    LOG_TAG,
    MAX_CONCURRENT_FIELD,
    MAX_MEMBERS_FIELD,
    NAME,
    PROMPT_SECTION_ORDER,
    SETTINGS_NS,
    bridgeApply,
    findLimitsBridge,
    formatLimits,
    hasLimits,
    identifyAgentTeamsFiber,
    injectLimits,
    normalizeLimits,
    promptSectionText,
} from './logic.js';

export const name = NAME;

/**
 * Required services: the system-prompt registry only (the optional note about the
 * configured limits). `settings` is taken through a lazy `ctx.inject` because a
 * composition without a settings provider keeps the plugin inert instead of
 * failing to mount — and a declared service that nobody provides pends the fiber.
 */
export const inject = ['systemPrompt'];

/**
 * Mark one schema field as volatile, on both schemastery generations in play.
 *
 * The harness that serves 0.1.7 settings ships schemastery 3.18.4, where
 * `.volatile()` exists; the copy these plugins resolve is 3.18.2, which has no
 * builder for it. Both read the same `schema.meta.volatile` flag, and the settings
 * provider's `describe()` only serves an entry whose Config carries it — so
 * setting the flag directly is equivalent whichever copy is resolved.
 * @param schema - a schemastery field schema.
 * @returns the same schema, marked volatile.
 */
function volatileField(schema) {
    if (typeof schema.volatile === 'function') return schema.volatile();
    if (schema.meta !== undefined && schema.meta !== null) schema.meta.volatile = true;
    return schema;
}

/**
 * The settings schema: two OPTIONAL numbers.
 *
 * Deliberately no `.default()`: a section that was never written must resolve to
 * an empty object, because "no value" is a distinct state here — it means
 * "contribute nothing", and it is what keeps an unconfigured install
 * byte-identical to one without this plugin. Absent fields are the card's
 * "留空 = 用 AgentTeams 自己的默认".
 */
export const SettingsSchema = z.object({
    [MAX_MEMBERS_FIELD]: volatileField(z.number()),
    [MAX_CONCURRENT_FIELD]: volatileField(z.number()),
});

/**
 * Declarative config for the dsh 0.1.7 line.
 *
 * 0.1.7-rc.2 removed `settings.register` and hands the parsed entry config to
 * `apply(ctx, config)` instead, where a `.volatile()` field is a live reference.
 * Reused verbatim from {@link SettingsSchema}: the same two fields the card edits.
 */
export const Config = SettingsSchema;

/**
 * Read a config field, whichever shape the running dsh delivered.
 * @param field - the config field.
 * @param fallback - value to answer when the field is absent or unreadable.
 * @returns the current plain value.
 */
function liveValue(field, fallback) {
    if (field === undefined || field === null) return fallback;
    if (typeof field === 'object' && typeof field.get === 'function' && typeof field.set !== 'function') {
        try {
            const value = field.get();
            return value === undefined ? fallback : value;
        }
        catch {
            return fallback;
        }
    }
    return field;
}

/**
 * The two fields of an `apply()` config, whichever line delivered it.
 * @param config - the composition entry config.
 * @returns `{ maxMembers?, maxConcurrentMembers? }` as raw values.
 */
function entrySection(config) {
    if (config === null || typeof config !== 'object') return {};
    return {
        [MAX_MEMBERS_FIELD]: liveValue(config[MAX_MEMBERS_FIELD], undefined),
        [MAX_CONCURRENT_FIELD]: liveValue(config[MAX_CONCURRENT_FIELD], undefined),
    };
}

/**
 * Whether an `apply()` config carries LIVE (volatile) references.
 * @param config - the composition entry config.
 * @returns true when an edit updates the config in place, with no remount.
 */
function configIsLive(config) {
    const field = config === null || typeof config !== 'object' ? undefined : config[MAX_MEMBERS_FIELD];
    return field !== undefined && field !== null && typeof field === 'object' && typeof field.get === 'function';
}

/**
 * Wire the plugin onto a host context.
 * @param ctx - host plugin context (`systemPrompt`; `settings` optional).
 * @param config - composition entry config (0.1.7 line: the live settings section).
 * @param deps - `{ z }`, injected so the wiring stays testable.
 * @returns the live reader used by tests and diagnostics.
 */
export function install(ctx, config, deps) {
    if (ctx === null || typeof ctx !== 'object') {
        throw new TypeError(`${LOG_TAG}: a plugin context is required`);
    }
    // The schema is built by the caller (index.js) so this module stays free of a
    // second copy of schemastery; `deps.z` is only a fallback for direct callers.
    const schema = deps?.schema;
    const state = {
        limits: normalizeLimits(entrySection(config)),
        fiber: undefined,
        bridgeVia: undefined,
        /** Pending bounded retry that waits for the AgentTeams row to publish the bridge. */
        timer: undefined,
        logged: { matched: false, injected: false, bridge: false },
    };

    /**
     * Write one diagnostic; never the thing that breaks a mount.
     * @param level - `'info'` or `'warn'`.
     * @param line - the message.
     */
    const log = (level, line) => {
        try {
            const logger = ctx.logger;
            if (logger !== undefined && logger !== null && typeof logger[level] === 'function') {
                logger[level](line);
                return;
            }
        }
        catch {
            // fall through to the console
        }
        const sink = level === 'warn' ? console.warn : console.log;
        sink(`[${LOG_TAG}] ${line}`);
    };

    /**
     * Warn once that the local patch is missing.
     *
     * Deliberately separate from {@link applyLive}: our own mount can run before
     * the AgentTeams row has loaded, when the bridge legitimately does not exist
     * yet, so only a settled attempt (or an explicit settings edit) may report it.
     */
    const warnNoBridge = () => {
        if (state.logged.bridge) return;
        state.logged.bridge = true;
        log('warn', `${LOG_TAG}: this AgentTeams build has no live limits bridge — run `
            + '"scripts/patch-agent-teams-limits.mjs --apply" and restart DSH. Until then the member cap '
            + 'applies at the next start and the concurrency cap is inert.');
    };

    /**
     * Apply the current limits to every mounted AgentTeams instance.
     * @param reason - short tag naming what triggered this pass (for the log).
     * @param quiet - skip the missing-bridge warning (used while the row may still
     *   be loading; {@link applyWithRetry} reports only once it settles).
     * @returns how many mounted instances were updated.
     */
    const applyLive = (reason, quiet = false) => {
        if (!hasLimits(state.limits)) return 0;
        const found = findLimitsBridge(state.fiber, globalThis);
        if (found === undefined) {
            if (!quiet) warnNoBridge();
            return 0;
        }
        state.bridgeVia = found.via;
        const result = bridgeApply(found.bridge, state.limits);
        if (result.error !== undefined) {
            log('warn', `${LOG_TAG}: live apply through the ${found.via} bridge failed: ${result.error}`);
            return 0;
        }
        log('info', `${LOG_TAG}: live-applied ${formatLimits(state.limits)} to ${result.applied} mounted `
            + `AgentTeams instance(s) (${reason}; bridge via ${found.via})`);
        return result.applied;
    };

    /** Retry budget for a bridge that the AgentTeams row publishes on its own mount. */
    const retryDelayMs = Number.isFinite(deps?.retryDelayMs) ? Math.max(0, deps.retryDelayMs) : 500;
    const retryAttempts = Number.isInteger(deps?.retryAttempts) && deps.retryAttempts > 0 ? deps.retryAttempts : 24;

    /**
     * Apply the limits, retrying while the AgentTeams row may still be mounting.
     *
     * Plugin rows activate in parallel: our mount can run before OR after the
     * AgentTeams row, and only that row's `apply()` publishes the bridge (and only
     * a load that happened after our listener was registered gets the config
     * injection). Retrying for a bounded window therefore covers both orders, and
     * the missing-bridge warning is emitted only once the window is spent — never
     * as a false alarm during a normal boot.
     *
     * @param reason - short tag naming what triggered this pass.
     * @param attempt - retry counter (0 on the first try).
     */
    const applyWithRetry = (reason, attempt = 0) => {
        if (!hasLimits(state.limits)) return;
        if (applyLive(attempt === 0 ? reason : `${reason} retry ${attempt}`, true) > 0) return;
        if (attempt >= retryAttempts) {
            warnNoBridge();
            return;
        }
        state.timer = setTimeout(() => {
            state.timer = undefined;
            applyWithRetry(reason, attempt + 1);
        }, retryDelayMs);
        if (typeof state.timer?.unref === 'function') state.timer.unref();
    };

    /** Drop a pending retry and start a fresh one. */
    const restartRetry = (reason) => {
        if (state.timer !== undefined) {
            clearTimeout(state.timer);
            state.timer = undefined;
        }
        applyWithRetry(reason);
    };

    // 1. Load-time injection: the seam the loader itself uses for `!!js`
    // interpolation. `global: true` bypasses context filtering, which is required
    // because the AgentTeams row may sit in another realm. The listener must stay
    // synchronous and must never throw: a rejected config takes the fiber down.
    if (typeof ctx.on === 'function') {
        ctx.on('internal/config', function (incoming, next) {
            try {
                const verdict = identifyAgentTeamsFiber(this);
                if (!verdict.isTarget) return next();
                state.fiber = this;
                if (!state.logged.matched) {
                    state.logged.matched = true;
                    log('info', `${LOG_TAG}: recognised the AgentTeams row via ${verdict.reasons.join('+')} `
                        + `(row=${verdict.rowId ?? '?'} package=${verdict.packageName ?? '?'})`);
                }
                // The row is (re)loading right now: once its own apply() returns, the
                // bridge exists, so make sure the mounted instance carries the limits
                // even when this row loaded before our plugin did.
                restartRetry('row load');
                const injected = injectLimits(incoming, state.limits);
                if (injected === null) return next();
                if (!state.logged.injected) {
                    state.logged.injected = true;
                    log('info', `${LOG_TAG}: injected ${formatLimits(state.limits)} into the AgentTeams row at load time`);
                }
                return injected;
            }
            catch (error) {
                log('warn', `${LOG_TAG}: config injection failed; leaving the row untouched: ${String(error)}`);
                return next();
            }
        }, { global: true });
    }

    // 2. Settings: the durable values the card edits.
    //
    // 0.1.5 registers the namespace and watches it; 0.1.7 removed `register` and
    // hands the parsed entry config to `apply()` (a volatile reference, pulled
    // below at every use site). Reaching for `register` on 0.1.7 would throw into
    // the fiber executor — swallowed there, so the namespace would silently never
    // be served and the card would never render.
    const configLive = configIsLive(config);
    if (configLive) {
        ctx.on('app-boot/config-reload', () => {
            state.limits = normalizeLimits(entrySection(config));
            applyLive('config-reload');
        });
    }
    if (typeof ctx.inject === 'function' && schema !== undefined) {
        ctx.inject(['settings'], (settingsCtx) => {
            const service = settingsCtx.settings;
            if (service === undefined || service === null || typeof service.register !== 'function') return;
            let scope;
            try {
                scope = service.register(SETTINGS_NS, schema);
            }
            catch (error) {
                log('warn', `${LOG_TAG}: settings namespace "${SETTINGS_NS}" registration failed: ${String(error)}`);
                return;
            }
            try {
                state.limits = normalizeLimits(scope.get());
            }
            catch (error) {
                log('warn', `${LOG_TAG}: reading the "${SETTINGS_NS}" settings section failed: ${String(error)}`);
                return;
            }
            try {
                const dispose = scope.watch((next) => {
                    state.limits = normalizeLimits(next);
                    log('info', `${LOG_TAG}: settings updated; limits = ${formatLimits(state.limits)}`);
                    applyLive('settings update');
                });
                if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
                    ctx.effect(() => dispose, `${LOG_TAG}: settings watcher`);
                }
            }
            catch (error) {
                log('warn', `${LOG_TAG}: watching the "${SETTINGS_NS}" settings section failed: ${String(error)}`);
            }
            // A limit configured before this process started is already in the base
            // layer, so make sure any instance that is live right now carries it —
            // retrying for a bounded window, because the AgentTeams row may not have
            // mounted yet (its own apply() is what publishes the bridge).
            restartRetry('mount');
        });
    }
    else if (typeof ctx.inject !== 'function') {
        log('warn', `${LOG_TAG}: this host has no lazy injection; the settings card cannot be registered`);
    }

    // The retry timer must not outlive the plugin.
    if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
            if (state.timer !== undefined) {
                clearTimeout(state.timer);
                state.timer = undefined;
            }
        }, `${LOG_TAG}: retry timer`);
    }

    // 3. Model-facing note: empty while nothing is configured, so the composed
    // prompt is byte-identical to one without this plugin.
    if (typeof ctx.systemPrompt?.section === 'function') {
        ctx.effect(() => ctx.systemPrompt.section({
            name: `${NAME}:limits`,
            order: PROMPT_SECTION_ORDER,
            text: () => promptSectionText(state.limits),
        }), `${LOG_TAG}: prompt section`);
    }
    else {
        log('warn', `${LOG_TAG}: no system-prompt registry on this context; the captain keeps discovering the `
            + 'limits through rejected calls instead of a prompt note');
    }

    return {
        limits: () => state.limits,
        applyLive,
        fiber: () => state.fiber,
        bridgeVia: () => state.bridgeVia,
        state,
    };
}

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 * @param config - composition entry config (0.1.7 line: the live settings section).
 */
export function apply(ctx, config) {
    install(ctx, config, { z, schema: SettingsSchema });
}

/** Test/diagnostic surface. Not part of the plugin contract. */
export const __internals = {
    SettingsSchema,
    LOG_TAG,
    install,
    entrySection,
    configIsLive,
    volatileField,
};
