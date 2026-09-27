/**
 * Host-half tests for dsh-compact-model.
 *
 * These run the real `lib/index.js` against a recording fake context, so they
 * cover the wiring the pure-logic suite cannot: that the settings namespace and
 * the global `internal/config` waterfall are actually registered, that a settings
 * change reaches running engines, and that the reasoning-effort patch touches
 * compaction requests only.
 *
 * The harness deliberately mirrors cordis' contract for `internal/config`
 * listeners: the listener's `this` is the emitting fiber, and the returned value
 * (not a mutated argument) is what the loader resolves as that fiber's config.
 *
 * @module dsh-compact-model/test/host
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_FIELD, MODEL_FIELD, PROVIDER_FIELD, SETTINGS_NS } from '../lib/logic.js';
import { Config, __internals, apply, name, SettingsSchema } from '../lib/index.js';

const pinned = { [PROVIDER_FIELD]: 'kimi-coding', [MODEL_FIELD]: 'k3' };
const following = { [PROVIDER_FIELD]: '', [MODEL_FIELD]: '' };

/** Build a fiber-like value for one loader row, as an `internal/config` listener sees it. */
function fiber(options) {
    return {
        entry: { options },
        runtime: options.pluginName === undefined ? undefined : { callback: { name: options.pluginName } },
    };
}

/** The packaging row, exactly as `@deepseek-ai/dsh-compaction-basic` is declared in every preset. */
const COMPACTION_FIBER = () => fiber({
    id: 'compaction-basic',
    name: '@deepseek-ai/dsh-compaction-basic',
    pluginName: 'compaction-basic',
});

/** A live engine as `ctx.reflect.store` holds it. */
function engine(config = { auto: true, maxTokens: 8192, summarizationProvider: '', summarizationModel: '' }) {
    return {
        summarize() {},
        compactNow() {},
        config,
        ctx: { llm: undefined },
    };
}

/**
 * Recording fake host context.
 *
 * Kept deliberately SIMPLE: it records registration and lets a test hand the
 * plugin the scopes it asks for. The cordis service-access rule (`cannot get
 * property "x" without inject`) is NOT modelled here — a faithful model needs the
 * real runtime, so that rule is covered by `inject.test.mjs` against real cordis
 * plus the one self-contained strict check below. Modelling it in this shared
 * double turned every other test into a false failure, which is worse than the
 * gap it was meant to close.
 *
 * @param options - `{ store, llm, settings }` overrides.
 * @returns `{ ctx, events, listeners, info, warns, injected, injectedScopes, emit }`.
 */
function fakeContext(options = {}) {
    const events = [];
    const listeners = new Map();
    const info = [];
    const warns = [];
    const injected = new Map();
    const injectedScopes = new Set();
    const store = options.store ?? {};
    const settingsService = options.settings ?? null;
    const llm = options.llm;
    const ctx = {
        logger: {
            info: (line) => info.push(line),
            warn: (line) => warns.push(line),
        },
        llm,
        settings: settingsService ?? undefined,
        reflect: { store },
        on(event, listener, config) {
            events.push({ event, config });
            const list = listeners.get(event) ?? [];
            list.push(listener);
            listeners.set(event, list);
        },
        /** Scope-shaped child context carrying the one service its callback asked for. */
        childFor(service) {
            return {
                logger: ctx.logger,
                reflect: { store },
                settings: service === 'settings' ? settingsService ?? undefined : undefined,
                llm: service === 'llm' ? llm : undefined,
            };
        },
        inject(services, callback) {
            injected.set(services.join(','), callback);
        },
    };
    /** Run every listener for one event, threading the waterfall's `next`. */
    const emit = (event, self, ...args) => {
        const list = listeners.get(event) ?? [];
        const next = () => args[0];
        let result = args[0];
        for (const listener of list) result = listener.call(self, ...args, next);
        return result;
    };
    return { ctx, events, listeners, info, warns, injected, injectedScopes, emit };
}

/**
 * Fake settings service.
 *
 * The real service invokes a namespace watcher as `callback(next, prev)` with
 * `this` bound to the REGISTERING plugin's context — which is why the plugin's
 * `onSettingsChanged(settingsCtx, next, prev)` reads its host context from the
 * first argument. This double models that exactly, so a test that pushes a
 * section exercises the same call shape the host produces.
 */
