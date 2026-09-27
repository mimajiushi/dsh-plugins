/**
 * Compaction-model override — dependency-free decision logic.
 *
 * This module owns every rule the plugin applies; `index.js` only supplies the
 * two harness modules (`@deepseek-ai/schemastery` for the settings schema and
 * `@deepseek-ai/dsh-compaction-basic` for the engine class it recognises) plus
 * the plugin metadata the Loader reads. Keeping the rules here is what lets the
 * whole decision surface be unit-tested without a DSH runtime.
 *
 * Background the rules encode — all of it read out of the shipped bundles:
 *
 *   * `@deepseek-ai/dsh-compaction-basic` resolves its summarization target as
 *     `config.summarizationProvider/Model ?? latest routed request ?? agent.options`.
 *     A NON-EMPTY configured pair therefore means "compact with X no matter what
 *     the chat model is" — no `modelPolicies` entry is needed for that, and no
 *     wildcard exists.
 *   * The pair must be complete before it can be USED: `hasRoute` is the single
 *     predicate and `decideInjection` contributes nothing until both halves are
 *     present (the backend's own `validateSummarizationPair` would reject a
 *     half-pair, but a half-pair never reaches the config). Where this rule is
 *     deliberately NOT enforced: there is no settings `validate` hook. A validate
 *     hook runs on every write and every resolve, so it made the ordinary
 *     intermediate state "provider chosen, model not chosen yet" impossible to
 *     store -- and a rejected write is INVISIBLE from the browser, because the
 *     settings scope answers one by silently re-reading the mirror (no error, no
 *     log entry, no persistence). That is what made the provider dropdown in the
 *     settings card look broken while the host showed no trace of any write.
 *   * `resolveConfig` rejects unknown keys outright, so the injected object must
 *     carry only the keys that schema accepts. We add the pair and preserve
 *     whatever was already there, deleting nothing else.
 *   * `summarizeWithLlm` builds its `GenerateOptions` with provider, model,
 *     messages, tools, maxTokens, sessionId and `purpose: "compaction"` — it
 *     passes NO `reasoningEffort`, so the request falls back to the adapter's
 *     connection defaults. Effort is therefore the one field that cannot ride
 *     the config; see {@link resolveStreamOptions}.
 *
 * @module dsh-compact-model/logic
 */

/** Cordis plugin name (matches the bundle patch row id). */
export const NAME = 'compact-model';

/** User-settings namespace (`settings.yaml` section key). Also the card's slot key. */
export const SETTINGS_NS = 'dsh-compact-model';

/** Settings field: provider of the compaction route. Empty string = follow the session model. */
export const PROVIDER_FIELD = 'provider';

/** Settings field: model of the compaction route. Empty string = follow the session model. */
export const MODEL_FIELD = 'model';

/** Settings field: reasoning effort for the summarization call. Empty string = the model's default. */
export const EFFORT_FIELD = 'reasoningEffort';

/**
 * Legal reasoning-effort ids. `'off'`, `'low'`, `'high'` and `'max'` are exactly
 * what the DeepSeek adapter accepts (`reasoningEffort()` in
 * `@deepseek-ai/dsh-llm-deepseek` throws `UNSUPPORTED_REASONING_EFFORT` for
 * anything else); `''` means "leave the field unset".
 */
export const EFFORT_VALUES = ['', 'off', 'low', 'high', 'max'];

/** Loader row id of the compaction backend this plugin configures. */
export const TARGET_ROW_ID = 'compaction-basic';

/** Package name of the compaction backend this plugin configures. */
export const TARGET_PACKAGE = '@deepseek-ai/dsh-compaction-basic';

/** Config keys `dsh-compaction-basic` accepts; anything else makes `resolveConfig` throw. */
export const COMPACTION_CONFIG_KEYS = [
    'thresholdRatio',
    'retainRatio',
    'retainTokens',
    'summarizationProvider',
    'summarizationModel',
    'maxTokens',
    'compactionRetries',
    'maxOverflowRetries',
    'modelPolicies',
    'auto',
];

/**
 * Normalise one settings field to a trimmed string.
 * @param value - raw value from the resolved settings section.
 * @returns the string, or `''` for anything that is not a non-empty string.
 */
export function asText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Whether a compaction route is configured. The pair rule lives here so the
 * schema, the card and the host agree on one predicate.
 * @param settings - resolved settings section (or anything else).
 * @returns `true` only when provider AND model are both non-empty.
 */
export function hasRoute(settings) {
    if (settings === null || typeof settings !== 'object') return false;
    return asText(settings[PROVIDER_FIELD]) !== '' && asText(settings[MODEL_FIELD]) !== '';
}


/**
 * The persisted settings section for one compaction route.
 * @param settings - resolved settings section.
 * @returns `{ provider, model, reasoningEffort }` with empty strings for "unset".
 */
export function routeOf(settings) {
    if (settings === null || typeof settings !== 'object') {
        return { provider: '', model: '', reasoningEffort: '' };
    }
    return {
        provider: asText(settings[PROVIDER_FIELD]),
        model: asText(settings[MODEL_FIELD]),
        reasoningEffort: asText(settings[EFFORT_FIELD]),
    };
}

