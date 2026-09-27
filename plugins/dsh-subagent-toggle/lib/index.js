/**
 * Subagent capability toggle for DeepSeek Harness — host half.
 *
 * A host-plane plugin with no tools of its own. It owns one settings
 * namespace (`dsh-subagent-toggle`, a single `enabled` boolean, default on)
 * and registers ONE tool guard. While the setting says `enabled: false`, the
 * guard denies every tool call that can create or wake a subagent, and the
 * denial text the model reads redirects it to Agent Teams.
 *
 * Design decisions (all deliberate, see README.md):
 *
 *   - The gate is `ctx.tools.guard` ONLY. `ctx.subagents.start` /
 *     `startContinuable` are NOT wrapped: AgentTeams spawns its members
 *     through them (label prefix `agent-teams:`) and is the very replacement
 *     the denial text recommends, and the Mnemon memory system delegates its
 *     internal maintenance through the same service. Gating that layer would
 *     kill both.
 *   - The policy is re-read from the live settings scope on EVERY guard call,
 *     so flipping the switch in Settings takes effect on the next tool call —
 *     no restart, no new session.
 *   - The settings namespace has NO `validate` hook. A host-side validate
 *     rejection is silently swallowed by the client scope controller
 *     (`recover()` re-reads and resolves), which once made a sibling plugin's
 *     writes disappear without a trace. Validation belongs in the schema.
 *   - Only an explicit `enabled: false` switches the capability off; a
 *     missing or unreadable settings service leaves the plugin inert.
 *
 * Installation (bundle): add `link:<this directory>` to the profile's
 * `dependencies` and this package's name to `dsh.profile.bundles`, then
 * restart DSH. `scripts/install.mjs` does both. See README.md.
 *
 * @module dsh-subagent-toggle
 */
import z from '@deepseek-ai/schemastery';
import {
    DEFAULT_EXTRA_BLOCKED,
    ENABLED_FIELD,
    NAME,
    SETTINGS_NS,
    denialText,
    guardDecision,
    isBlockedToolName,
    isSubagentToolName,
    parsePolicy,
    resolvePluginConfig,
} from './logic.js';

export const name = NAME;

/**
 * Required services. `tools` is mandatory: without the guard hook the plugin
 * can do nothing, and mounting anyway would pretend the switch works.
 * `settings` is reached through OPTIONAL injection (`ctx.inject`): a
 * composition without a settings provider keeps the plugin inert rather than
 * failing to mount.
 */
export const inject = ['tools'];

export {
    DEFAULT_EXTRA_BLOCKED,
    ENABLED_FIELD,
    NAME,
    SETTINGS_NS,
    denialText,
    guardDecision,
    isBlockedToolName,
    isSubagentToolName,
    parsePolicy,
    resolvePluginConfig,
};

/**
 * Settings schema: one boolean, default on. No `validate` hook — see the
 * module header for why that silence is dangerous.
 *
 * `volatileField` is what makes the 0.1.7 settings provider SERVE this entry at all: its
 * `describe()` drops every entry whose Config has no volatile field
 * (`volatileForm(schema) === undefined`), a namespace that is not described is never
 * "served", and the client card's `whileServed` gate then never fires.
 */
const SettingsSchema = z.object({
    enabled: volatileField(z.boolean().default(true)),
});

/**
 * Mark one schema field as volatile, on both schemastery generations in play.
 *
 * The harness that serves 0.1.7 settings ships schemastery 3.18.4, where `.volatile()`
 * exists; the copy these plugins resolve is 3.18.2, which has no builder for it. Both
 * read the same `schema.meta.volatile` flag (3.18.4's `.volatile()` is literally
 * `extra('volatile', true)`), and the settings provider's `describe()` only serves an
 * entry whose Config carries that flag — so setting it directly is equivalent and works
 * whichever copy is resolved.
 * @param schema - a schemastery field schema.
 * @returns the same schema, marked volatile.
 */
