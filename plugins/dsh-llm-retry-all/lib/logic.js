/**
 * Retry policy core for dsh-llm-retry-all — pure, ctx-free and unit-testable.
 *
 * Two shapes live here:
 *   1. the numeric policy (linear +5s backoff capped at 5 minutes, provider
 *      Retry-After honoured but hard-capped, failure-code gate);
 *   2. the two retry engines: one decision function for the agent loop's
 *      `agent/request-error` waterfall, one buffering stream wrapper for
 *      direct `ctx.llm.stream()` calls (compaction, session title, ...).
 *
 * Everything time- or identity-related is injected (`wait`, `newRetryId`,
 * `isDirectCall`) so tests never touch real timers.
 *
 * @module dsh-llm-retry-all/logic
 */

export const NAME = 'dsh-llm-retry-all';
export const SETTINGS_NS = 'dsh-llm-retry-all';
export const MAX_RETRIES_FIELD = 'maxRetries';
export const DEFAULT_MAX_RETRIES = 10000;

/** First retry waits 5s, then 10s, 15s, ... — linear +5s steps. */
export const STEP_DELAY_MS = 5000;
/** Hard ceiling for every wait, including provider Retry-After requests. */
export const MAX_DELAY_MS = 300000;

/** Caller cancellation — never retried. */
export const ABORTED_CODE = 'ABORTED';
/**
 * Context overflow — never retried here. `compaction-basic` owns this code on
 * the `agent/request-error` chain (it compacts, then retries), and a blind
 * retry of an oversized request would fail forever.
 */
export const OVERFLOW_CODE = 'CONTEXT_WINDOW_EXCEEDED';

/** policyKey written into `llm/retry` session events for attribution. */
export const POLICY_KEY = NAME;

/**
 * Normalize one configured max-retries value.
 * @param value - raw settings value.
 * @returns a non-negative integer; 0 disables the plugin.
 */
export function normalizeMaxRetries(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RETRIES;
    const n = Math.floor(value);
    return n < 0 ? 0 : n;
}

/**
 * Backoff for one retry: `retry * 5s`, raised to the provider's Retry-After
 * when that is larger, hard-capped at 5 minutes either way.
 * @param retry - 1-based retry ordinal.
 * @param providerRetryAfterMs - provider-requested wait, when carried.
 * @returns milliseconds to wait before this retry.
 */
export function computeDelayMs(retry, providerRetryAfterMs) {
    const linear = Math.min(Math.max(Math.trunc(retry), 1) * STEP_DELAY_MS, MAX_DELAY_MS);
    const provider = typeof providerRetryAfterMs === 'number'
        && Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0
        ? providerRetryAfterMs
        : 0;
    return Math.min(Math.max(linear, provider), MAX_DELAY_MS);
}

/**
 * The only two codes this plugin refuses: caller cancellation and context
 * overflow. EVERYTHING else — 429, quota, auth, 5xx, timeouts, transport
 * (network down), empty responses, unknown codes — is retried.
 * @param code - normalized harness failure code.
 */
export function isRetryableCode(code) {
    return code !== ABORTED_CODE && code !== OVERFLOW_CODE;
}

/**
 * Counter identity for one failing agent-loop request: the session, turn and
 * step. A successful attempt ends the step, so the next failure episode starts
 * from zero naturally.
 */
export function episodeKey(sessionId, turn, step) {
    return `${sessionId}:${turn}:${step}`;
}

/**
 * Wait `delayMs`, resolving `true` when the full delay elapsed and `false`
 * when the signal aborted first. An already-aborted signal resolves `false`
 * synchronously.
 */