/**
 * Identify whether one loader fiber is the compaction backend this plugin
 * configures. Three independent signals; the first is the stable one, the
 * others are diagnostics so a miss can be explained from the log.
 *
 * @param fiber - the emitting fiber (`this` inside an `internal/config` listener).
 * @returns `{ isTarget, rowId?, packageName?, pluginName?, reasons }`.
 */
export function identifyTarget(fiber) {
    const reasons = [];
    if (fiber === null || typeof fiber !== 'object') return { isTarget: false, reasons: ['no-fiber'] };

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
    if (pluginName === TARGET_ROW_ID) reasons.push('plugin-name');
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
 * Decide the config one compaction-backend fiber should load with.
 *
 * `null` means "leave this fiber completely alone" — the caller returns the
 * untouched `next()` value, so an unconfigured plugin contributes exactly
 * nothing to any fiber, and unrelated fibers are never rewritten.
 *
 * @param input - `{ config, isTarget, settings }`.
 * @param input.config - the config the loader was about to resolve (may be `undefined`).
 * @param input.isTarget - {@link identifyTarget}'s verdict for this fiber.
 * @param input.settings - resolved settings section.
 * @returns the replacement config, or `null` to leave it alone.
 */
export function decideInjection(input) {
    if (input === null || typeof input !== 'object') return null;
    if (input.isTarget !== true) return null;
    // "Follow the session model" = contribute nothing at all. Writing an empty
    // pair would work too, but injecting nothing keeps the stock path bit-for-bit.
    if (!hasRoute(input.settings)) return null;

    const route = routeOf(input.settings);
    const base = input.config === null || typeof input.config !== 'object' || Array.isArray(input.config)
        ? {}
        : input.config;

    return {
        ...base,
        summarizationProvider: route.provider,
        summarizationModel: route.model,
    };
}

/**
 * Add the user's reasoning effort to a summarization request.
 *
 * The backend never passes `reasoningEffort`, so this is the only way to control
 * it; the field is injected for `purpose === 'compaction'` requests only, and
 * every other request on the same runtime keeps its own options untouched.
 *
 * @param input - `{ options, effort, disabled }`.
 * @param input.options - the `GenerateOptions` the caller was about to pass.
 * @param input.effort - configured effort id ('' = unset).
 * @param input.disabled - `true` once the adapter rejected the effort for this process.
 * @returns `options` itself when nothing applies, else a copy carrying `reasoningEffort`.
 */
export function resolveStreamOptions(input) {
    if (input === null || typeof input !== 'object') return undefined;
    const options = input.options;
    if (options === null || typeof options !== 'object') return options;
    if (input.disabled === true) return options;
    const effort = asText(input.effort);
    if (effort === '') return options;
    if (effort !== 'off' && !EFFORT_VALUES.includes(effort)) return options;
    if (options.purpose !== 'compaction') return options;
    return { ...options, reasoningEffort: effort };
}

/**
 * Whether the adapter rejected a reasoning effort (so the patch must stop trying).
 * @param error - anything thrown by the stream.
 * @returns `true` for an unrecognised-effort failure.
 */
export function isEffortRejection(error) {
    if (error === null || typeof error !== 'object') return false;
    if (error.code === 'UNSUPPORTED_REASONING_EFFORT') return true;
    const message = typeof error.message === 'string' ? error.message : '';
    return /reasoning effort/i.test(message);
}

/**
 * Diff two resolved settings sections into a live-apply plan.
 * @param input - `{ prev, next }`.
 * @returns `{ routeChanged, effortChanged, route, effort, changedFields }`.
 */
export function settingsPatch(input) {
    const prev = routeOf(input !== null && typeof input === 'object' ? input.prev : undefined);
    const next = routeOf(input !== null && typeof input === 'object' ? input.next : undefined);
    const changedFields = [];
    if (prev.provider !== next.provider) changedFields.push(PROVIDER_FIELD);
    if (prev.model !== next.model) changedFields.push(MODEL_FIELD);
    if (prev.reasoningEffort !== next.reasoningEffort) changedFields.push(EFFORT_FIELD);
    return {
        routeChanged: prev.provider !== next.provider || prev.model !== next.model,
        effortChanged: prev.reasoningEffort !== next.reasoningEffort,
        route: next,
        effort: next.reasoningEffort,
        changedFields,
    };
}

/**
 * Merge a route into an already-resolved engine config for live application.
 * @param config - the engine's current resolved config.
 * @param settings - resolved settings section.
 * @returns a frozen replacement config, or `null` when there is nothing to apply.
 */
export function liveConfig(config, settings) {
    if (config === null || typeof config !== 'object') return null;
    if (!hasRoute(settings)) return null;
    const route = routeOf(settings);
    return Object.freeze({
        ...config,
        summarizationProvider: route.provider,
        summarizationModel: route.model,
    });
}

/**
 * Whether an engine instance exposes the state this plugin manipulates.
 * @param engine - candidate `compaction` service implementation.
 * @returns `true` for an object with real methods and configuration.
 */
export function isEngine(engine) {
    if (engine === null || typeof engine !== 'object') return false;
    if (typeof engine.summarize !== 'function') return false;
    if (typeof engine.compactNow !== 'function') return false;
    return engine.config !== null && typeof engine.config === 'object';
}