function volatileField(schema) {
    if (typeof schema.volatile === 'function') return schema.volatile();
    // A stand-in schema (test doubles) may carry no meta bag; there the marker is skipped.
    if (schema.meta !== undefined && schema.meta !== null) schema.meta.volatile = true;
    return schema;
}

/**
 * Declarative config for the dsh 0.1.7 line.
 *
 * 0.1.7-rc.2 removed `settings.register` and replaced it with this contract: the harness
 * parses a profile entry's `config` against the exported `Config`, fills the schema
 * defaults, and hands the result to `apply(ctx, config)` as the second argument. The
 * served namespace is the ENTRY id (`subagent-toggle`), not the settings namespace.
 *
 * Where the parsing happens with schemastery 3.18.4 the volatile field arrives as a live
 * REFERENCE (an edit then updates it in place, no remount); the 3.18.2 copy our plugins
 * resolve ignores the flag while parsing, so there the config is plain and an edit
 * remounts the entry. Both shapes are handled: {@link install} pulls the field when it is
 * a reference and otherwise re-reads it at apply time.
 *
 * `extraBlockedTools` is declared here, non-volatile, because the parser only keeps the
 * fields this schema knows: it is the patch layer's own knob, edited by rebuilding the
 * entry, not by the card.
 */
export const Config = z.object({
    [ENABLED_FIELD]: volatileField(z.boolean().default(true)),
    extraBlockedTools: z.array(z.string()).default([...DEFAULT_EXTRA_BLOCKED]),
});

/**
 * Read a config field, whichever shape the running dsh delivered.
 *
 * On 0.1.7 a `.volatile()` field arrives as a live reference — cosmokit's `Volatile` has
 * `get()` and nothing else (no subscribe), so the only way to observe an edit is to pull
 * at USE time. Older lines deliver plain values.
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
 * Detach the entry config into plain values, dropping absent keys so the resolver's own
 * defaults apply.
 * @param config - the config handed to `apply`.
 * @returns `{ enabled?, extraBlockedTools? }`.
 */
function plainConfig(config) {
    const out = {};
    for (const key of [ENABLED_FIELD, 'extraBlockedTools']) {
        const value = liveValue(config?.[key], undefined);
        if (value !== undefined) out[key] = value;
    }
    return out;
}

/**
 * Read one service that may not be registered yet.
 *
 * Never throws: the runtime's service proxy rejects an undeclared access, and a missing
 * service is a supported state here (a composition without a settings provider).
 * @param ctx - host plugin context.
 * @param name - service name.
 * @returns the service, or undefined.
 */
function readService(ctx, name) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return undefined;
    try {
        return ctx.get(name);
    }
    catch {
        return undefined;
    }
}

/** Log prefix for every diagnostic this plugin writes. */
const LOG_TAG = NAME;

/** Tool runtimes this plugin instance has already guarded (double-mount guard). */
const guardedRuntimes = new WeakSet();

/**
 * Wire the plugin onto a host context.
 * @param ctx - host plugin context (`tools`; `settings` optional).
 * @param config - composition entry config (`{ enabled, extraBlockedTools }`); on dsh
 *   0.1.7 this IS the live settings section (see {@link Config}).
 * @returns the live policy reader used by tests and diagnostics.
 */
