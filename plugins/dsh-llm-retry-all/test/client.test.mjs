/**
 * Client-half contract tests for dsh-llm-retry-all.
 *
 * These load the REAL `lib/client.js` bundle through a `node:vm` sandbox and
 * drive it with a hand-written React double whose hooks actually run. There is
 * no jsdom on this machine, so the suite pins the contracts that matter:
 *
 *  1. The card keeps the framework `PluginCard` DOM contract
 *     (`li.card > button.header + div.body`) and its number input is the one
 *     field the host writes through.
 *  2. The write path drops a no-op before it reaches the wire (the host skips an
 *     unchanged section in total silence, which reads as a dead control) and
 *     reports a rejection instead of swallowing it.
 *  3. SEAT SELECTION per dsh line. 0.1.7-rc.2 removed BOTH the client service
 *     `settingsScope` AND the `settings.plugin.item` seat: a card keyed by its
 *     settings namespace then has no seat to land in, so it activates cleanly and
 *     renders NOWHERE. The three scenarios below are the three real compositions
 *     (community 0.1.5 / official 0.1.7 + Web UI group / 0.1.7 without the group),
 *     plus the composition with no settings transport at all, which must stay
 *     active rather than fail the web boot.
 *
 * @module dsh-llm-retry-all/test/client
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/**
 * Copy a value out of the sandbox realm (vm-realm objects fail
 * `assert.deepStrictEqual` across realms).
 * @param value - a value produced inside the sandbox.
 * @returns the same data built from this realm's constructors.
 */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * Recursively collect every `className` in a rendered tree.
 * @param node - element, array, or leaf.
 * @param into - accumulator.
 * @returns the accumulator.
 */
function classes(node, into = []) {
    if (node === null || node === undefined || typeof node !== 'object') return into;
    if (Array.isArray(node)) {
        for (const child of node) classes(child, into);
        return into;
    }
    const className = node.props === undefined ? undefined : node.props.className;
    if (typeof className === 'string') into.push(...className.split(' ').filter((part) => part !== ''));
    classes(node.props === undefined ? undefined : node.props.children, into);
    return into;
}

/**
 * Find the first element whose className contains `needle`.
 * @param node - rendered tree.
 * @param needle - a class token.
 * @returns the element, or undefined.
 */
function find(node, needle) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = find(child, needle);
            if (hit !== undefined) return hit;
        }
        return undefined;
    }
    const className = node.props === undefined ? undefined : node.props.className;
    if (typeof className === 'string' && className.split(' ').includes(needle)) return node;
    return find(node.props === undefined ? undefined : node.props.children, needle);
}

/**
 * Load the client bundle in a sandbox.
 * @returns `{ exports, css, errors, resetSlots }`.
 */
function loadBundle() {
    const css = [];
    const errors = [];
    const state = new Map();
    let slot = 0;
    let rerender = () => undefined;

    const hook = (init) => {
        const key = `s${slot++}`;
        if (!state.has(key)) {
            state.set(key, typeof init === 'function' ? init() : init);
        }
        return [state.get(key), (next) => {
            const value = typeof next === 'function' ? next(state.get(key)) : next;
            if (value !== state.get(key)) {
                state.set(key, value);
                rerender();
            }
        }];
    };

    const react = {
        useState: hook,
        useEffect: () => undefined,
        useLayoutEffect: () => undefined,
        useRef: (init) => ({ current: init === undefined ? null : init }),
        useMemo: (factory) => factory(),
        useCallback: (fn) => fn,
        createElement: (type, props, ...children) => ({
            type,
            props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
        }),
        Fragment: Symbol('Fragment'),
    };

    const jsx = (type, props) => ({ type, props: props ?? {} });
    const jsxs = jsx;

    const document = {
        querySelector: () => null,
        createElement: () => ({ dataset: {}, textContent: '', setAttribute: () => undefined }),
        head: {
            appendChild: (tag) => {
                css.push(tag.textContent);
                return tag;
            },
        },
    };

    const primitives = {
        // Stand-in for the framework chevron: this harness never invokes
        // components, so only the element's props are read.
        IconChevronDownOutline14: (props) => jsx('svg', { className: props.className }),
    };

    let captured;
    /**
     * Controllable timeout queue.
     *
     * The 0.1.7-without-the-group path parks the card for `FAMILY_GRACE_MS` before
     * falling back to the plugin manager's keyed seat, so the suite must be able to
     * advance that window instead of sleeping two real seconds.
     */
    const timers = [];
    const sandbox = {
        console: {
            log: () => undefined,
            warn: (...args) => errors.push(args.join(' ')),
            error: (...args) => errors.push(args.join(' ')),
        },
        document,
        Map,
        Symbol,
        Promise,
        Object,
        Array,
        JSON,
        String,
        Number,
        Math,
        Error,
        setTimeout: (callback, ms) => {
            const entry = { callback, ms, cleared: false };
            timers.push(entry);
            return entry;
        },
        clearTimeout: (entry) => {
            if (entry !== null && typeof entry === 'object') entry.cleared = true;
        },
        window: {
            __ModuleLoader__: {
                load: (definition) => {
                    captured = definition;
                },
            },
        },
    };
    sandbox.globalThis = sandbox;
    runInContext(readFileSync(BUNDLE, 'utf8'), createContext(sandbox), { filename: BUNDLE });

    const moduleExports = captured.factory((id) => {
        if (id === 'react') return react;
        if (id === 'react/jsx-runtime') return { jsx, jsxs, Fragment: react.Fragment };
        if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
        throw new Error(`unexpected module request: ${id}`);
    });

    return {
        exports: moduleExports,
        css: () => css.join('\n'),
        errors: () => errors,
        setRerender: (fn) => {
            rerender = fn;
        },
        resetSlots: () => {
            slot = 0;
        },
        /** Fire every timeout the bundle scheduled and has not cleared. */
        runTimers: () => {
            for (const entry of timers.splice(0)) {
                if (!entry.cleared) entry.callback();
            }
        },
    };
}

