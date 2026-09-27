/**
 * Compaction-model override for DeepSeek Harness — host half.
 *
 * Problem this solves: `/compact` runs on the same provider/model as the
 * session's chat model. `@deepseek-ai/dsh-compaction-basic` CAN be pinned to a
 * different route (`summarizationProvider`/`summarizationModel`), but only
 * through its composition config — and its composition row lives inside each
 * agent preset, where `dsh-web-app` moved it on purpose:
 *
 *   * the host-plane `compaction-basic` row is `disabled: true`;
 *   * every preset re-declares it inside a `cordis:group` with
 *     `isolate: { compaction: true }`;
 *   * a preset file is a read-only input (the standing mount suppresses
 *     `write()`), a preset is a whole-roster snapshot with no patch semantics,
 *     and a second `compaction` provider in one realm throws rather than
 *     shadowing (`cordis/src/reflect.ts` `provide()`).
 *
 * So this plugin does not try to own the backend. It runs on the HOST plane —
 * the one place that can see every preset's rows — and rewrites the target
 * fiber's config through the global `internal/config` waterfall, the same seam
 * the loader itself uses for `!!js` interpolation. That waterfall fires on every
 * fiber (re)load in every realm, so a restart, a new preset generation and a new
 * session all pick the route up. Nothing is patched, no preset is edited, and
 * with no route configured the plugin returns the untouched config everywhere.
 *
 * Two application paths, both needed:
 *   1. `applyAtLoad` — before schema validation on every (re)load.
 *   2. `applyLive` — the loader skips `fiber.update` for an unchanged config, so
 *      an already-live engine keeps its old route until its row restarts.
 *      Reassigning the engine's resolved `config` field applies the route to
 *      those sessions with no restart (the engine re-reads `this.config` on
 *      every summarization).
 *
 * @module dsh-compact-model
 */
import z from '@deepseek-ai/schemastery';
import {
    EFFORT_FIELD,
    EFFORT_VALUES,
    MODEL_FIELD,
    NAME,
    PROVIDER_FIELD,
    SETTINGS_NS,
    decideInjection,
    hasRoute,
    identifyTarget,
    isEffortRejection,
    isEngine,
    liveConfig,
    resolveStreamOptions,
    routeOf,
    settingsPatch,
} from './logic.js';

export const name = NAME;

/** Required services: none. Everything else is reached through optional injection. */
export const inject = [];

/** Log prefix for every diagnostic this plugin writes. */
const LOG_TAG = 'dsh-compact-model';

/**
 * Write one diagnostic line.
 *
 * Deliberately defensive: the context handed to an `inject(['settings'], …)`
 * callback is a DIFFERENT context from the one `apply` received, and while both
 * are real cordis contexts, only the mount context is guaranteed to carry the
 * logger seat. Every diagnostic therefore goes through here, with `console` as
 * the fallback, so logging can never be the thing that breaks a settings change.
 *
 * @param ctx - whichever context is at hand.
 * @param level - `'info'` or `'warn'`.
 * @param line - the message.
 */
function log(ctx, level, line) {
    const prefix = level === 'warn' ? '[W] ' : '';
    try {
        const logger = ctx !== null && typeof ctx === 'object' ? ctx.logger : undefined;
        if (logger !== undefined && logger !== null && typeof logger[level] === 'function') {
            logger[level](line);
            return;
        }
    }
    catch {
        // Fall through to the console: a broken logger must not break the plugin.
    }
    const sink = level === 'warn' ? console.warn : console.log;
    sink(`${prefix}${LOG_TAG}: ${line}`);
}

/**
 * Settings schema.
 *
 * A plain schemastery object: schemastery has no `.validate()` builder (that is
 * zod), and the settings service takes the extra rule as its own `validate`
 * option, which {@link apply} passes. The schema is also the wire envelope the
 * browser card's scope validates against.
 */