export function install(ctx, config) {
    if (ctx === null || typeof ctx !== 'object') {
        throw new TypeError(`${NAME}: a plugin context is required`);
    }
    const resolved = resolvePluginConfig(plainConfig(config));
    // 0.1.7 serves a `settings` service WITHOUT `register`: on that line the entry config
    // IS the settings section, so `enabled` is the live switch itself — treating it as a
    // mount gate would drop the guard and silently ALLOW every subagent tool the user just
    // switched off. A volatile field never remounts the entry either, so the gate below is
    // only a guard against an entry composed with `enabled: false` from the start; the LIVE
    // value is pulled on every guard call. The gate therefore only applies to the legacy
    // line, where the entry config is a separate switch and a runtime `settings` service
    // can be reached.
    const settingsService = readService(ctx, 'settings');
    const modernSettings = settingsService !== undefined && settingsService !== null
        && typeof settingsService.register !== 'function';
    if (!modernSettings && resolved.enabled !== true) {
        ctx.logger?.info?.(`${LOG_TAG}: disabled by configuration; the subagent capability switch is not mounted`);
        return { policy: () => ({ enabled: true }) };
    }
    const tools = ctx.tools;
    if (tools === null || typeof tools !== 'object' || typeof tools.guard !== 'function') {
        throw new Error(`${NAME}: \`ctx.tools.guard\` is unavailable; mount @deepseek-ai/dsh-tools first`);
    }

    /**
     * Live policy reader.
     *
     * On 0.1.7 the entry config's `enabled` is a volatile REFERENCE: editing it updates
     * the reference in place (no remount) and the ref exposes only `get()`, so the switch
     * is pulled here — and this reader is called on EVERY guard call, which is what keeps
     * the flip immediate.
     *
     * On the legacy line it starts at the entry config's `enabled` (normally true) and is
     * replaced by the settings binding below as soon as the service registers the
     * namespace.
     */
    const liveEnabled = config?.[ENABLED_FIELD];
    const configIsLive = liveEnabled !== undefined && liveEnabled !== null
        && typeof liveEnabled === 'object' && typeof liveEnabled.get === 'function';
    let readPolicy = configIsLive
        ? () => ({ enabled: liveValue(liveEnabled, true) !== false })
        : () => ({ enabled: resolved.enabled === true });
    if (typeof ctx.inject === 'function') {
        ctx.inject(['settings'], (settingsCtx) => {
            const service = settingsCtx.settings;
            // 0.1.5 only. 0.1.7 removed `register` and hands the parsed entry config to
            // `apply` instead (a config edit remounts the entry), so there is no watcher
            // to install there — reaching for `register` anyway is what used to throw
            // `TypeError: settings.register is not a function` into cordis' fiber
            // executor and leave the plugin on its defaults forever.
            if (service === undefined || service === null || typeof service.register !== 'function') return;
            const scope = service.register(SETTINGS_NS, SettingsSchema, {
                base: { [ENABLED_FIELD]: true },
            });
            const read = () => {
                try {
                    return parsePolicy(scope.get());
                }
                catch (error) {
                    ctx.logger?.warn?.(`${LOG_TAG}: reading the "${SETTINGS_NS}" settings section failed: ${String(error)}`);
                    return { enabled: true };
                }
            };
            settingsCtx.effect(() => {
                readPolicy = read;
                return () => {
                    readPolicy = () => ({ enabled: true });
                };
            }, `${LOG_TAG}: settings binding`);
        });
    }
    else {
        ctx.logger?.warn?.(`${LOG_TAG}: this context has no optional injection; the switch stays inert`);
    }

    /**
     * One warn per off-period, so a model retry loop does not flood the log.
     * The flag resets when the switch is on, so the next off-period logs again.
     */
    let denialLogged = false;
    const guard = (execution) => {
        const policy = readPolicy();
        if (policy.enabled !== false) {
            denialLogged = false;
            return undefined;
        }
        const reason = guardDecision(execution, policy, resolved.extraBlockedTools);
        if (reason !== undefined && !denialLogged) {
            denialLogged = true;
            ctx.logger?.warn?.(`${LOG_TAG}: subagent capability is OFF — denied \`${String(execution?.name)}\` (settings → 插件 → 插件配置 → Subagent 开关)`);
        }
        return reason;
    };

    if (!guardedRuntimes.has(tools)) {
        ctx.effect(() => {
            guardedRuntimes.add(tools);
            const dispose = tools.guard(guard);
            return () => {
                if (typeof dispose === 'function') dispose();
                guardedRuntimes.delete(tools);
            };
        }, `${LOG_TAG}: capability guard`);
    }

    return { policy: () => readPolicy(), guard };
}

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 * @param config - composition entry config.
 */
export function apply(ctx, config) {
    install(ctx, config);
}