/** A ready snapshot; `value` is the resolved section, `user` the raw layer. */
function readySnapshot(section = { maxRetries: 5 }, user = {}) {
    return { status: 'ready', writable: true, value: section, user };
}

/**
 * Render the card once.
 * @param bundle - the loaded bundle.
 * @param options - `{ snapshot, setMaxRetries }` overrides.
 * @returns the rendered tree.
 */
function renderCard(bundle, options = {}) {
    const snapshot = options.snapshot ?? readySnapshot();
    bundle.resetSlots();
    return bundle.exports.RetryAllCard({
        useLlmRetryAll: (selector) => selector(snapshot),
        setMaxRetries: options.setMaxRetries ?? (() => Promise.resolve()),
    });
}

/**
 * Fake cordis context whose service registry can be filled before OR after `apply`,
 * so both real orderings can be replayed:
 *
 *  - services already registered when `apply` runs — what the local gate harness does, providing
 *    everything up front, which is why that harness never saw the bug; and
 *  - services that register LATER — the real page, where `slots` is up long before the
 *    settings transports. That ordering used to leave the card unregistered forever.
 *
 * `inject(deps, callback)` mirrors cordis: the callback runs as soon as EVERY declared
 * dependency is registered (with a scoped context), and waits otherwise.
 *
 * @param services - services already registered, keyed by service name.
 * @returns `{ ctx, record, provide }`.
 */
function fakeContext(services = {}) {
    const registry = new Map(Object.entries(services));
    const waiting = [];
    const record = { ctxInjections: [], injected: [], registered: [], whileServed: [], bound: undefined };
    const scoped = { get: (name) => registry.get(name) };
    const flush = () => {
        for (const entry of waiting.splice(0)) {
            if (entry.cancelled) continue;
            if (!entry.deps.every((name) => registry.get(name) !== undefined)) waiting.push(entry);
            else entry.callback(scoped);
        }
    };
    const ctx = {
        get: (name) => registry.get(name),
        inject: (deps, callback) => {
            const entry = { deps, callback, cancelled: false };
            record.ctxInjections.push(deps);
            waiting.push(entry);
            flush();
            return () => {
                entry.cancelled = true;
            };
        },
        effect: (callback) => callback(),
        slots: {
            inject: (name, callback) => {
                record.injected.push(name);
                callback();
                return () => undefined;
            },
            register: (options, component) => {
                record.registered.push({ options, component });
                return () => undefined;
            },
        },
    };
    const provide = (name, value) => {
        registry.set(name, value);
        flush();
    };
    return { ctx, record, provide };
}

test('the bundle registers itself under its own plugin id', () => {
    const bundle = loadBundle();
    assert.equal(typeof bundle.exports.apply, 'function');
    assert.equal(typeof bundle.exports.RetryAllCard, 'function');
    assert.equal(typeof bundle.exports.parseMaxRetriesInput, 'function');
    assert.equal(typeof bundle.exports.resolvedMaxRetries, 'function');
    assert.equal(bundle.exports.CSS_TAG_ID, 'dsh-llm-retry-all/Card.css');
    // Dual-platform contract (2026-09-26): `settingsScope` is resolved optionally at
    // runtime and must NOT be declared — declaring a service dsh 0.1.7 no longer
    // provides fails the whole client boot ("N entry did not activate").
    assert.deepEqual(plain(bundle.exports.inject), ['slots']);
});

