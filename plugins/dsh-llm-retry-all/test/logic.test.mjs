/**
 * Unit tests for dsh-llm-retry-all/lib/logic.js — the numeric policy, the
 * failure gate, and the buffering stream wrapper. No real timers: `wait` is
 * injected everywhere it matters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ABORTED_CODE,
    cancellableDelay,
    computeDelayMs,
    createRetryEngine,
    DEFAULT_MAX_RETRIES,
    episodeKey,
    isRetryableCode,
    MAX_DELAY_MS,
    normalizeMaxRetries,
    OVERFLOW_CODE,
    POLICY_KEY,
    retryStream,
    terminalErrorChunk,
} from '../lib/logic.js';

const errorChunk = (code, extra = {}) => ({
    type: 'finish',
    reason: { kind: 'error', failure: { message: `boom (${code})`, code, ...extra } },
});
const textChunk = (text) => ({ type: 'text', delta: text });
const stopChunk = () => ({ type: 'finish', reason: { kind: 'stop' } });

async function* fakeStream(chunks) {
    for (const chunk of chunks) yield chunk;
}

async function collect(iterable) {
    const out = [];
    for await (const chunk of iterable) out.push(chunk);
    return out;
}

test('normalizeMaxRetries: floors, clamps at 0, defaults on garbage', () => {
    assert.equal(normalizeMaxRetries(10000), 10000);
    assert.equal(normalizeMaxRetries(0), 0);
    assert.equal(normalizeMaxRetries(3.9), 3);
    assert.equal(normalizeMaxRetries(-5), 0);
    assert.equal(normalizeMaxRetries(Number.NaN), DEFAULT_MAX_RETRIES);
    assert.equal(normalizeMaxRetries(undefined), DEFAULT_MAX_RETRIES);
    assert.equal(normalizeMaxRetries('12'), DEFAULT_MAX_RETRIES);
    assert.equal(normalizeMaxRetries(Infinity), DEFAULT_MAX_RETRIES);
});

test('computeDelayMs: linear +5s steps capped at 5 minutes', () => {
    assert.equal(computeDelayMs(1), 5000);
    assert.equal(computeDelayMs(2), 10000);
    assert.equal(computeDelayMs(3), 15000);
    assert.equal(computeDelayMs(60), 300000);
    assert.equal(computeDelayMs(61), 300000);
    assert.equal(computeDelayMs(10000), MAX_DELAY_MS);
    // defensive: retry 0 / negatives behave like the first retry
    assert.equal(computeDelayMs(0), 5000);
    assert.equal(computeDelayMs(-3), 5000);
});

test('computeDelayMs: provider Retry-After raises but never breaks the 5-minute cap', () => {
    // provider asks less than the schedule -> schedule wins
    assert.equal(computeDelayMs(3, 2000), 15000);
    // provider asks more than the schedule -> provider wins
    assert.equal(computeDelayMs(1, 60000), 60000);
    // provider asks more than the cap -> hard-capped (confirmed decision)
    assert.equal(computeDelayMs(1, 600000), 300000);
    // garbage Retry-After is ignored
    assert.equal(computeDelayMs(2, Number.NaN), 10000);
    assert.equal(computeDelayMs(2, -1), 10000);
});

test('isRetryableCode: everything except ABORTED and CONTEXT_WINDOW_EXCEEDED', () => {
    assert.equal(isRetryableCode(ABORTED_CODE), false);
    assert.equal(isRetryableCode(OVERFLOW_CODE), false);
    for (const code of ['RATE_LIMIT', 'QUOTA', 'AUTH', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'UNKNOWN', undefined]) {
        assert.equal(isRetryableCode(code), true, `expected ${String(code)} to be retried`);
    }
});

test('episodeKey: session:turn:step', () => {
    assert.equal(episodeKey('s1', 2, 3), 's1:2:3');
});

test('cancellableDelay: resolves true after the delay, false on abort', async () => {
    const controller = new AbortController();
    const pending = cancellableDelay(50, controller.signal);
    controller.abort();
    assert.equal(await pending, false);
    assert.equal(await cancellableDelay(0, undefined), true);
    assert.equal(await cancellableDelay(10, controller.signal), false, 'already-aborted signal short-circuits');
});

test('terminalErrorChunk: only finish+error chunks carry a failure', () => {
    const failure = terminalErrorChunk(errorChunk('QUOTA'));
    assert.equal(failure.code, 'QUOTA');
    assert.equal(terminalErrorChunk(stopChunk()), undefined);
    assert.equal(terminalErrorChunk(textChunk('x')), undefined);
    assert.equal(terminalErrorChunk(null), undefined);
    assert.equal(terminalErrorChunk({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } }), undefined);
});

test('retryStream: success on first attempt passes chunks through untouched', async () => {
    let attempts = 0;
    const stream = retryStream(() => {
        attempts += 1;
        return fakeStream([textChunk('a'), textChunk('b'), stopChunk()]);
    }, { decide: () => assert.fail('decide must not run on success'), wait: () => assert.fail('wait must not run') });
    const chunks = await collect(stream);
    assert.equal(attempts, 1);
    assert.deepEqual(chunks.map((c) => c.type), ['text', 'text', 'finish']);
});

test('retryStream: error attempts are buffered away; only the successful attempt is released', async () => {
    let attempts = 0;
    const waits = [];
    const stream = retryStream(() => {
        attempts += 1;
        if (attempts < 3) return fakeStream([textChunk(`partial-${attempts}`), errorChunk('TRANSPORT')]);
        return fakeStream([textChunk('final'), stopChunk()]);
    }, {
        decide: (failure, retry) => {
            assert.equal(failure.code, 'TRANSPORT');
            return retry * 5000;
        },
        wait: (delayMs) => {
            waits.push(delayMs);
            return Promise.resolve(true);
        },
    });
    const chunks = await collect(stream);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [5000, 10000], 'linear schedule drove the waits');
    // No duplicated partial content: the two failed attempts were discarded.
    assert.deepEqual(chunks.map((c) => c.delta ?? c.type), ['final', 'finish']);
});

test('retryStream: when decide declines, the buffered error attempt is released as-is', async () => {
    const stream = retryStream(() => fakeStream([textChunk('partial'), errorChunk('QUOTA')]), {
        decide: () => undefined,
        wait: () => assert.fail('wait must not run when decide declines'),
    });
    const chunks = await collect(stream);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[1].reason.kind, 'error');
    assert.equal(chunks[1].reason.failure.code, 'QUOTA');
});

test('retryStream: aborted wait releases the buffered error instead of retrying', async () => {
    let attempts = 0;
    const stream = retryStream(() => {
        attempts += 1;
        return fakeStream([errorChunk('TRANSPORT')]);
    }, {
        decide: () => 5000,
        wait: () => Promise.resolve(false),
    });
    const chunks = await collect(stream);
    assert.equal(attempts, 1, 'no second attempt after an aborted wait');
    assert.equal(chunks.at(-1).reason.failure.code, 'TRANSPORT');
});

test('retryStream: a consumer that closes early causes no extra attempt', async () => {
    let attempts = 0;
    let releaseWait;
    let waitEntered;
    const waitEnteredPromise = new Promise((resolve) => {
        waitEntered = resolve;
    });
    const stream = retryStream(() => {
        attempts += 1;
        return fakeStream([errorChunk('SERVER')]);
    }, {
        decide: () => 5000,
        wait: () => {
            waitEntered();
            return new Promise((resolve) => {
                releaseWait = resolve;
            });
        },
    });
    const iterator = stream[Symbol.asyncIterator]();
    // The generator only yields after the wait settles, so this stays pending
    // while the wait is parked; wait for the park, close the consumer, then
    // let the wait finish.
    const first = iterator.next();
    await waitEnteredPromise;
    const closing = iterator.return(undefined);
    releaseWait(true);
    await closing;
    await first.catch(() => undefined);
    assert.equal(attempts, 1, 'closed consumer must not open another attempt');
});

test('createRetryEngine.onRequestError: disabled (0) passes through', async () => {
    const engine = createRetryEngine({
        getMaxRetries: () => 0,
        wait: () => assert.fail('wait must not run'),
        log: () => undefined,
        shouldPassThrough: () => false,
        newRetryId: () => 'rid',
    });
    let delegated = false;
    const result = await engine.onRequestError(
        { agent: fakeAgent('s1'), turn: 1, step: 1, provider: 'p', failure: { code: 'QUOTA', message: 'x' }, signal: undefined },
        () => {
            delegated = true;
            return Promise.resolve('stock');
        },
    );
    assert.equal(delegated, true);
    assert.equal(result, 'stock');
});

test('createRetryEngine.onRequestError: ABORTED, overflow and aborted signal pass through', async () => {
    const engine = createRetryEngine({
        getMaxRetries: () => 10000,
        wait: () => assert.fail('wait must not run'),
        log: () => undefined,
        shouldPassThrough: () => false,
        newRetryId: () => 'rid',
    });
    const delegated = [];
    const next = () => {
        delegated.push(1);
        return Promise.resolve(undefined);
    };
    const base = { agent: fakeAgent('s1'), turn: 1, step: 1, provider: 'p' };
    await engine.onRequestError({ ...base, failure: { code: 'ABORTED', message: 'x' }, signal: undefined }, next);
    await engine.onRequestError({ ...base, failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'x' }, signal: undefined }, next);
    const controller = new AbortController();
    controller.abort();
    await engine.onRequestError({ ...base, failure: { code: 'QUOTA', message: 'x' }, signal: controller.signal }, next);
    assert.equal(delegated.length, 3);
});

test('createRetryEngine.onRequestError: retries with durable events, then caps out', async () => {
    const agent = fakeAgent('s1');
    const waits = [];
    const engine = createRetryEngine({
        getMaxRetries: () => 2,
        wait: (delayMs) => {
            waits.push(delayMs);
            return Promise.resolve(true);
        },
        log: () => undefined,
        shouldPassThrough: () => false,
        newRetryId: () => 'rid-1',
    });
    const failure = { code: 'QUOTA', message: 'insufficient balance' };
    const next = () => Promise.resolve('delegated');
    const payload = () => ({ agent, turn: 4, step: 2, provider: 'deepseek-official', failure, signal: undefined });

    const first = await engine.onRequestError(payload(), next);
    assert.deepEqual(first, { kind: 'retry' });
    const second = await engine.onRequestError(payload(), next);
    assert.deepEqual(second, { kind: 'retry' });
    const third = await engine.onRequestError(payload(), next);
    assert.equal(third, 'delegated', 'cap reached -> stock chain decides');

    assert.deepEqual(waits, [5000, 10000], 'linear 5s/10s schedule');
    const events = agent.session.events;
    assert.equal(events[0].type, 'llm/retry');
    assert.equal(events[1].type, 'llm/retry-started');
    assert.equal(events[2].type, 'llm/retry');
    assert.equal(events[3].type, 'llm/retry-started');
    // Stock-compatible event shape for the chat UI's model-retry card.
    assert.deepEqual(Object.keys(events[0].data).sort(), [
        'delayMs', 'failure', 'maxRetries', 'mode', 'policyKey', 'provider', 'retry', 'retryId', 'step', 'turn',
    ].sort());
    assert.equal(events[0].data.retryId, 'rid-1');
    assert.equal(events[0].data.retry, 1);
    assert.equal(events[0].data.maxRetries, 2);
    assert.equal(events[0].data.delayMs, 5000);
    assert.equal(events[0].data.mode, 'normal');
    assert.equal(events[0].data.policyKey, POLICY_KEY);
    assert.equal(events[2].data.retry, 2);
    assert.equal(events[2].data.retryId, 'rid-1', 'one episode keeps one retryId');
});

test('createRetryEngine.onRequestError: a new step starts counting from zero', async () => {
    const engine = createRetryEngine({
        getMaxRetries: () => 1,
        wait: () => Promise.resolve(true),
        log: () => undefined,
        shouldPassThrough: () => false,
        newRetryId: () => 'rid',
    });
    const agent = fakeAgent('s1');
    const next = () => Promise.resolve('delegated');
    const failure = { code: 'SERVER', message: 'x' };
    assert.deepEqual(await engine.onRequestError({ agent, turn: 1, step: 1, provider: 'p', failure, signal: undefined }, next), { kind: 'retry' });
    assert.equal(await engine.onRequestError({ agent, turn: 1, step: 1, provider: 'p', failure, signal: undefined }, next), 'delegated');
    assert.deepEqual(await engine.onRequestError({ agent, turn: 1, step: 2, provider: 'p', failure, signal: undefined }, next), { kind: 'retry' }, 'next step gets a fresh budget');
});

test('createRetryEngine.onRequestError: aborted wait surfaces the original error (undefined)', async () => {
    const engine = createRetryEngine({
        getMaxRetries: () => 10000,
        wait: () => Promise.resolve(false),
        log: () => undefined,
        shouldPassThrough: () => false,
        newRetryId: () => 'rid',
    });
    const agent = fakeAgent('s1');
    const result = await engine.onRequestError(
        { agent, turn: 1, step: 1, provider: 'p', failure: { code: 'TRANSPORT', message: 'x' }, signal: undefined },
        () => assert.fail('must not delegate after scheduling'),
    );
    assert.equal(result, undefined);
    assert.equal(agent.session.events.length, 1, 'llm/retry was written, llm/retry-started was not');
});

test('createRetryEngine.clearAgent: drops only that session\'s counters', async () => {
    const engine = createRetryEngine({
        getMaxRetries: () => 1,
        wait: () => Promise.resolve(true),
        log: () => undefined,
        shouldPassThrough: () => false,
        newRetryId: () => 'rid',
    });
    const failure = { code: 'SERVER', message: 'x' };
    const next = () => Promise.resolve('delegated');
    await engine.onRequestError({ agent: fakeAgent('s1'), turn: 1, step: 1, provider: 'p', failure, signal: undefined }, next);
    await engine.onRequestError({ agent: fakeAgent('s2'), turn: 1, step: 1, provider: 'p', failure, signal: undefined }, next);
    engine.clearAgent('s1');
    assert.equal(engine.counters.size, 1);
    assert.equal([...engine.counters.keys()][0], 's2:1:1');
    engine.dispose();
    assert.equal(engine.counters.size, 0);
});

test('createRetryEngine.wrapDirectStream: agent-loop requests and disabled state pass through', () => {
    const marker = fakeStream([stopChunk()]);
    const original = () => marker;
    const disabled = createRetryEngine({
        getMaxRetries: () => 0,
        wait: () => assert.fail('nope'),
        log: () => undefined,
        shouldPassThrough: () => false,
        newRetryId: () => 'rid',
    });
    assert.equal(disabled.wrapDirectStream({}, original), marker);
    const loopRequests = createRetryEngine({
        getMaxRetries: () => 10000,
        wait: () => assert.fail('nope'),
        log: () => undefined,
        shouldPassThrough: () => true,
        newRetryId: () => 'rid',
    });
    assert.equal(loopRequests.wrapDirectStream({}, original), marker, 'agent-loop requests are retried on the request-error seam instead');
});

test('createRetryEngine.wrapDirectStream: retries a failing compaction-style call', async () => {
    let attempts = 0;
    const waits = [];
    const engine = createRetryEngine({
        getMaxRetries: () => 10000,
        wait: (delayMs) => {
            waits.push(delayMs);
            return Promise.resolve(true);
        },
        log: () => undefined,
        shouldPassThrough: () => false,
        newRetryId: () => 'rid',
    });
    const controller = new AbortController();
    const options = { provider: 'p', model: 'm', purpose: 'compaction', signal: controller.signal };
    const wrapped = engine.wrapDirectStream(options, () => {
        attempts += 1;
        return attempts < 2 ? fakeStream([errorChunk('QUOTA')]) : fakeStream([textChunk('summary'), stopChunk()]);
    });
    const chunks = await collect(wrapped);
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [5000]);
    assert.deepEqual(chunks.map((c) => c.delta ?? c.type), ['summary', 'finish']);
});

test('createRetryEngine.wrapDirectStream: an aborted caller signal skips the retry', async () => {
    const engine = createRetryEngine({
        getMaxRetries: () => 10000,
        wait: () => assert.fail('wait must not run for an aborted caller'),
        log: () => undefined,
        shouldPassThrough: () => false,
        newRetryId: () => 'rid',
    });
    const controller = new AbortController();
    controller.abort();
    const wrapped = engine.wrapDirectStream({ provider: 'p', model: 'm', signal: controller.signal }, () => fakeStream([errorChunk('TRANSPORT')]));
    const chunks = await collect(wrapped);
    assert.equal(chunks.at(-1).reason.failure.code, 'TRANSPORT');
});

function fakeAgent(sessionId) {
    const session = {
        id: sessionId,
        events: [],
        append(type, data) {
            this.events.push({ type, data });
            return { seq: this.events.length };
        },
    };
    return { session };
}
