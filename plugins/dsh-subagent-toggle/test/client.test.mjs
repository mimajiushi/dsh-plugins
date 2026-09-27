/**
 * Client-half contract tests for dsh-subagent-toggle.
 *
 * These load the REAL `lib/client.js` bundle through a `node:vm` sandbox and
 * drive it with a hand-written React double whose hooks actually run. There is
 * no jsdom on this machine, so the suite pins the contracts that matter:
 *
 *  1. The card keeps the framework `PluginCard` DOM contract
 *     (`li.card > button.header + div.body`) — visual parity with the
 *     neighbouring cards depends on those exact hooks.
 *  2. The toggle writes through `scope.set` and verifies against the RAW user
 *     layer, because scope writes never reject (a host refusal is recovered
 *     silently). A bare `.catch(() => undefined)` is forbidden at source level.
 *  3. The slot registration binds `settings.plugin.item` to the exact
 *     namespace key the host half serves.
 *
 * @module dsh-subagent-toggle/test/client
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
 * Find the first element whose `type` is `type` (a component reference).
 * Elements are never invoked by this harness — the Switch double included —
 * so component props are read off the element itself.
 * @param node - rendered tree.
 * @param type - the component reference to match.
 * @returns the element, or undefined.
 */
function findType(node, type) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findType(child, type);
            if (hit !== undefined) return hit;
        }
        return undefined;
    }
    if (node.type === type) return node;
    return findType(node.props === undefined ? undefined : node.props.children, type);
}

/**
 * Load the client bundle in a sandbox.
 * @returns `{ exports, css, errors, Switch, resetSlots }`.
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
        // Stand-in for the framework Switch: fully controlled, `onChange`
        // receives the state the click asks for. Never invoked by this
        // harness — tests read the element's props directly.
        Switch: (props) => jsx('button', { className: 'Switch', ...props }),
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
        Switch: primitives.Switch,
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
 * @returns `{ ctx, record, scoped, provide }`.
 */
function fakeContext(services = {}) {
    const registry = new Map(Object.entries(services));
    const waiting = [];
    const record = { ctxInjections: [], injected: [], registered: [], whileServed: [] };
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
    return { ctx, record, scoped, provide };
}

/** A ready snapshot; `value` is the resolved section, `user` the raw layer. */
function readySnapshot(enabled, user = {}) {
    return { status: 'ready', writable: true, value: { enabled }, user };
}

/**
 * Render the card once.
 * @param options - `{ snapshot, setEnabled }` overrides.
 * @returns `{ tree, bundle }`.
 */
function renderCard(bundle, options = {}) {
    const snapshot = options.snapshot ?? readySnapshot(true);
    bundle.resetSlots();
    const tree = bundle.exports.SubagentToggleCard({
        useSubagentToggle: () => snapshot,
        setEnabled: options.setEnabled ?? (() => Promise.resolve()),
    });
    return tree;
}

test('the bundle registers itself under its own plugin id', () => {
    const bundle = loadBundle();
    assert.equal(typeof bundle.exports.apply, 'function');
    assert.equal(bundle.exports.SETTINGS_NS, 'dsh-subagent-toggle');
    assert.equal(bundle.exports.ENABLED_FIELD, 'enabled');
    // Dual-platform contract (2026-09-26): `settingsScope` is resolved optionally at
    // runtime and must NOT be declared — declaring a service dsh 0.1.7 no longer
    // provides fails the whole client boot ("N entry did not activate").
    assert.deepEqual(plain(bundle.exports.inject), ['slots']);
});

test('the card keeps the framework PluginCard DOM contract', () => {
    const bundle = loadBundle();
    const tree = renderCard(bundle);
    assert.equal(tree.type, 'li');
    assert.ok(classes(tree).includes('dsh-sat-card'));
    const header = find(tree, 'dsh-sat-header');
    assert.equal(header.type, 'button');
    assert.equal(header.props['aria-expanded'], false);
    assert.ok(find(header, 'dsh-sat-headText') !== undefined);
    assert.ok(find(header, 'dsh-sat-name') !== undefined);
    assert.ok(find(header, 'dsh-sat-description') !== undefined);
    assert.ok(find(header, 'dsh-sat-chevron') !== undefined);
});

