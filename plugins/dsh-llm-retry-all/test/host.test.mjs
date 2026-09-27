/**
 * Host-half tests for dsh-llm-retry-all.
 *
 * These run the real `lib/index.js` against a recording fake context, so they
 * cover the wiring the pure-logic suite cannot: that the prepended
 * `agent/request-error` listener and the `agent/status` cleanup are actually
 * registered, that the shared LLM runtime's `stream()` is wrapped for direct
 * calls only, that the settings namespace drives the live maxRetries value,
 * and that dispose aborts pending waits.
 *
 * Real waits are never taken: the engine's `wait` is driven through the
 * listener path with a controllable signal, and the plugin's own
 * `cancellableDelay` is exercised with an aborted lifetime only.
 *
 * @module dsh-llm-retry-all/test/host
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_RETRIES, MAX_RETRIES_FIELD, NAME, SETTINGS_NS } from '../lib/logic.js';
import { apply, inject, name, SettingsSchema } from '../lib/index.js';

const errorChunk = (code) => ({
    type: 'finish',
    reason: { kind: 'error', failure: { message: `boom (${code})`, code } },
});
const stopChunk = () => ({ type: 'finish', reason: { kind: 'stop' } });

async function* fakeStream(chunks) {
    for (const chunk of chunks) yield chunk;
}

async function collect(iterable) {
    const out = [];
    for await (const chunk of iterable) out.push(chunk);
    return out;
}

/**
 * Recording fake host context. The cordis service-access rule (`cannot get
 * property "x" without inject`) is modelled ONLY in the strict test below;
 * this double deliberately answers every inject immediately.
 */
function fakeContext(options = {}) {
    const events = [];
    const listeners = new Map();
    const info = [];
    const warns = [];
    const effects = [];
    const settingsService = options.settings ?? null;
    const llm = options.llm;
    const ctx = {
        logger: {
            info: (line) => info.push(line),
            warn: (line) => warns.push(line),
        },
        on(event, listener, config) {
            events.push({ event, config });
            const list = listeners.get(event) ?? [];
            list.push(listener);
            listeners.set(event, list);
            return () => {
                const kept = (listeners.get(event) ?? []).filter((entry) => entry !== listener);
                listeners.set(event, kept);
            };
        },
        effect(setup, label) {
            // cordis runs the setup immediately and stores the returned cleanup.
            const cleanup = setup();
            effects.push({ cleanup, label });
            return () => {};
        },
        inject(services, callback) {
            for (const service of services) {
                callback({
                    logger: ctx.logger,
                    settings: service === 'settings' ? settingsService ?? undefined : undefined,
                    llm: service === 'llm' ? llm : undefined,
                });
            }
        },
    };
    /** Run the waterfall listeners for one event, composing `next` in registration order. */
    const waterfall = async (event, payload, terminal) => {
        const list = [...(listeners.get(event) ?? [])];
        const next = () => terminal();
        let result;
        for (const listener of list) result = await listener(payload, next);
        return result;
    };
    const emit = (event, payload) => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
    };
    const dispose = async () => {
        for (const effect of effects) {
            if (typeof effect.cleanup === 'function') await effect.cleanup();
        }
    };
    return { ctx, events, listeners, info, warns, waterfall, emit, dispose };
}

/** Fake settings service honouring the register/get/watch contract. */
function fakeSettings(initial) {
    let current = { [MAX_RETRIES_FIELD]: DEFAULT_MAX_RETRIES, ...initial };
    let watcher;
    return {
        service: {
            register(ns, schema, options) {
                assert.equal(ns, SETTINGS_NS);
                assert.equal(typeof schema, 'function', 'a schemastery schema is passed');
                assert.deepEqual(options?.base, { [MAX_RETRIES_FIELD]: DEFAULT_MAX_RETRIES });
                return {
                    get: () => current,
                    watch(callback) {
                        watcher = callback;
                        return () => {};
                    },
                };
            },
        },
        push(next) {
            const prev = current;
            current = { ...current, ...next };
            watcher?.call(undefined, current, prev);
        },
    };
}