export const SettingsSchema = z.object({
    [PROVIDER_FIELD]: volatileField(z.string().default('')),
    [MODEL_FIELD]: volatileField(z.string().default('')),
    [EFFORT_FIELD]: volatileField(z.string().default('')),
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
 * served namespace is the ENTRY id (`compact-model`), not the settings namespace.
 *
 * `volatileField` on every field is what makes that entry SERVED at all: the provider's
 * `describe()` drops any entry whose Config has no volatile field
 * (`volatileForm(schema) === undefined`), and a namespace that is not described is never
 * "served", so the browser card's `whileServed` gate never fires.
 *
 * Where the parsing happens with schemastery 3.18.4 a volatile field is a live REFERENCE
 * (an edit updates it in place, no remount); the 3.18.2 copy these plugins resolve
 * ignores the flag while parsing, so there the config is plain and an edit remounts the
 * entry. Both shapes are handled — {@link currentSettings} pulls the reference when there
 * is one, and the apply-time read covers the plain case.
 */
export const Config = SettingsSchema;

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
 * Detach the route out of a config that may hold live references.
 * @param config - the config handed to `apply`.
 * @returns `{ provider, model, reasoningEffort }`.
 */
function routeFromConfig(config) {
    return routeOf({
        [PROVIDER_FIELD]: liveValue(config?.[PROVIDER_FIELD], ''),
        [MODEL_FIELD]: liveValue(config?.[MODEL_FIELD], ''),
        [EFFORT_FIELD]: liveValue(config?.[EFFORT_FIELD], ''),
    });
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

/** Module-scope runtime state; one plugin instance owns one process. */
const state = {
    /** Resolved settings section; the stock "follow the session model" default. */
    settings: { [PROVIDER_FIELD]: '', [MODEL_FIELD]: '', [EFFORT_FIELD]: '' },
    /** `true` once an adapter rejected a configured effort, so the patch stops injecting it. */
    effortDisabled: false,
    /** Diagnostics, so a silent miss can be explained from the log. */
    stats: { seen: 0, matched: 0, injected: 0 },
    /** One-shot log flags to keep the log readable. */
    logged: { matched: false, injected: false },
};

/**
 * Live settings section source.
 *
 * On 0.1.7 the entry config's fields are `.volatile()` REFERENCES: a settings edit
 * updates them in place (no remount), and a reference exposes only `get()` — there is no
 * subscribe. The section is therefore PULLED at every use site through here. On 0.1.5
 * this stays null and {@link state}.settings (kept current by the namespace watcher) is
 * the source, unchanged.
 * @type {null | (() => object)}
 */
let settingsSource = null;

/**
 * The settings section to act on right now.
 * @returns `{ provider, model, reasoningEffort }` at the moment of the call.
 */
function currentSettings() {
    if (settingsSource !== null) {
        try {
            return settingsSource();
        }
        catch {
            // fall through to the last known section
        }
    }
    return state.settings;
}

/**
 * Read the current route out of {@link currentSettings}.
 * @returns `{ provider, model, reasoningEffort }`.
 */
function currentRoute() {
    return routeOf(currentSettings());
}

/**
 * Human-readable route for logs.
 * @returns the route, or the follow-the-session wording.
 */
function routeLabel() {
    const route = currentRoute();
    if (route.provider === '' || route.model === '') return 'follow the session model';
    return route.reasoningEffort === '' ? `${route.provider}/${route.model}` : `${route.provider}/${route.model} (effort ${route.reasoningEffort})`;
}

/**
 * Install the global `internal/config` waterfall listener.
 *
 * `global: true` bypasses context filtering, which is required because the
 * compaction rows sit behind per-preset isolate realms. The returned value is
 * what the loader resolves as this fiber's config.
 *
 * @param ctx - host plugin context.
 */
function installConfigWaterfall(ctx) {
    ctx.on('internal/config', function (config, next) {
        state.stats.seen += 1;
        const verdict = identifyTarget(this);
        if (!verdict.isTarget) return next();
        state.stats.matched += 1;
        if (!state.logged.matched) {
            state.logged.matched = true;
            log(ctx, 'info',
                `${LOG_TAG}: recognised the compaction backend via ${verdict.reasons.join('+')} `
                + `(row=${verdict.rowId ?? '?'} plugin=${verdict.pluginName ?? '?'} `
                + `package=${verdict.packageName ?? '?'})`,
            );
        }
        const injected = decideInjection({ config, isTarget: true, settings: currentSettings() });
        if (injected === null) return next();
        state.stats.injected += 1;
        if (!state.logged.injected) {
            state.logged.injected = true;
            log(ctx, 'info', `${LOG_TAG}: pinned the compaction route to ${routeLabel()} at load time`);
        }
        return injected;
    }, { global: true });
}

/**
 * Enumerate every live `compaction` service implementation, in any realm.
 *
 * `ctx.reflect.store` is public and keyed by isolate-realm symbols, so this is
 * the only way to reach a preset-isolated engine from the host plane — the
 * `compaction` instances each preset provides are stored under realm-private
 * symbols and are invisible to a normal service lookup.
 *
 * @param ctx - host plugin context.
 * @returns the live engine instances.
 */
function liveEngines(ctx) {
    const store = ctx.reflect?.store;
    if (store === null || typeof store !== 'object') return [];
    const engines = [];
    for (const key of Object.getOwnPropertySymbols(store)) {
        const impl = store[key];
        if (impl === null || impl === undefined || impl.name !== 'compaction') continue;
        if (isEngine(impl.value)) engines.push(impl.value);
    }
    return engines;
}

/**
 * Apply the configured route to every live engine that is not already on it.
 * @param ctx - host plugin context.
 * @param reason - short tag naming what triggered this pass (for the log).
 */
function applyLive(ctx, reason) {
    const settings = currentSettings();
    if (!hasRoute(settings)) return;
    const route = routeOf(settings);
    let applied = 0;
    for (const engine of liveEngines(ctx)) {
        try {
            const config = engine.config;
            if (config.summarizationProvider === route.provider && config.summarizationModel === route.model) {
                continue;
            }
            const next = liveConfig(config, settings);
            if (next === null) continue;
            engine.config = next;
            applied += 1;
        }
        catch (error) {
            log(ctx, 'warn', `${LOG_TAG}: live apply failed on one engine (${reason}): ${String(error?.message ?? error)}`);
        }
    }
    if (applied > 0) {
        log(ctx, 'info', 
            `${LOG_TAG}: live-applied ${routeLabel()} to ${applied} running compaction engine(s) after ${reason}`,
        );
    }
}

/**
 * Wrap the host LLM runtime so summarization requests carry the configured
 * reasoning effort.
 *
 * `summarizeWithLlm` builds its `GenerateOptions` without a `reasoningEffort`
 * field, so the request would otherwise take the adapter's connection default.
 * The wrapper is a pass-through for every other request: only
 * `purpose === 'compaction'` is touched. This is the plugin's one known coupling
 * to `LlmRuntime.stream`.
 *
 * @param ctx - the context of the `inject(['llm'])` scope, the only place where
 *   `ctx.llm` resolves without throwing.
 */
function installEffortPatch(ctx) {
    const llm = ctx.llm;
    if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
        log(ctx, 'warn', `${LOG_TAG}: no LLM runtime on this context; reasoning-effort override stays off`);
        return;
    }
    if (llm.__compactModelPatched === true) return;
    const original = llm.stream.bind(llm);
    llm.stream = (options) => {
        let patched;
        try {
            patched = resolveStreamOptions({
                options,
                effort: currentRoute().reasoningEffort,
                disabled: state.effortDisabled,
            });
        }
        catch {
            patched = options;
        }
        const stream = original(patched);
        if (patched === options || patched?.reasoningEffort === undefined) return stream;
        // If the adapter rejects the effort, disable the override for this process
        // so a later compaction still runs (on the model's default effort) instead
        // of failing the same way forever.
        const wrap = (iterator) => ({
            [Symbol.asyncIterator]() {
                const inner = iterator[Symbol.asyncIterator]();
                return {
                    async next() {
                        try {
                            return await inner.next();
                        }
                        catch (error) {
                            if (isEffortRejection(error) && state.effortDisabled !== true) {
                                state.effortDisabled = true;
                                log(ctx, 'warn', 
                                    `${LOG_TAG}: the compaction model rejected effort `
                                    + `"${patched.reasoningEffort}"; falling back to the model default for this `
                                    + `process (${String(error?.message ?? error)})`,
                                );
                            }
                            throw error;
                        }
                    },
                    async return(value) {
                        return typeof inner.return === 'function' ? inner.return(value) : { done: true, value };
                    },
                };
            },
        });
        return wrap(stream);
    };
    llm.__compactModelPatched = true;
    log(ctx, 'info', 
        `${LOG_TAG}: reasoning-effort override installed; legal values: ${EFFORT_VALUES.filter(Boolean).join(', ')}`,
    );
}

/**
 * Refresh from a resolved settings section and apply it live.
 * @param ctx - host plugin context.
 * @param next - the new resolved section.
 * @param prev - the previous resolved section.
 */
function onSettingsChanged(ctx, next, prev) {
    const plan = settingsPatch({ prev, next });
    state.settings = {
        [PROVIDER_FIELD]: plan.route.provider,
        [MODEL_FIELD]: plan.route.model,
        [EFFORT_FIELD]: plan.route.reasoningEffort,
    };
    if (plan.changedFields.length === 0) return;
    if (plan.effortChanged && plan.effort !== '') state.effortDisabled = false;
    if (plan.routeChanged) applyLive(ctx, `settings:${plan.changedFields.join('+')}`);
    log(ctx, 'info',
        `${LOG_TAG}: settings updated (${plan.changedFields.join('+')}); compaction route = ${routeLabel()}`,
    );
}

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 * @param config - the parsed entry config; on dsh 0.1.7 this IS the live settings
 *   section (see {@link Config}), on 0.1.5 it is only the composition entry config.
 */
export function apply(ctx, config) {
    installConfigWaterfall(ctx);

    // 0.1.7 line: the harness parses the profile entry's config against `Config`, fills
    // the defaults and hands it over as `apply`'s second argument. Every field there is
    // `.volatile()`, i.e. a live reference that an edit updates IN PLACE (no remount), so
    // the route is pulled through `currentSettings()` at every use site below. Reading it
    // here also covers a 0.1.7 composition whose `settings` seat never fires.
    const configured = routeFromConfig(config);
    state.settings = {
        [PROVIDER_FIELD]: configured.provider,
        [MODEL_FIELD]: configured.model,
        [EFFORT_FIELD]: configured.reasoningEffort,
    };
    const configIsLive = config?.[PROVIDER_FIELD] !== undefined && config?.[PROVIDER_FIELD] !== null
        && typeof config[PROVIDER_FIELD] === 'object' && typeof config[PROVIDER_FIELD].get === 'function';
    if (configIsLive) {
        settingsSource = () => routeFromConfig(config);
        // A volatile-only patch does not remount this entry, and the reference offers no
        // subscribe: re-apply when the loader reports a config reload, so an edit reaches
        // the running engines without waiting for a restart.
        ctx.on('app-boot/config-reload', () => {
            state.settings = routeFromConfig(config);
            if (hasRoute(state.settings)) applyLive(ctx, 'config-reload');
        });
    }
    if (hasRoute(state.settings)) applyLive(ctx, 'mount');

    // The LLM runtime is a SIBLING loader row (`@deepseek-ai/dsh-llm`), not an
    // ancestor service, so `ctx.llm` cannot be read off the mount context: cordis
    // only falls back to an ancestor's store, and a bare read throws
    // `cannot get property "llm" without inject` — which takes the whole plugin
    // tree down at boot. The seat is therefore waited for, exactly like `settings`.
    ctx.inject(['llm'], (llmCtx) => {
        installEffortPatch(llmCtx);
    });

    // Settings are optional: with no provider mounted the plugin keeps the stock
    // "follow the session model" behavior and registers no namespace (so the
    // browser card is not dispatched either).
    //
    // NO `validate` HOOK, DELIBERATELY. The pair rule ("provider and model are
    // both set, or neither") used to ride the service's validate hook. That hook
    // runs on EVERY write and every resolve, which made a half-written pair
    // unrepresentable -- including the perfectly ordinary intermediate state
    // "provider chosen, model not chosen yet". The card's attempt to write that
    // state was rejected as `settings/rejected`, and the browser scope handles a
    // rejected write by SILENTLY re-reading the mirror: no error, no log entry,
    // no persistence, and the field snapped back to its old value. The user saw
    // "I picked a provider and nothing happened", with no trace anywhere.
    //
    // The rule is enforced where it actually matters instead: `hasRoute()`
    // (logic.js) is the single predicate for "a route is configured", and
    // `decideInjection` returns null for anything less than a complete pair, so
    // the compaction backend can never receive a half-pair no matter what the
    // document holds. The settings layer therefore only needs to hold strings.
    ctx.inject(['settings'], (settingsCtx) => {
        const service = settingsCtx.settings;
        // 0.1.5 only. 0.1.7 removed `register` and hands the parsed entry config to
        // `apply` instead (a config edit remounts the entry), so there is no watcher to
        // install there. Reaching for `register` anyway is exactly what used to throw
        // `TypeError: settingsCtx.settings.register is not a function` into cordis'
        // fiber executor — swallowed there, so the plugin silently ran on defaults and
        // the settings namespace was never served.
        if (service === undefined || service === null || typeof service.register !== 'function') return;
        let scope;
        try {
            scope = service.register(SETTINGS_NS, SettingsSchema, {
                base: { [PROVIDER_FIELD]: '', [MODEL_FIELD]: '', [EFFORT_FIELD]: '' },
            });
        }
        catch (error) {
            log(ctx, 'warn', `${LOG_TAG}: settings namespace "${SETTINGS_NS}" registration failed: ${String(error)}`);
            return;
        }
        try {
            const resolved = routeOf(scope.get());
            state.settings = {
                [PROVIDER_FIELD]: resolved.provider,
                [MODEL_FIELD]: resolved.model,
                [EFFORT_FIELD]: resolved.reasoningEffort,
            };
            // The watcher fires with the SERVICE's context, which is not the one
            // `apply` received: it reaches `ctx.settings` but carries no guarantee of
            // the logger or `reflect` seats. Every action below therefore runs against
            // the mount context, which owns both.
            scope.watch((next, prev) => {
                onSettingsChanged(ctx, next, prev);
            });
            // A route configured before this process started is already in the base
            // layer, so it must be applied to any engine that is live right now.
            if (hasRoute(state.settings)) applyLive(ctx, 'mount');
            log(ctx, 'info', `${LOG_TAG}: mounted; compaction route = ${routeLabel()}`);
        }
        catch (error) {
            log(ctx, 'warn', `${LOG_TAG}: reading the "${SETTINGS_NS}" settings section failed: ${String(error)}`);
        }
    });
}

/** Test/diagnostic surface. Not part of the plugin contract. */
export const __internals = {
    state,
    SettingsSchema,
    LOG_TAG,
    EFFORT_VALUES,
    log,
    currentRoute,
    routeLabel,
    liveEngines,
    applyLive,
    installEffortPatch,
    onSettingsChanged,
    installConfigWaterfall,
};