function fakeSettings(initial = following) {
    let current = { provider: '', model: '', reasoningEffort: '', ...initial };
    let watcher;
    let owner;
    return {
        service: {
            register(ns, schema, options) {
                assert.equal(ns, SETTINGS_NS);
                assert.equal(typeof schema, 'function', 'a schemastery schema is passed');
                assert.ok(options?.base, 'a base section is supplied');
                // INVERTED ON PURPOSE — this used to assert the opposite.
                //
                // A settings-layer `validate` hook runs on every write AND every
                // resolve, so registering the pair rule there made a half-written
                // pair unrepresentable. That broke the card utterly: "provider
                // chosen, model not chosen yet" is an ordinary intermediate state,
                // its write came back `settings/rejected`, and the browser scope
                // answers a rejection by SILENTLY re-reading the mirror. Result:
                // clicking the provider dropdown did nothing at all, with no error
                // in the browser and no trace in the host log or settings.yaml.
                //
                // The rule belongs at the point of USE instead (`hasRoute()` gates
                // `decideInjection`), where it is unmissable because a half-pair
                // simply contributes no config. Do not re-add a validate hook here
                // without re-reading this contract.
                assert.equal(options?.validate, undefined,
                    'no validate hook: the pair rule must not gate writes');
                return {
                    get: () => current,
                    watch(callback) {
                        watcher = callback;
                        return () => {};
                    },
                };
            },
        },
        /** Push a new resolved section the way the service does on a committed write. */
        push(ownerCtx, next) {
            owner = ownerCtx;
            const prev = current;
            current = { provider: '', model: '', reasoningEffort: '', ...next };
            watcher?.call(owner, current, prev);
        },
    };
}

/**
 * Mount the plugin over a fake context, optionally with a settings provider.
 *
 * Only the services the plugin actually asked for reach their callbacks — exactly
 * what cordis does — and each request is recorded, so a test can assert the plugin
 * WAITED for the seats it needs instead of reading them off the mount context
 * (which throws in the real host: `cannot get property "llm" without inject`).
 */
function mount(options = {}) {
    const settings = fakeSettings(options.settings ?? following);
    const harness = fakeContext({ ...options, settings: settings.service });
    harness.ctx.inject = (services, callback) => {
        harness.injected.set(services.join(','), callback);
        for (const service of services) {
            harness.injectedScopes.add(service);
            callback(harness.ctx.childFor(service));
        }
    };
    apply(harness.ctx);
    /** Drive a committed settings change through the owning host context. */
    const set = (next) => settings.push(harness.ctx, next);
    return { ...harness, settings, set };
}

