/**
 * Retry-all gateway errors for DeepSeek Harness — host half.
 *
 * Why this plugin exists: the stock `@deepseek-ai/dsh-llm-retry` applies a
 * per-provider policy that retries only five transient codes (RATE_LIMIT,
 * SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE) at most five times — QUOTA,
 * AUTH and everything else fail the turn immediately. And compaction's
 * summarization call is a DIRECT `ctx.llm.stream()` that never reaches the
 * `agent/request-error` waterfall at all, so a gateway error during compact
 * fails the compaction and stops the task.
 *
 * Two seams, one policy (see logic.js):
 *
 *   1. `agent/request-error`, PREPENDED so this plugin decides before the
 *      stock one. Every failure code except ABORTED (user cancellation) and
 *      CONTEXT_WINDOW_EXCEEDED (owned by compaction-basic's overflow
 *      recovery) is retried up to `maxRetries` times with a linear
 *      5s/10s/15s/... schedule hard-capped at 5 minutes. The durable
 *      `llm/retry` + `llm/retry-started` session events are written in the
 *      stock shape, so the chat UI's model-retry card keeps working.
 *      Whatever this plugin passes through (`next()`) reaches the stock
 *      llm-retry unchanged — including when our setting is 0, which therefore
 *      disables ONLY this plugin (a confirmed product decision).
 *
 *   2. The shared `LlmRuntime` instance's `stream()` method, wrapped the same
 *      way `dsh-compact-model` wraps it (`ctx.inject(['llm'], …)`, instance
 *      property, idempotence flag). Only DIRECT calls are wrapped, and they
 *      are recognized by SHAPE, not by module identity: a direct caller tags
 *      its request with `purpose` (compaction → "compaction", session title →
 *      "session-title"), while agent-loop requests never carry one. The
 *      obvious alternative — `isAgentLoopRequest` from `@deepseek-ai/dsh-llm` —
 *      is a process-local WeakSet identity test, and under DSH Desktop the
 *      host loads dsh-llm from inside `resources/app.asar` while a
 *      link-installed plugin resolves its own physical copy: two module
 *      instances, two WeakSets, the check is ALWAYS false in production
 *      (verified with an Electron probe against the app's own runtime). That
 *      misclassification buffered every main-chat stream; the `purpose` tag
 *      has no such hazard and needs no dsh-llm import at all. Prepared calls
 *      (`preparedCall.stream`) never touch the instance method anyway. The
 *      wrapper buffers each attempt and re-opens the stream from the top on
 *      failure, which is the only correct retry point: cordis waterfall
 *      `next()` is shift-on-call, so re-calling it from inside a listener
 *      would silently skip downstream listeners.
 *
 * Settings: namespace `dsh-llm-retry-all`, one field `maxRetries`
 * (default 10000, 0 = off). Hot-reloaded; the value is read at every failure
 * decision, so a change applies to the next failure immediately.
 *
 * Retry counters are in-memory per (session, turn, step): an in-flight wait
 * cannot survive a process restart anyway (the turn itself is gone), so the
 * durable projection the stock plugin maintains would buy nothing here.
 *
 * @module dsh-llm-retry-all
 */
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import {
    cancellableDelay,
    createRetryEngine,
    DEFAULT_MAX_RETRIES,
    MAX_RETRIES_FIELD,
    NAME,
    normalizeMaxRetries,
    SETTINGS_NS,
} from './logic.js';

export const name = NAME;

/**
 * The stock llm-retry plugin injects `agents` to receive agent-scoped events
 * from the host plane; mirroring that seat keeps the mount surface identical.
 * `llm` and `settings` are sibling seats waited for dynamically (a bare
 * `ctx.llm` read on the mount context would throw `cannot get property …
 * without inject` and take the plugin tree down at boot).
 */
export const inject = ['agents'];

/** Log prefix for every diagnostic this plugin writes. */
const LOG_TAG = NAME;

/**
 * Settings schema: one integer, 0 disables this plugin. Normalization
 * (floor/clamp) happens on every read in `normalizeMaxRetries`, so the schema
 * itself stays a plain carrier — a rejected write must never be the reason a
 * number cannot be stored.
 *
 * `volatileField` is what makes the 0.1.7 settings provider SERVE this entry at all: its
 * `describe()` drops every entry whose Config has no volatile field
 * (`volatileForm(schema) === undefined`), and a namespace that is not described is never
 * "served", so the client card's `whileServed` gate never fires.
 */