test('a collapsed card renders no body; opening it reveals the switch', () => {
    const bundle = loadBundle();
    const closed = renderCard(bundle);
    assert.equal(find(closed, 'dsh-sat-body'), undefined);
    // Click the header, then re-render: the state hook kept `open = true`.
    find(closed, 'dsh-sat-header').props.onClick();
    const opened = renderCard(bundle);
    const body = find(opened, 'dsh-sat-body');
    assert.ok(body !== undefined, 'the open card has no body');
    assert.ok(find(body, 'dsh-sat-toggleRow') !== undefined);
    const toggle = findType(opened, bundle.Switch);
    assert.ok(toggle !== undefined, 'the Switch primitive was never rendered');
    assert.equal(toggle.props.checked, true);
});

test('the switch reflects the OFF state', () => {
    const bundle = loadBundle();
    const closed = renderCard(bundle, { snapshot: readySnapshot(false, { enabled: false }) });
    find(closed, 'dsh-sat-header').props.onClick();
    const opened = renderCard(bundle, { snapshot: readySnapshot(false, { enabled: false }) });
    const toggle = findType(opened, bundle.Switch);
    assert.ok(toggle !== undefined, 'the Switch primitive was never rendered');
    assert.equal(toggle.props.checked, false);
});

test('the card is inert while the namespace is unavailable', () => {
    const bundle = loadBundle();
    const tree = renderCard(bundle, { snapshot: { status: 'unavailable' } });
    assert.equal(tree, null);
});

test('readEnabled is ON unless the resolved section explicitly says false', () => {
    const { readEnabled } = loadBundle().exports;
    assert.equal(readEnabled(undefined), true);
    assert.equal(readEnabled(null), true);
    assert.equal(readEnabled(readySnapshot(true)), true);
    assert.equal(readEnabled({ status: 'ready', value: {} }), true);
    assert.equal(readEnabled(readySnapshot(false)), false);
});

test('every class the card emits is one the stylesheet defines', () => {
    const bundle = loadBundle();
    const closed = renderCard(bundle);
    find(closed, 'dsh-sat-header').props.onClick();
    const opened = renderCard(bundle);
    const css = bundle.css();
    for (const name of classes(opened)) {
        // Class names introduced by foreign components (the Switch double) are not ours.
        if (!name.startsWith('dsh-sat-')) continue;
        assert.ok(css.includes(`.${name}{`) || css.includes(`.${name}:`) || css.includes(`.${name},`),
            `class ${name} is emitted but never styled`);
    }
});

test('the register contract binds the namespace and the slot key together', () => {
    // 0.1.5 with the scope service already registered: the legacy transport wins and
    // lands the card on the community shell's own seat, keyed by the namespace.
    const bundle = loadBundle();
    let bound;
    const scope = { options: undefined, getSnapshot: () => readySnapshot(true) };
    const { ctx, record } = fakeContext({
        settingsScope: {
            bind: (options) => {
                bound = options;
                return { options, getSnapshot: scope.getSnapshot };
            },
        },
    });
    bundle.exports.apply(ctx);
    assert.deepEqual(plain(record.injected), ['settings.plugin.item']);
    assert.equal(record.registered.length, 1);
    // A card dispatched under the wrong key would never render.
    assert.equal(record.registered[0].options.key, bundle.exports.SETTINGS_NS);
    assert.equal(record.registered[0].component, bundle.exports.SubagentToggleCard);
    assert.deepEqual(plain(bound), { namespace: bundle.exports.SETTINGS_NS });
    assert.equal(record.registered[0].options.inject().hooks.subagentToggle.options.namespace,
        bundle.exports.SETTINGS_NS);
});