function mount(options = {}) {
    const settings = fakeSettings(options.settings);
    const harness = fakeContext({ ...options, settings: settings.service });
    apply(harness.ctx);
    return { ...harness, settings };
}

test('the 0.1.7 line (settings service without register) reads the entry config', async () => {
    // 0.1.7-rc.2's `settings` service has no legacy `register`: the parsed entry config
    // arrives as `apply`'s second argument instead. Reaching for `register` there is what
    // used to throw `TypeError: settings.register is not a function` into cordis' fiber
    // executor — swallowed, so the plugin silently stayed on its default forever.
    const harness = fakeContext({ settings: { configure: () => undefined } });
    assert.doesNotThrow(() => apply(harness.ctx, { [MAX_RETRIES_FIELD]: 0 }));
    // The service is present, so the settings seat resolves; its callback must be a no-op.
    // (The unrelated "no LLM runtime" warning is expected here: this harness carries none.)
    assert.deepEqual(harness.warns.filter((line) => line.includes('settings')),
        [], 'no settings registration failure may be reported');
    // And the config value is the LIVE one: 0 disables this plugin, so a failing request is
    // delegated to the rest of the chain immediately (no retry is scheduled).
    const agent = fakeAgent('s1');
    const delegated = () => Promise.resolve('stock-chain');
    const action = await harness.waterfall('agent/request-error', {
        agent,
        turn: 1,
        step: 1,
        provider: 'p',
        failure: { code: 'QUOTA', message: 'x' },
        signal: new AbortController().signal,
    }, delegated);
    assert.equal(action, 'stock-chain', 'maxRetries = 0 from the config disables the plugin');
    assert.deepEqual(agent.session.events, []);
});