test('apply never reads a service off the mount context (the real boot failure)', () => {
    // The real host killed the whole loader entry with
    // `cannot get property "llm" without inject` because `apply` used to read
    // `ctx.llm` directly: the LLM runtime is a SIBLING row, so the mount context
    // has no such property. This context models exactly that rule — reverted to
    // hermetic here so it cannot make the other tests lie.
    const asked = [];
    const strict = {
        logger: { info() {}, warn() {} },
        reflect: { store: {} },
        on() {},
        inject(services, callback) {
            asked.push(services.join(','));
            for (const service of services) {
                callback({
                    logger: strict.logger,
                    reflect: { store: {} },
                    settings: service === 'settings'
                        ? { register: () => ({ get: () => ({}), watch: () => () => {} }) }
                        : undefined,
                    llm: service === 'llm' ? { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } : undefined,
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
    assert.equal(asked.includes('llm'), true, 'the llm seat must be waited for');
    assert.equal(asked.includes('settings'), true, 'the settings seat must be waited for');
});

test('the plugin declares its name and needs no required services', () => {
    assert.equal(name, 'compact-model');
    assert.deepEqual(__internals.EFFORT_VALUES, ['', 'off', 'low', 'high', 'max']);
});

test('the settings schema defaults every field to the follow-the-session-model state', () => {
    const value = SettingsSchema({});
    assert.equal(value[PROVIDER_FIELD], '');
    assert.equal(value[MODEL_FIELD], '');
    assert.equal(value.reasoningEffort, '');
});

test('mount registers one global internal/config listener, the llm seat and the settings namespace', () => {
    const mounted = mount();
    assert.equal(mounted.events.length, 1);
    assert.equal(mounted.events[0].event, 'internal/config');
    assert.deepEqual(mounted.events[0].config, { global: true });
    // `llm` is a sibling loader row, so the seat is taken through injection rather
    // than read off the mount context (a bare `ctx.llm` throws and kills the tree).
    assert.equal(mounted.injected.has('llm'), true);
    assert.equal(mounted.injected.has('settings'), true);
    assert.equal(mounted.info.some((line) => line.includes('mounted; compaction route = follow the session model')), true);
});

test('with no route configured the listener hands back the untouched config', () => {
    const mounted = mount({ settings: following });
    const config = { auto: true, maxTokens: 8192 };
    const resolved = mounted.emit('internal/config', COMPACTION_FIBER(), config);
    assert.equal(resolved, config, 'the very same object, so nothing downstream changes');
    assert.equal(mounted.info.some((line) => line.includes('recognised the compaction backend')), true);
});

test('a configured route is injected into the preset-owned compaction row', () => {
    const mounted = mount({ settings: pinned });
    const resolved = mounted.emit('internal/config', COMPACTION_FIBER(), undefined);
    assert.deepEqual(resolved, { summarizationProvider: 'kimi-coding', summarizationModel: 'k3' });
    assert.equal(
        mounted.info.some((line) => line.includes('pinned the compaction route to kimi-coding/k3 at load time')),
        true,
    );
});

test('unrelated fibers are never rewritten, even with a route configured', () => {
    const mounted = mount({ settings: pinned });
    const pruner = fiber({ id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner' });
    const config = { thresholdChars: 8192 };
    assert.equal(mounted.emit('internal/config', pruner, config), config);
    const planMode = fiber({ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' });
    assert.equal(mounted.emit('internal/config', planMode, undefined), undefined);
});

test('a settings change live-applies the route to running engines', () => {
    const running = engine();
    const mounted = mount({ store: { [Symbol('compaction@preset')]: { name: 'compaction', value: running } } });
    assert.equal(running.config.summarizationProvider, '', 'stock state before the change');

    mounted.set(pinned);
    assert.equal(running.config.summarizationProvider, 'kimi-coding');
    assert.equal(running.config.summarizationModel, 'k3');
    assert.equal(running.config.auto, true, 'the rest of the engine config survives');
    assert.equal(Object.isFrozen(running.config), true);
    assert.equal(mounted.info.some((line) => line.includes('live-applied kimi-coding/k3 to 1 running compaction engine(s)')), true);
});

test('clearing the route stops new injections but never rewrites a running engine', () => {
    const running = engine({ auto: true, summarizationProvider: 'kimi-coding', summarizationModel: 'k3' });
    const mounted = mount({
        settings: pinned,
        store: { [Symbol('compaction@preset')]: { name: 'compaction', value: running } },
    });
    mounted.set(following);
    // Follow-the-session-model is expressed by contributing nothing; the engine keeps
    // whatever the last resolution produced, exactly like the stock plugin.
    assert.equal(running.config.summarizationProvider, 'kimi-coding');
    const resolved = mounted.emit('internal/config', COMPACTION_FIBER(), undefined);
    assert.equal(resolved, undefined);
});

test('pressuring the store with non-engine rows is harmless', () => {
    const llm = { stream: () => ({ async *[Symbol.asyncIterator]() {} }) };
    const mounted = mount({
        settings: pinned,
        llm,
        store: {
            [Symbol('compaction')]: { name: 'compaction', value: { not: 'an engine' } },
            [Symbol('tokens')]: { name: 'tokenMeter', value: { measure: () => ({}) } },
            [Symbol('junk')]: undefined,
        },
    });
    assert.deepEqual(__internals.liveEngines(mounted.ctx), []);
    mounted.set({ ...pinned, [MODEL_FIELD]: 'k3-mini' });
    assert.equal(mounted.warns.length, 0, 'no warning may come from a store full of unrelated rows');
});

test('a settings context without a logger cannot break a settings change', () => {
    // The real `inject(['settings'], cb)` hands the callback the SERVICE's context,
    // which reaches `ctx.settings` but is not guaranteed to carry the logger seat.
    // The plugin must log through the mount context it got from `apply`.
    const harness = fakeContext({ settings: following });
    const settings = fakeSettings(following);
    harness.ctx.inject = (services, callback) => {
        if (services.includes('settings')) callback({ settings: settings.service }); // no `logger`
    };
    apply(harness.ctx);
    assert.doesNotThrow(() => settings.push({ fake: 'context with only a settings seat' }, pinned));
    assert.equal(harness.info.some((line) => line.includes('compaction route = kimi-coding/k3')), true);
});

test('logging survives a context with no logger at all, via the console fallback', () => {
    const info = [];
    const warn = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (line) => info.push(String(line));
    console.warn = (line) => warn.push(String(line));
    try {
        __internals.log(undefined, 'info', 'probe line');
        __internals.log({ logger: null }, 'warn', 'probe warn');
        __internals.log({ logger: { info() { throw new Error('broken seat'); } } }, 'info', 'probe broken');
    }
    finally {
        console.log = originalLog;
        console.warn = originalWarn;
    }
    assert.equal(info.length, 2);
    assert.equal(warn.length, 1);
    assert.equal(info[0].includes('dsh-compact-model: probe line'), true);
    assert.equal(warn[0].includes('[W] dsh-compact-model: probe warn'), true);
    assert.equal(info[1].includes('probe broken'), true);
});

test('the effort patch injects reasoningEffort into compaction requests only', () => {
    const calls = [];
    const llm = {
        stream(options) {
            calls.push(options);
            return { async *[Symbol.asyncIterator]() {} };
        },
    };
    const mounted = mount({ llm, settings: { ...pinned, reasoningEffort: 'high' } });
    assert.equal(llm.__compactModelPatched, true);

    llm.stream({ provider: 'kimi-coding', model: 'k3', purpose: 'compaction' });
    llm.stream({ provider: 'deepseek-official', model: 'deepseek-flash', purpose: 'chat' });
    llm.stream({ provider: 'deepseek-official', model: 'deepseek-flash', purpose: 'session-title' });

    assert.equal(calls[0].reasoningEffort, 'high');
    assert.equal(calls[1].reasoningEffort, undefined);
    assert.equal(calls[2].reasoningEffort, undefined);
    assert.equal(mounted.info.some((line) => line.includes('reasoning-effort override installed')), true);
});

test('an adapter that rejects the effort disables the override for the rest of the process', async () => {
    const rejection = Object.assign(new Error('DeepSeek does not support reasoning effort "high"'), {
        code: 'UNSUPPORTED_REASONING_EFFORT',
    });
    const llm = {
        stream() {
            return {
                [Symbol.asyncIterator]() {
                    return { next: async () => { throw rejection; } };
                },
            };
        },
    };
    const mounted = mount({ llm, settings: { ...pinned, reasoningEffort: 'high' } });
    const stream = llm.stream({ purpose: 'compaction' });
    await assert.rejects(async () => {
        for await (const chunk of stream) void chunk;
    });
    assert.equal(mounted.warns.some((line) => line.includes('the compaction model rejected effort')), true);

    // The next compaction must go out without the rejected effort rather than fail again.
    const calls = [];
    const llm2 = { stream: (options) => { calls.push(options); return { async *[Symbol.asyncIterator]() {} }; } };
    const mounted2 = mount({ llm: llm2, settings: { ...pinned, reasoningEffort: 'high' } });
    assert.equal(mounted2 && __internals.state.effortDisabled, true);
    llm2.stream({ purpose: 'compaction' });
    assert.equal(calls[0].reasoningEffort, undefined);
});

test('the settings schema is the volatile Config the 0.1.7 loader parses and serves', () => {
    // The provider's `describe()` drops every entry whose Config has no volatile field
    // (`volatileForm(schema) === undefined`), so without these markers the entry is never
    // "served" and the browser card's `whileServed` gate never fires — the exact
    // "no card on the official desktop" bug this suite pins.
    assert.equal(Config, SettingsSchema);
    for (const field of [PROVIDER_FIELD, MODEL_FIELD, EFFORT_FIELD]) {
        assert.equal(SettingsSchema.dict[field].meta.volatile, true, `${field} must be volatile`);
    }
});

test('the 0.1.7 line (settings service without register) reads the entry config', () => {
    // 0.1.7-rc.2's `settings` service has no legacy `register`: the parsed entry config
    // arrives as `apply`'s second argument instead. Reaching for `register` there is what
    // used to throw `TypeError: settingsCtx.settings.register is not a function` into
    // cordis' fiber executor — swallowed, so the plugin silently ran on defaults and its
    // namespace was never served.
    const { ctx, injected } = fakeContext({ settings: { describe: () => [] } });
    assert.doesNotThrow(() => apply(ctx, {
        [PROVIDER_FIELD]: 'kimi-coding',
        [MODEL_FIELD]: 'k3',
        [EFFORT_FIELD]: 'high',
    }));
    assert.deepEqual(__internals.state.settings, {
        [PROVIDER_FIELD]: 'kimi-coding',
        [MODEL_FIELD]: 'k3',
        [EFFORT_FIELD]: 'high',
    }, 'the entry config is the live section on that line');
    // The settings seat still resolves (the service exists): its callback must be a no-op.
    const settingsCallback = injected.get('settings');
    if (typeof settingsCallback === 'function') {
        assert.doesNotThrow(() => settingsCallback(ctx.childFor('settings')));
        assert.deepEqual(__internals.state.settings, {
            [PROVIDER_FIELD]: 'kimi-coding',
            [MODEL_FIELD]: 'k3',
            [EFFORT_FIELD]: 'high',
        });
    }
});

test('a route configured before boot is applied to engines that are already live', () => {
    const running = engine();
    const mounted = mount({
        settings: pinned,
        store: { [Symbol('compaction@preset')]: { name: 'compaction', value: running } },
    });
    assert.equal(running.config.summarizationProvider, 'kimi-coding');
    assert.equal(mounted.info.some((line) => line.includes('after mount')), true);
});