test('a 0.1.7 runtime puts the card in the plugin manager keyed seat (the group only supplies the scope)', () => {
    // The regression this guards, in full. 0.1.7-rc.2 removed both the client service
    // `settingsScope` AND the `settings.plugin.item` seat (web-all 0.4.2: "alpha.2
    // removed the `settings.plugin.item` keyed seat of the `ui-settings-plugins` tab
    // … so a card keyed by its settings namespace has no seat to land in any more").
    // On this line the card belongs to the plugin manager's keyed seat, keyed by the
    // BUNDLE package name — the seat dsh-context's own card is served in — and is gated by
    // `whileServed` so a deployment that serves no form for this entry shows no dead card.
    // The Web UI group's `webUiSettings` binder is only preferred as the scope SOURCE; the
    // group's own list seat renders no third-party card on the official desktop.
    const bundle = loadBundle();
    let bound;
    const served = [];
    const scope = { getSnapshot: () => ({ status: 'ready', user: { enabled: true } }) };
    const { ctx, record } = fakeContext({
        // `configForms` is 0.1.7's value service and is the 0.1.7-line signal; no 0.1.5
        // package mentions it.
        webUiSettings: { bind: (spec) => { bound = spec; return scope; } },
        configForms: {
            get: () => scope,
            whileServed: (ids, callback) => { served.push(ids); callback(); return () => undefined; },
        },
    });
    bundle.exports.apply(ctx);
    assert.deepEqual(plain(record.injected), ['plugins.bundle.config']);
    assert.equal(record.registered.length, 1);
    assert.deepEqual(plain(bound), { namespace: bundle.exports.SETTINGS_NS });
    assert.equal(record.registered[0].component, bundle.exports.SubagentToggleCard);
    assert.equal(record.registered[0].options.key, 'dsh-subagent-toggle');
    assert.ok(served.length === 1 && served[0].includes('subagent-toggle'));
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
                return id === 'subagent-toggle'
                    ? { getSnapshot: () => ({ status: 'ready', user: {} }), set: () => Promise.resolve() }
                    : undefined;
            },
            whileServed: (ids, callback) => { served.push(ids); callback(); return () => undefined; },
        },
    });
    bundle.exports.apply(ctx);
    assert.equal(record.registered.length, 1);
    assert.equal(record.registered[0].options.name, 'plugins.bundle.config');
    assert.equal(record.registered[0].options.key, 'dsh-subagent-toggle');
    assert.ok(gets.includes('subagent-toggle'), 'the native form was never resolved by entry id');
    assert.ok(served.length === 1 && served[0].includes('subagent-toggle'));
});

test('settings services arriving AFTER apply still mount the card (real page ordering)', () => {
    // The diagnosed real-page failure: `slots` is up long before the settings services,
    // so apply() ran while all three transports were still absent, the old synchronous
    // lookup returned undefined, and the card was never registered — the page had our
    // CSS (module-load-time) and no card. Deferred injection mounts the card the moment
    // a transport registers instead.
    const bundle = loadBundle();
    // The native form must be a full snapshot source: `firstUsableForm` only accepts a
    // candidate that carries both `getSnapshot` and `set`.
    const scope = { getSnapshot: () => ({ status: 'ready', user: {} }), set: () => Promise.resolve() };
    const served = [];
    const { ctx, record, provide } = fakeContext();
    bundle.exports.apply(ctx);
    assert.equal(record.registered.length, 0, 'apply itself must not register anything yet');
    assert.deepEqual(plain(record.ctxInjections),
        [['settingsScope'], ['webUiSettings'], ['configForms']]);
    provide('configForms', {
        get: () => scope,
        whileServed: (ids, callback) => { served.push(ids); callback(); return () => undefined; },
    });
    assert.equal(record.registered.length, 1, 'a late configForms is enough to mount the keyed seat');
    assert.equal(record.registered[0].options.name, 'plugins.bundle.config');
    assert.equal(record.registered[0].options.key, 'dsh-subagent-toggle');
    // The family binder arriving afterwards must not add a second card.
    provide('webUiSettings', { bind: () => scope });
    assert.equal(record.registered.length, 1, 'the single latch must hold');
});