test('the 0.1.5 line still registers the namespace and watches it', () => {
    const mounted = mount({ settings: { [MAX_RETRIES_FIELD]: 1 } });
    assert.ok(mounted.info.some((line) => line.includes('mounted; maxRetries = 1')));
    mounted.settings.push({ [MAX_RETRIES_FIELD]: 0 });
    assert.ok(mounted.info.some((line) => line.includes('maxRetries = 0')), 'the watcher is live');
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

test('the plugin declares its cordis identity', () => {
    assert.equal(name, NAME);
    assert.deepEqual(inject, ['agents']);
});

test('the settings schema defaults maxRetries to 10000', () => {
    assert.equal(SettingsSchema({})[MAX_RETRIES_FIELD], DEFAULT_MAX_RETRIES);
});

test('apply never reads a service off the mount context (the real boot failure)', () => {
    const asked = [];
    const strict = {
        logger: { info() {}, warn() {} },
        on() { return () => {}; },
        effect() { return () => {}; },
        inject(services, callback) {
            asked.push(services.join(','));
            for (const service of services) {
                callback({
                    logger: strict.logger,
                    settings: service === 'settings'
                        ? { register: () => ({ get: () => ({}), watch: () => () => {} }) }
                        : undefined,
                    llm: service === 'llm' ? { stream: () => fakeStream([]) } : undefined,
                });
            }
        },
    };
    for (const service of ['llm', 'settings']) {
        Object.defineProperty(strict, service, {
            get() {
                throw new Error(`cannot get property "${service}" without inject`);
            },
        });
    }
    assert.doesNotThrow(() => apply(strict), 'apply must take every service through inject');
    assert.ok(asked.includes('llm'), 'the llm seat must be waited for');
    assert.ok(asked.includes('settings'), 'the settings seat must be waited for');
});

test('mount registers the prepended request-error listener, the status cleanup and both seats', () => {
    const mounted = mount();
    const errorRow = mounted.events.find((row) => row.event === 'agent/request-error');
    assert.ok(errorRow, 'agent/request-error listener registered');
    assert.deepEqual(errorRow.config, { prepend: true }, 'prepended ahead of the stock llm-retry');
    assert.ok(mounted.events.some((row) => row.event === 'agent/status'), 'idle cleanup registered');
    assert.ok(mounted.info.some((line) => line.includes('mounted; maxRetries = 10000')));
});

test('a failing agent request is scheduled with durable events and retries', async () => {
    const mounted = mount();
    const agent = fakeAgent('s1');
    const payload = {
        agent,
        turn: 1,
        step: 1,
        provider: 'deepseek-official',
        failure: { code: 'QUOTA', message: 'insufficient balance' },
        signal: new AbortController().signal,
    };
    // The real schedule waits 5s for the first retry; collapse timers so the
    // test takes the wait instantly while still exercising cancellableDelay.
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => {
        fn();
        return 0;
    };
    try {
        const action = await mounted.waterfall('agent/request-error', payload, () => Promise.resolve(undefined));
        assert.deepEqual(action, { kind: 'retry' });
    }
    finally {
        globalThis.setTimeout = originalSetTimeout;
    }
    assert.deepEqual(agent.session.events.map((row) => row.type), ['llm/retry', 'llm/retry-started']);
    assert.equal(agent.session.events[0].data.retry, 1);
    assert.equal(agent.session.events[0].data.delayMs, 5000);
});

test('overflow and user cancellation are delegated to the rest of the chain', async () => {
    const mounted = mount();
    const agent = fakeAgent('s1');
    const base = { agent, turn: 1, step: 1, provider: 'p', signal: new AbortController().signal };
    const delegated = () => Promise.resolve('stock-chain');
    assert.equal(
        await mounted.waterfall('agent/request-error', { ...base, failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'x' } }, delegated),
        'stock-chain',
        'compaction-basic owns overflow recovery',
    );
    assert.equal(
        await mounted.waterfall('agent/request-error', { ...base, failure: { code: 'ABORTED', message: 'x' } }, delegated),
        'stock-chain',
    );
    assert.equal(agent.session.events.length, 0, 'no retry events for delegated failures');
});

test('agent going idle clears its episode counters', async () => {
    const mounted = mount({ settings: { [MAX_RETRIES_FIELD]: 1 } });
    const agent = fakeAgent('s1');
    const failure = { code: 'SERVER', message: 'x' };
    const base = { agent, turn: 1, step: 1, provider: 'p', failure, signal: new AbortController().signal };
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => {
        fn();
        return 0;
    };
    try {
        const delegated = () => Promise.resolve('stock-chain');
        assert.deepEqual(await mounted.waterfall('agent/request-error', base, delegated), { kind: 'retry' });
        assert.equal(await mounted.waterfall('agent/request-error', base, delegated), 'stock-chain', 'cap=1 reached');
        mounted.emit('agent/status', { agent, status: 'idle' });
        assert.deepEqual(await mounted.waterfall('agent/request-error', base, delegated), { kind: 'retry' }, 'idle reset the episode');
    }
    finally {
        globalThis.setTimeout = originalSetTimeout;
    }
});

test('the llm.stream patch wraps purpose-tagged calls and leaves untagged traffic alone', async () => {
    const calls = [];
    let attempts = 0;
    let compactionFailed = false;
    const llm = {
        stream(options) {
            calls.push(options);
            attempts += 1;
            if (options.purpose === 'compaction' && !compactionFailed) {
                compactionFailed = true;
                return fakeStream([errorChunk('TRANSPORT')]);
            }
            return fakeStream([stopChunk()]);
        },
    };
    const mounted = mount({ llm });
    assert.equal(llm.__llmRetryAllPatched, true);
    assert.ok(mounted.info.some((line) => line.includes('direct-call retry installed')));

    // Agent-loop requests carry no `purpose` tag and pass through untouched
    // (they are retried on the agent/request-error seam instead). The
    // classifier is request SHAPE, deliberately NOT dsh-llm's
    // isAgentLoopRequest: under DSH Desktop the host's dsh-llm lives inside
    // app.asar while a link-installed plugin resolves its own copy, so the
    // WeakSet identity check is always false in production (Electron-probe
    // verified 2026-09-24) and buffered the whole main-chat stream.
    const passthrough = llm.stream({ provider: 'p', model: 'm' });
    assert.equal(attempts, 1, 'untagged request dispatched once, immediately');
    assert.equal(typeof passthrough[Symbol.asyncIterator], 'function');

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => {
        fn();
        return 0;
    };
    try {
        const direct = await collect(llm.stream({ provider: 'p', model: 'm', purpose: 'compaction' }));
        assert.equal(attempts, 3, 'the failing direct call was retried');
        assert.equal(direct.at(-1).reason.kind, 'stop');

        const titled = await collect(llm.stream({ provider: 'p', model: 'm', purpose: 'session-title' }));
        assert.equal(titled.at(-1).reason.kind, 'stop', 'session-title calls are wrapped too');
    }
    finally {
        globalThis.setTimeout = originalSetTimeout;
    }
});

test('dispose restores the original llm.stream and clears the patch flag', async () => {
    const llm = {
        stream() {
            return fakeStream([stopChunk()]);
        },
    };
    const originalMethod = llm.stream;
    const mounted = mount({ llm });
    assert.notEqual(llm.stream, originalMethod, 'patched at mount');

    await mounted.dispose();
    assert.equal(llm.stream, originalMethod, 'the own-property patch is undone');
    assert.equal('__llmRetryAllPatched' in llm, false, 'the idempotence flag is gone');

    // A fresh mount after disposal patches again (idempotent re-mount).
    const remounted = mount({ llm });
    assert.notEqual(llm.stream, originalMethod);
    await remounted.dispose();
    assert.equal(llm.stream, originalMethod);
});

test('with maxRetries = 0 the direct-call patch is a pass-through', async () => {
    let attempts = 0;
    const llm = {
        stream() {
            attempts += 1;
            return fakeStream([errorChunk('QUOTA')]);
        },
    };
    mount({ llm, settings: { [MAX_RETRIES_FIELD]: 0 } });
    const chunks = await collect(llm.stream({ provider: 'p', model: 'm', purpose: 'compaction' }));
    assert.equal(attempts, 1, 'disabled plugin must not retry');
    assert.equal(chunks.at(-1).reason.failure.code, 'QUOTA');
});

test('a settings change to 0 applies to the next failure decision', async () => {
    const mounted = mount();
    const agent = fakeAgent('s1');
    const failure = { code: 'RATE_LIMIT', message: 'x' };
    const base = { agent, turn: 1, step: 1, provider: 'p', failure, signal: new AbortController().signal };
    mounted.settings.push({ [MAX_RETRIES_FIELD]: 0 });
    assert.ok(mounted.info.some((line) => line.includes('maxRetries = 0 (plugin disabled')));
    assert.equal(
        await mounted.waterfall('agent/request-error', base, () => Promise.resolve('stock-chain')),
        'stock-chain',
        'disabled plugin delegates immediately',
    );
});

test('dispose aborts a pending wait and releases the listeners', async () => {
    const mounted = mount();
    const agent = fakeAgent('s1');
    const payload = {
        agent,
        turn: 1,
        step: 1,
        provider: 'p',
        failure: { code: 'TRANSPORT', message: 'x' },
        signal: new AbortController().signal,
    };
    const scheduled = mounted.waterfall('agent/request-error', payload, () => assert.fail('must not delegate once scheduled'));
    // The listener is parked in the real 5s wait; disposing the plugin aborts it.
    await new Promise((resolve) => setImmediate(resolve));
    await mounted.dispose();
    const action = await scheduled;
    assert.equal(action, undefined, 'aborted wait surfaces the original error');
    assert.equal(agent.session.events.map((row) => row.type).includes('llm/retry-started'), false);
    assert.equal(mounted.listeners.get('agent/request-error').length, 0, 'listener released');
});