export function cancellableDelay(delayMs, signal) {
    if (signal !== undefined && signal !== null && signal.aborted) return Promise.resolve(false);
    if (signal === undefined || signal === null) {
        return new Promise((resolve) => setTimeout(() => resolve(true), delayMs));
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        }, delayMs);
        function onAbort() {
            clearTimeout(timer);
            resolve(false);
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Whether one stream chunk is the terminal adapter-failure marker. Adapter
 * errors never throw out of `LlmRuntime.adapterStream`; they arrive as
 * `{ type: 'finish', reason: { kind: 'error', failure } }`.
 */
export function terminalErrorChunk(chunk) {
    if (chunk === null || typeof chunk !== 'object') return undefined;
    if (chunk.type !== 'finish') return undefined;
    const reason = chunk.reason;
    if (reason === null || typeof reason !== 'object' || reason.kind !== 'error') return undefined;
    const failure = reason.failure;
    return failure !== null && typeof failure === 'object' ? failure : undefined;
}

/**
 * Buffering retry wrapper for ONE direct `ctx.llm.stream()` call.
 *
 * The consumer sees nothing until an attempt completes: chunks are buffered,
 * and only a fully successful attempt is released downstream. On a terminal
 * error chunk the buffered attempt is discarded and a brand-new
 * `openAttempt()` is issued — re-entering the complete `llm/stream` waterfall,
 * which a repeated `next()` inside the waterfall itself could not do (cordis
 * `next()` is shift-on-call). Buffering is safe for duplication precisely
 * because partial content is never released; the price is that direct calls
 * (compaction summaries, session titles) render only at completion, which
 * matches how they are consumed today.
 *
 * Cancellation/early-close contract: `wait` is expected to resolve `false`
 * when the caller's signal aborts; the buffered error is then released so the
 * consumer observes the same failure it would without this plugin. A consumer
 * that closes the iterator early sets the closed flag, so no extra attempt is
 * opened after the current wait settles.
 *
 * @param openAttempt - starts one fresh stream attempt.
 * @param controls - `{ decide(failure, retry) -> delayMs|undefined, wait(delayMs) -> Promise<boolean>, onScheduled?({retry, delayMs, failure}) }`.
 * @returns an AsyncIterable of stream chunks.
 */
export function retryStream(openAttempt, controls) {
    return {
        [Symbol.asyncIterator]() {
            let closed = false;
            const generator = run();
            return {
                next: (...args) => generator.next(...args),
                throw: (...args) => (typeof generator.throw === 'function'
                    ? generator.throw(...args)
                    : Promise.reject(args[0])),
                return: (value) => {
                    closed = true;
                    return typeof generator.return === 'function'
                        ? generator.return(value)
                        : Promise.resolve({ done: true, value });
                },
            };
            async function* run() {
                let retry = 0;
                for (;;) {
                    const buffered = [];
                    let failure;
                    for await (const chunk of openAttempt()) {
                        buffered.push(chunk);
                        const found = terminalErrorChunk(chunk);
                        if (found !== undefined) {
                            failure = found;
                            break;
                        }
                    }
                    if (failure === undefined) {
                        yield* buffered;
                        return;
                    }
                    const delayMs = controls.decide(failure, retry + 1);
                    if (delayMs === undefined) {
                        yield* buffered;
                        return;
                    }
                    retry += 1;
                    controls.onScheduled?.({ retry, delayMs, failure });
                    const waited = await controls.wait(delayMs);
                    if (!waited || closed) {
                        yield* buffered;
                        return;
                    }
                }
            }
        },
    };
}

/**
 * Create the shared retry engine behind both host seams.
 *
 * @param deps - `getMaxRetries()` (0 = disabled), `wait(delayMs, signal)`,
 *   `log(level, line)`, `shouldPassThrough(options)`, `newRetryId()`.
 * @returns `{ onRequestError, wrapDirectStream, clearAgent, dispose, counters }`.
 */
export function createRetryEngine(deps) {
    const { getMaxRetries, wait, log, shouldPassThrough, newRetryId } = deps;
    /** @type {Map<string, { retry: number, retryId: string }>} */
    const counters = new Map();

    /**
     * `agent/request-error` waterfall listener. Returns `{ kind: 'retry' }`
     * after the scheduled wait, or delegates via `next()` when this plugin is
     * disabled, the failure is non-retryable, the cap is reached, or the turn
     * was cancelled while waiting (undefined return = let the error surface).
     */
    async function onRequestError(payload, next) {
        const { agent, turn, step, provider, failure, signal } = payload;
        const maxRetries = getMaxRetries();
        if (maxRetries === 0) return next();
        if (signal !== undefined && signal !== null && signal.aborted) return next();
        const code = failure !== null && typeof failure === 'object' ? failure.code : undefined;
        if (!isRetryableCode(code)) return next();
        const key = episodeKey(agent.session.id, turn, step);
        const entry = counters.get(key) ?? { retry: 0, retryId: newRetryId() };
        if (entry.retry >= maxRetries) return next();
        const retry = entry.retry + 1;
        const retryAfter = failure !== null && typeof failure === 'object'
            ? failure.providerRetryAfterMs
            : undefined;
        const delayMs = computeDelayMs(retry, retryAfter);
        counters.set(key, { retry, retryId: entry.retryId });
        // Same event shape the stock llm-retry plugin writes: the chat UI's
        // model-retry card keys off retryId/turn/step/retry/delayMs/failure.
        agent.session.append('llm/retry', {
            retryId: entry.retryId,
            turn,
            step,
            provider,
            mode: 'normal',
            policyKey: POLICY_KEY,
            retry,
            maxRetries,
            delayMs,
            failure,
        });
        log('info', `${NAME}: ${provider} request failed (${String(code)}); `
            + `retry ${retry}/${maxRetries} in ${Math.round(delayMs / 1000)}s`);
        const waited = await wait(delayMs, signal);
        if (!waited) return undefined;
        agent.session.append('llm/retry-started', {
            retryId: entry.retryId,
            turn,
            step,
            retry,
        });
        return { kind: 'retry' };
    }

    /**
     * Wrap one direct `ctx.llm.stream()` call with buffering retries.
     * Requests the caller classified as pass-through (agent-loop traffic,
     * which carries no `purpose` tag) and a disabled plugin are untouched.
     */
    function wrapDirectStream(options, original) {
        if (getMaxRetries() === 0) return original(options);
        if (shouldPassThrough(options)) return original(options);
        const signal = options !== null && typeof options === 'object' ? options.signal : undefined;
        return retryStream(() => original(options), {
            decide: (failure, retry) => {
                const maxRetries = getMaxRetries();
                if (maxRetries === 0) return undefined;
                if (signal !== undefined && signal !== null && signal.aborted) return undefined;
                if (!isRetryableCode(failure !== null && typeof failure === 'object' ? failure.code : undefined)) {
                    return undefined;
                }
                if (retry > maxRetries) return undefined;
                return computeDelayMs(retry, failure.providerRetryAfterMs);
            },
            wait: (delayMs) => wait(delayMs, signal),
            onScheduled: ({ retry, delayMs, failure }) => {
                const route = options !== null && typeof options === 'object'
                    ? `${options.provider}/${options.model}`
                    : '?/?';
                const purpose = options !== null && typeof options === 'object' && typeof options.purpose === 'string'
                    ? options.purpose
                    : 'unspecified';
                log('info', `${NAME}: direct llm.stream (${route}, purpose=${purpose}) failed `
                    + `(${String(failure.code)}); retry ${retry}/${getMaxRetries()} in ${Math.round(delayMs / 1000)}s`);
            },
        });
    }

    /** Drop every counter belonging to one session (its agent went idle). */
    function clearAgent(sessionId) {
        const prefix = `${sessionId}:`;
        for (const key of [...counters.keys()]) {
            if (key.startsWith(prefix)) counters.delete(key);
        }
    }

    function dispose() {
        counters.clear();
    }

    return { onRequestError, wrapDirectStream, clearAgent, dispose, counters };
}