test('the card keeps the framework PluginCard DOM contract', () => {
    const bundle = loadBundle();
    const tree = renderCard(bundle);
    assert.equal(tree.type, 'li');
    assert.ok(classes(tree).includes('dsh-lra-card'));
    const header = find(tree, 'dsh-lra-header');
    assert.equal(header.type, 'button');
    assert.equal(header.props['aria-expanded'], false);
    assert.ok(find(header, 'dsh-lra-headText') !== undefined);
    assert.ok(find(header, 'dsh-lra-name') !== undefined);
    assert.ok(find(header, 'dsh-lra-description') !== undefined);
    assert.ok(find(header, 'dsh-lra-chevron') !== undefined);
});

test('a collapsed card renders no body; opening it reveals the retry input', () => {
    const bundle = loadBundle();
    const closed = renderCard(bundle);
    assert.equal(find(closed, 'dsh-lra-body'), undefined);
    // Click the header, then re-render: the state hook kept `open = true`.
    find(closed, 'dsh-lra-header').props.onClick();
    const opened = renderCard(bundle);
    const body = find(opened, 'dsh-lra-body');
    assert.ok(body !== undefined, 'the open card has no body');
    const input = find(body, 'dsh-lra-input');
    assert.ok(input !== undefined, 'the retry input was never rendered');
    assert.equal(input.props.type, 'number');
    assert.equal(input.props.value, '5');
});

test('the card is inert while the namespace is unavailable', () => {
    const bundle = loadBundle();
    const tree = renderCard(bundle, { snapshot: { status: 'unavailable' } });
    assert.equal(tree, null);
});

test('parseMaxRetriesInput answers an intent per input shape', () => {
    const { parseMaxRetriesInput } = loadBundle().exports;
    assert.deepEqual(plain(parseMaxRetriesInput('')), { kind: 'unset' });
    assert.deepEqual(plain(parseMaxRetriesInput('   ')), { kind: 'unset' });
    assert.deepEqual(plain(parseMaxRetriesInput('0')), { kind: 'set', value: 0 });
    assert.deepEqual(plain(parseMaxRetriesInput(' 12 ')), { kind: 'set', value: 12 });
    assert.deepEqual(plain(parseMaxRetriesInput('-1')), { kind: 'invalid' });
    assert.deepEqual(plain(parseMaxRetriesInput('2.5')), { kind: 'invalid' });
    assert.deepEqual(plain(parseMaxRetriesInput('abc')), { kind: 'invalid' });
    assert.deepEqual(plain(parseMaxRetriesInput('99999999999999999999')), { kind: 'invalid' });
});

test('resolvedMaxRetries folds the default in and never answers a negative', () => {
    const { resolvedMaxRetries } = loadBundle().exports;
    assert.equal(resolvedMaxRetries({}), 10000);
    assert.equal(resolvedMaxRetries(null), 10000);
    assert.equal(resolvedMaxRetries({ maxRetries: '7' }), 10000);
    assert.equal(resolvedMaxRetries({ maxRetries: 0 }), 0);
    assert.equal(resolvedMaxRetries({ maxRetries: 3.9 }), 3);
    assert.equal(resolvedMaxRetries({ maxRetries: -2 }), 0);
});

test('the 0.1.5 seat still binds the namespace and the slot key together', () => {
    // Community end, byte-for-byte unchanged: `settings.plugin.item` keyed by the
    // settings namespace the host half serves, bound through `settingsScope` — which is
    // already registered when apply runs, so the legacy transport wins immediately.
    const bundle = loadBundle();
    const { ctx, record } = fakeContext({
        settingsScope: {
            bind: (spec) => {
                record.bound = spec;
                return { getSnapshot: () => readySnapshot(), set: () => Promise.resolve(), unset: () => Promise.resolve() };
            },
        },
    });
    bundle.exports.apply(ctx);
    assert.deepEqual(plain(record.injected), ['settings.plugin.item']);
    assert.deepEqual(plain(record.bound), { namespace: 'dsh-llm-retry-all' });
    assert.equal(record.registered.length, 1);
    // A card dispatched under the wrong key would never render.
    assert.equal(record.registered[0].options.key, 'dsh-llm-retry-all');
    assert.equal(record.registered[0].component, bundle.exports.RetryAllCard);
    assert.equal(record.registered[0].options.inject().hooks.llmRetryAll.getSnapshot().status, 'ready');
});