test('a late-arriving settingsScope still mounts on the community seat', () => {
    const bundle = loadBundle();
    const scope = { getSnapshot: () => ({ status: 'ready', user: {} }) };
    const { ctx, record, provide } = fakeContext();
    bundle.exports.apply(ctx);
    assert.equal(record.registered.length, 0);
    provide('settingsScope', { bind: () => scope });
    assert.equal(record.registered.length, 1);
    assert.equal(record.registered[0].options.name, 'settings.plugin.item');
    assert.equal(record.registered[0].options.key, bundle.exports.SETTINGS_NS);
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
    bundle.runTimers();
    assert.deepEqual(injected, []);
});

/**
 * Drive `apply` with a controllable scope and return the injected `setEnabled`.
 * @param scope - the fake settings scope.
 * @returns the injected writer.
 */
function writerFor(bundle, scope) {
    const { ctx, record } = fakeContext({ settingsScope: { bind: () => scope } });
    bundle.exports.apply(ctx);
    return record.registered[0].options.inject().setEnabled;
}

test('setEnabled writes the boolean and verifies it on the RAW user layer', async () => {
    const bundle = loadBundle();
    const calls = [];
    let user = {};
    const scope = {
        getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: user.enabled !== false }, user }),
        set: (field, value) => {
            calls.push(['set', field, value]);
            user = { ...user, [field]: value };
            return Promise.resolve();
        },
    };
    const setEnabled = writerFor(bundle, scope);
    await setEnabled(false);
    assert.deepEqual(plain(calls), [['set', 'enabled', false]]);
    await setEnabled(true);
    assert.deepEqual(plain(calls), [['set', 'enabled', false], ['set', 'enabled', true]]);
});

test('a no-op write never reaches the wire', async () => {
    // The host treats an unchanged raw section as completely invisible (no
    // persist, no watcher, no log), so submitting one reads as a dead control.
    const bundle = loadBundle();
    const calls = [];
    const user = {};
    const scope = {
        getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true }, user }),
        set: (field, value) => {
            calls.push(['set', field, value]);
            return Promise.resolve();
        },
    };
    const setEnabled = writerFor(bundle, scope);
    await setEnabled(true);
    assert.deepEqual(plain(calls), []);
});

test('a write the host silently refused rejects instead of resolving', async () => {
    // Scope writes NEVER reject: on a refusal the controller re-reads the
    // mirror and resolves. The user layer then simply lacks the key — so the
    // card must compare, not trust the promise.
    const bundle = loadBundle();
    const user = {};
    const scope = {
        getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true }, user }),
        set: () => Promise.resolve(), // "accepted", but nothing was stored
    };
    const setEnabled = writerFor(bundle, scope);
    await assert.rejects(() => setEnabled(false), /宿主拒绝了这次写入/);
});

test('a failed write can never be swallowed silently', () => {
    // Source-level guard: the anti-pattern that made a sibling plugin's
    // "the click did nothing" undiagnosable was `.catch(() => undefined)`.
    const source = readFileSync(BUNDLE, 'utf8');
    assert.doesNotMatch(source, /\.catch\(\(\)\s*=>\s*undefined\)/,
        'a bare .catch(() => undefined) hides a failed write again');
    assert.match(source, /settings write failed:/,
        'a rejected write must name itself in the console');
    assert.match(source, /missing injected seat:/,
        'a missing injected writer must report instead of returning silently');
    assert.match(source, /typeof props\.setEnabled !== 'function'/, 'setEnabled lost its guard');
});

test('the card chrome mirrors the framework card tokens', () => {
    const css = loadBundle().css();
    assert.match(css, /\.dsh-sat-card\{border:\.5px solid var\(--dsw-alias-border-l4\);background:var\(--dsw-alias-bg-layer-3\)/);
    assert.match(css, /border-radius:16px/);
    // Toggle row mirrors SubagentModelSelectionCard's layout.
    assert.match(css, /\.dsh-sat-toggleRow\{[^}]*justify-content:space-between/);
    assert.match(css, /\.dsh-sat-toggleLabel\{flex:1;min-width:0\}/);
});