export const SettingsSchema = z.object({
    [MAX_RETRIES_FIELD]: volatileField(z.number().default(DEFAULT_MAX_RETRIES)),
});

/**
 * Declarative config for the dsh 0.1.7 line.
 *
 * 0.1.7-rc.2 removed `settings.register` and replaced it with this contract: the harness
 * parses a profile entry's `config` against the exported `Config`, fills the schema
 * defaults, and hands the result to `apply(ctx, config)` as the second argument. The
 * served namespace is the ENTRY id (`llm-retry-all`), not the settings namespace.
 *
 * Reused verbatim from {@link SettingsSchema}: one integer, the same field the browser
 * card edits.
 */
export const Config = SettingsSchema;

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
 * Read a config field, whichever shape the running dsh delivered.
 *
 * On 0.1.7 a `.volatile()` field arrives as a live reference — cosmokit's `Volatile` has
 * `get()` and nothing else (no subscribe), so the only way to observe an edit is to pull
 * at USE time. Older lines deliver plain values.
 * @param field - the config field.
 * @param fallback - value to answer when the field is absent or unreadable.
 * @returns the current plain value.
 */
export function liveValue(field, fallback) {
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

/**
 * Write one diagnostic line. Defensive in the same way dsh-compact-model is:
 * the context handed to an `inject([...])` callback is a different context
 * from the one `apply` received, so logging falls back to `console` rather
 * than ever breaking the plugin.
 */
function log(ctx, level, line) {
    try {
        const logger = ctx !== null && typeof ctx === 'object' ? ctx.logger : undefined;
        if (logger !== undefined && logger !== null && typeof logger[level] === 'function') {
            logger[level](line);
            return;
        }
    }
    catch {
        // fall through to console
    }
    const sink = level === 'warn' ? console.warn : console.log;
    sink(`${level === 'warn' ? '[W] ' : ''}${LOG_TAG}: ${line}`);
}

/**
 * Fuse the caller's signal with the plugin lifetime: cancellation of EITHER
 * must end a pending wait (user stop / session abort, or plugin dispose on
 * shutdown).
 */
function fusedSignal(lifetime, signal) {
    if (signal === undefined || signal === null) return lifetime.signal;
    return AbortSignal.any([signal, lifetime.signal]);
}

/**
 * A direct `ctx.llm.stream()` call carries a non-empty `purpose` tag
 * (compaction, session-title, ...); agent-loop requests never do. This is the
 * ONLY classifier this plugin uses — see the module header for why
 * `isAgentLoopRequest` cannot work from a link-installed plugin.
 * @param options - the request handed to `llm.stream`.
 * @returns whether the call is a direct (purpose-tagged) one worth wrapping.
 */
function isDirectCall(options) {
    if (options === null || typeof options !== 'object') return false;
    return typeof options.purpose === 'string' && options.purpose !== '';
}

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 * @param config - the parsed entry config; on dsh 0.1.7 this IS the live settings
 *   section (see {@link Config}), on 0.1.5 it is only the composition entry config.
 */
export function apply(ctx, config) {
    /**
     * Fallback settings value: used on a line that hands over plain config values only
     * until the legacy namespace answers, and on a 0.1.7 deployment whose `settings` seat
     * never fires. The legacy watcher below keeps it current on 0.1.5.
     */
    const settings = { maxRetries: normalizeMaxRetries(liveValue(config?.[MAX_RETRIES_FIELD], DEFAULT_MAX_RETRIES)) };

    /**
     * The live retry cap.
     *
     * 0.1.7 delivers a `.volatile()` field as a live reference and a settings edit does
     * NOT remount the entry — the reference is the only observation surface, so the value
     * is pulled here at every failure decision (the ref has `get()` and no subscribe).
     * On 0.1.5 the namespace registration below owns the value instead.
     * @returns the current retry cap.
     */
    const currentMaxRetries = () => {
        const fromConfig = liveValue(config?.[MAX_RETRIES_FIELD], undefined);
        if (fromConfig !== undefined) return normalizeMaxRetries(fromConfig);
        return settings.maxRetries;
    };

    const lifetime = new AbortController();
    /** Restore the llm.stream patch on dispose; undefined while unpatched. */
    let restoreStream;

    const engine = createRetryEngine({
        getMaxRetries: currentMaxRetries,
        wait: (delayMs, signal) => cancellableDelay(delayMs, fusedSignal(lifetime, signal)),
        log: (level, line) => log(ctx, level, line),
        shouldPassThrough: (options) => !isDirectCall(options),
        newRetryId: () => randomUUID(),
    });

    // Seam 1: agent-loop requests. Prepended so the stock llm-retry only sees
    // what this plugin deliberately passes through.
    const disposeError = ctx.on('agent/request-error', (payload, next) => {
        if (lifetime.signal.aborted) return next();
        return engine.onRequestError(payload, next);
    }, { prepend: true });

    // A finished turn ends every failure episode of that agent: the next turn
    // must start counting from zero.
    const disposeStatus = ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return;
        try {
            engine.clearAgent(agent.session.id);
        }
        catch {
            // A counter leak is bounded by the map; a throw here is not.
        }
    });

    // Seam 2: direct ctx.llm.stream() calls (compaction, session title, ...).
    ctx.inject(['llm'], (llmCtx) => {
        const llm = llmCtx.llm;
        if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
            log(ctx, 'warn', `${LOG_TAG}: no LLM runtime on this context; direct-call retry stays off`);
            return;
        }
        if (llm.__llmRetryAllPatched === true) return;
        const descriptor = Object.getOwnPropertyDescriptor(llm, 'stream');
        const original = llm.stream.bind(llm);
        const wrapper = (options) => {
            if (lifetime.signal.aborted) return original(options);
            return engine.wrapDirectStream(options, original);
        };
        llm.stream = wrapper;
        llm.__llmRetryAllPatched = true;
        restoreStream = () => {
            // Only undo a property this mount still owns: a later wrapper may
            // already have stacked on top, and restoring then would clobber it.
            if (Object.getOwnPropertyDescriptor(llm, 'stream')?.value !== wrapper) return;
            if (descriptor === undefined) Reflect.deleteProperty(llm, 'stream');
            else Object.defineProperty(llm, 'stream', descriptor);
            Reflect.deleteProperty(llm, '__llmRetryAllPatched');
            restoreStream = undefined;
        };
        log(ctx, 'info', `${LOG_TAG}: direct-call retry installed on the shared LLM runtime`);
    });

    // Settings are optional: without the service the plugin keeps the value the entry
    // config carries (DEFAULT_MAX_RETRIES when it carries none).
    ctx.inject(['settings'], (settingsCtx) => {
        const service = settingsCtx.settings;
        // 0.1.5 only. 0.1.7 removed `register` and hands the parsed entry config to
        // `apply` instead (a config edit remounts the entry), so there is no scope and no
        // watcher to install there. Reaching for `register` anyway is exactly what used to
        // throw `TypeError: settings.register is not a function` into cordis' fiber
        // executor — swallowed there, so the plugin silently ran on its default.
        if (service === undefined || service === null || typeof service.register !== 'function') return;
        let scope;
        try {
            scope = service.register(SETTINGS_NS, SettingsSchema, {
                base: { [MAX_RETRIES_FIELD]: DEFAULT_MAX_RETRIES },
            });
        }
        catch (error) {
            log(ctx, 'warn', `${LOG_TAG}: settings namespace "${SETTINGS_NS}" registration failed: ${String(error)}`);
            return;
        }
        settings.maxRetries = normalizeMaxRetries(scope.get()?.[MAX_RETRIES_FIELD]);
        scope.watch((next) => {
            settings.maxRetries = normalizeMaxRetries(next?.[MAX_RETRIES_FIELD]);
            log(ctx, 'info', `${LOG_TAG}: maxRetries = ${settings.maxRetries}`
                + (settings.maxRetries === 0 ? ' (plugin disabled; stock retry policy still applies)' : ''));
        });
        log(ctx, 'info', `${LOG_TAG}: mounted; maxRetries = ${settings.maxRetries}, `
            + `backoff = linear +5s steps capped at 300s`);
    });

    ctx.effect(() => () => {
        restoreStream?.();
        disposeError();
        disposeStatus();
        lifetime.abort(new Error(`${LOG_TAG} disposed`));
        engine.dispose();
    }, `${LOG_TAG}: restore llm.stream, abort pending waits and release listeners`);
}

/** Test/diagnostic surface. Not part of the plugin contract. */
export const __internals = {
    LOG_TAG,
    SettingsSchema,
    fusedSignal,
};