test('a 0.1.7 runtime puts the card in the plugin manager keyed seat (the group only supplies the scope)', () => {
    // The regression this guards, in full. 0.1.7-rc.2 removed both the client service
    // `settingsScope` AND the `settings.plugin.item` seat (web-all 0.4.2: "alpha.2
    // removed the `settings.plugin.item` keyed seat of the `ui-settings-plugins` tab
    // … so a card keyed by its settings namespace has no seat to land in any more").
    // On this line the card belongs to the plugin manager's keyed seat, keyed by the
    // BUNDLE package name — the seat dsh-context's own card is served in — gated by
    // `whileServed` so a deployment that serves no form for this entry shows no dead card.
    // The Web UI group's `webUiSettings` binder is only preferred as the scope SOURCE.
    const bundle = loadBundle();
    const served = [];
    const scope = {
        getSnapshot: () => readySnapshot(),
        set: () => Promise.resolve(),
        unset: () => Promise.resolve(),
    };
    const { ctx, record } = fakeContext({
        // `configForms` is 0.1.7's value service and is the 0.1.7-line signal; no 0.1.5
        // package mentions it.
        webUiSettings: { bind: (spec) => { record.bound = spec; return scope; } },
        configForms: {
            get: () => scope,
            whileServed: (ids, callback) => { served.push(ids); callback(); return () => undefined; },
        },
    });
    bundle.exports.apply(ctx);
    assert.deepEqual(plain(record.injected), ['plugins.bundle.config']);
    assert.deepEqual(plain(record.bound), { namespace: 'dsh-llm-retry-all' });
    assert.equal(record.registered.length, 1);
    assert.equal(record.registered[0].component, bundle.exports.RetryAllCard);
    assert.equal(record.registered[0].options.key, 'dsh-llm-retry-all');
    assert.ok(served.length === 1 && served[0].includes('llm-retry-all'));
});

test('a 0.1.7 runtime without the group binds the native shared form and keeps the keyed seat', () => {
    // A deployment that ships 0.1.7 without dsh-web-settings: same seat, but the scope now
    // comes from the native shared form, resolved by ENTRY ID (on that line the served
    // namespace IS the entry id), and only once the host actually serves it.
    const bundle = loadBundle();
    const served = [];
    const gets = [];
    const { ctx, record } = fakeContext({
        configForms: {
            get: (id) => {
                gets.push(id);
                return id === 'llm-retry-all'
                    ? { getSnapshot: () => readySnapshot(), set: () => Promise.resolve(), unset: () => Promise.resolve() }
                    : undefined;
            },
            whileServed: (ids, callback) => { served.push(ids); callback(); return () => undefined; },
        },
    });
    bundle.exports.apply(ctx);
    assert.equal(record.registered.length, 1);
    assert.equal(record.registered[0].options.name, 'plugins.bundle.config');
    assert.equal(record.registered[0].options.key, 'dsh-llm-retry-all');
    assert.ok(gets.includes('llm-retry-all'), 'the native form was never resolved by entry id');
    assert.equal(served.length, 1);
    assert.ok(served[0].includes('llm-retry-all'));
});

test('settings services arriving AFTER apply still mount the card (real page ordering)', () => {
    // The diagnosed real-page failure: `slots` is up long before the settings services,
    // so apply() ran while all three transports were still absent, the old synchronous
    // lookup returned undefined, and the card was never registered — the page had our
    // CSS (module-load-time) and no card. Deferred injection mounts the card the moment
    // a transport registers instead.
    const bundle = loadBundle();
    const served = [];
    const scope = {
        getSnapshot: () => readySnapshot(),
        set: () => Promise.resolve(),
        unset: () => Promise.resolve(),
    };
    const { ctx, record, provide } = fakeContext();
    bundle.exports.apply(ctx);
    assert.equal(record.registered.length, 0, 'apply itself must not register anything yet');
    assert.deepEqual(plain(record.ctxInjections), [['settingsScope'], ['webUiSettings'], ['configForms']]);
    provide('configForms', {
        get: () => scope,
        whileServed: (ids, callback) => { served.push(ids); callback(); return () => undefined; },
    });
    assert.equal(record.registered.length, 1, 'a late configForms is enough to mount the keyed seat');
    assert.equal(record.registered[0].options.name, 'plugins.bundle.config');
    assert.equal(record.registered[0].options.key, 'dsh-llm-retry-all');
    // The family binder arriving afterwards must not add a second card.
    provide('webUiSettings', { bind: () => scope });
    assert.equal(record.registered.length, 1, 'the single latch must hold');
});

test('a late-arriving settingsScope still mounts on the community seat', () => {
    const bundle = loadBundle();
    const { ctx, record, provide } = fakeContext();
    bundle.exports.apply(ctx);
    assert.equal(record.registered.length, 0);
    provide('settingsScope', { bind: () => ({ getSnapshot: () => readySnapshot(), set: () => Promise.resolve() }) });
    assert.equal(record.registered.length, 1);
    assert.equal(record.registered[0].options.name, 'settings.plugin.item');
    assert.equal(record.registered[0].options.key, 'dsh-llm-retry-all');
});

test('a composition without any settings transport stays active and registers nothing', () => {
    // Neither `webUiSettings` nor `settingsScope` present. apply() must not throw and the
    // entry must not stay pending, or the whole web boot fails with
    // "web boot: N entry did not activate".
    const bundle = loadBundle();
    const injected = [];
    const ctx = {
        get: () => undefined,
        inject: () => () => undefined,
        slots: {
            inject: (name) => { injected.push(name); },
            register: () => { throw new Error('no card may be registered without a settings transport'); },
        },
    };
    assert.equal(bundle.exports.apply(ctx), undefined);
    assert.deepEqual(injected, []);
});

test('a no-op write never reaches the wire', async () => {
    // The host treats an unchanged raw section as completely invisible (no persist,
    // no watcher, no log), so submitting one reads as a dead control.
    const bundle = loadBundle();
    const calls = [];
    const closed = renderCard(bundle, {
        snapshot: readySnapshot({ maxRetries: 5 }, { maxRetries: 5 }),
        setMaxRetries: (intent) => { calls.push(intent); return Promise.resolve(); },
    });
    find(closed, 'dsh-lra-header').props.onClick();
    const opened = renderCard(bundle, {
        snapshot: readySnapshot({ maxRetries: 5 }, { maxRetries: 5 }),
        setMaxRetries: (intent) => { calls.push(intent); return Promise.resolve(); },
    });
    find(opened, 'dsh-lra-input').props.onBlur();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(plain(calls), []);
});

test('a committed write reaches the injected writer with the parsed intent', async () => {
    const bundle = loadBundle();
    const calls = [];
    const closed = renderCard(bundle, {
        snapshot: readySnapshot({ maxRetries: 5 }, {}),
        setMaxRetries: (intent) => { calls.push(intent); return Promise.resolve(); },
    });
    find(closed, 'dsh-lra-header').props.onClick();
    const opened = renderCard(bundle, {
        snapshot: readySnapshot({ maxRetries: 5 }, {}),
        setMaxRetries: (intent) => { calls.push(intent); return Promise.resolve(); },
    });
    find(opened, 'dsh-lra-input').props.onBlur();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(plain(calls), [{ kind: 'set', value: 5 }]);
});

test('a rejected write names itself in the console instead of vanishing', async () => {
    const bundle = loadBundle();
    const closed = renderCard(bundle, {
        snapshot: readySnapshot({ maxRetries: 5 }, {}),
        setMaxRetries: () => Promise.reject(new Error('host refused')),
    });
    find(closed, 'dsh-lra-header').props.onClick();
    const opened = renderCard(bundle, {
        snapshot: readySnapshot({ maxRetries: 5 }, {}),
        setMaxRetries: () => Promise.reject(new Error('host refused')),
    });
    find(opened, 'dsh-lra-input').props.onBlur();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(bundle.errors().some((line) => line.includes('settings write failed: host refused')),
        'a rejected write must name itself in the console');
});

test('the card chrome mirrors the framework card tokens', () => {
    const css = loadBundle().css();
    assert.match(css, /\.dsh-lra-card\{border:\.5px solid var\(--dsw-alias-border-l4\);background:var\(--dsw-alias-bg-layer-3\)/);
    assert.match(css, /border-radius:16px/);
    assert.match(css, /\.dsh-lra-field\{flex-direction:column;gap:6px;padding:12px 0;display:flex\}/);
    for (const name of classes(renderCard(loadBundle()))) {
        if (!name.startsWith('dsh-lra-')) continue;
        assert.ok(css.includes(`.${name}{`) || css.includes(`.${name}:`) || css.includes(`.${name},`),
            `class ${name} is emitted but never styled`);
    }
});
