/**
 * Client-half contract tests for dsh-compact-model.
 *
 * These load the REAL `lib/client.js` bundle through a `node:vm` sandbox and
 * drive it with a hand-written React double whose hooks actually run. That
 * combination is deliberate: there is no jsdom on this machine, and no Node-side
 * DOM can compute flexbox layout anyway -- so instead of pretending to measure
 * the broken layout, this suite pins the *rules that produced it*:
 *
 *  1. The `Menu` wrapper (`.dsh-pcm-fieldValue`) must be a growing flex item and
 *     the anchor inside it must fill that width. The original bug was a
 *     `flex:none` button inside `Menu`'s `display:inline-flex` root, which is
 *     shrink-to-fit, so the control collapsed to a few pixels and its label was
 *     clipped away by `overflow:hidden`. Both halves are asserted below; either
 *     one regressing brings the broken UI back.
 *  2. The card must keep the framework's `PluginCard` DOM contract
 *     (`li.card > button.header + div.body`), because visual parity with the
 *     neighbouring cards depends on those exact hooks.
 *
 * @module dsh-compact-model/test/client
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/**
 * Copy a value out of the sandbox realm.
 *
 * Values the bundle builds are created by the vm realm's own constructors, so
 * their prototypes differ from this realm's and `assert.deepStrictEqual` refuses
 * them even when the contents match ("same structure but not reference-equal").
 * A JSON round-trip normalises both sides.
 *
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
 *
 * `stateful` controls whether `useState` keeps its slot between renders, which
 * is what lets a test open the accordion and inspect the body.
 *
 * @returns `{ exports, css, errors, setState }`.
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
        // Stand-in for the framework Menu: the real one wraps its anchor in
        // `<span class="root" style="display:inline-flex">`. The wrapper class the
        // plugin hands over is what the layout rules hang off, so it is reproduced.
        Menu: (props) => jsx('span', { className: 'MenuRoot', children: props.anchor }),
        Button: (props) => jsx('button', props),
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
 * dependency is registered. Values are exposed on the scoped context BOTH as
 * `scoped.get(name)` and as a scoped property (`scoped['remote.session']`), the way the
 * runtime's injected child context exposes them.
 *
 * @param services - services already registered, keyed by service name.
 * @returns `{ ctx, record, provide }`.
 */
function fakeContext(services = {}) {
    const registry = new Map(Object.entries(services));
    const waiting = [];
    const record = { ctxInjections: [], injected: [], registered: [], whileServed: [] };
    const scoped = () => {
        const target = { get: (name) => registry.get(name) };
        for (const [name, value] of registry) target[name] = value;
        return target;
    };
    const flush = () => {
        for (const entry of waiting.splice(0)) {
            if (entry.cancelled) continue;
            if (!entry.deps.every((name) => registry.get(name) !== undefined)) waiting.push(entry);
            else entry.callback(scoped());
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

/** The settings section value the card reads back. */
const pinnedSection = { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'high' };

/**
 * Render the card once.
 * @param options - `{ snapshot, catalog, hooks }` overrides.
 * @returns `{ tree, bundle }`.
 */
function renderCard(options = {}) {
    const bundle = loadBundle();
    const { CompactModelCard, FOLLOW } = bundle.exports;
    const snapshot = options.snapshot ?? { status: 'ready', writable: true, value: pinnedSection };
    bundle.resetSlots();
    const tree = CompactModelCard({
        useCompactModel: () => snapshot,
        remoteSession: options.remoteSession,
        setRoute: options.setRoute ?? (() => Promise.resolve()),
        setEffort: options.setEffort ?? (() => Promise.resolve()),
    });
    return { tree, bundle, FOLLOW };
}

test('the bundle registers itself under its own plugin id', () => {
    const bundle = loadBundle();
    assert.equal(typeof bundle.exports.apply, 'function');
    assert.equal(bundle.exports.SETTINGS_NS, 'dsh-compact-model');
    // Dual-platform contract (2026-09-26): `settingsScope` is resolved optionally at
    // runtime and must NOT be declared — declaring a service dsh 0.1.7 no longer
    // provides fails the whole client boot ("N entry did not activate").
    assert.deepEqual(plain(bundle.exports.inject), ['slots']);
});

test('the card keeps the framework PluginCard DOM contract', () => {
    const { tree } = renderCard();
    assert.equal(tree.type, 'li');
    assert.ok(classes(tree).includes('dsh-pcm-card'));
    const header = find(tree, 'dsh-pcm-header');
    assert.equal(header.type, 'button');
    assert.equal(header.props['aria-expanded'], false);
    // Header text is the same two-span stack the core cards use.
    assert.ok(find(header, 'dsh-pcm-headText') !== undefined);
    assert.ok(find(header, 'dsh-pcm-name') !== undefined);
    assert.ok(find(header, 'dsh-pcm-description') !== undefined);
    assert.ok(find(header, 'dsh-pcm-chevron') !== undefined);
});

test('a collapsed card renders no body', () => {
    const { tree } = renderCard();
    assert.equal(find(tree, 'dsh-pcm-body'), undefined);
});

test('the card is inert while the namespace is unavailable', () => {
    const { tree } = renderCard({ snapshot: { status: 'unavailable' } });
    assert.equal(tree, null);
});

test('the card reads no service off a context that has none of them', () => {
    // The settings namespace is bound through `inject`, so a card rendered with
    // nothing but its own props must already be fully functional.
    const { tree } = renderCard();
    assert.ok(classes(tree).length > 0);
});

test('the register contract binds the namespace and the slot key together', () => {
    // 0.1.5 with the scope service already registered: the legacy transport wins and
    // lands the card on the community shell's own seat, keyed by the namespace.
    const bundle = loadBundle();
    let bound;
    const catalog = { modelCatalog: () => Promise.resolve({ ok: true, value: {} }) };
    const { ctx, record } = fakeContext({
        settingsScope: {
            bind: (options) => {
                bound = options;
                return { options, getSnapshot: () => ({ status: 'ready' }) };
            },
        },
        'remote.session': catalog,
    });
    bundle.exports.apply(ctx);
    assert.deepEqual(plain(record.injected), ['settings.plugin.item']);
    assert.equal(record.registered.length, 1);
    // A card dispatched under the wrong key would never render.
    assert.equal(record.registered[0].options.key, bundle.exports.SETTINGS_NS);
    assert.equal(record.registered[0].component, bundle.exports.CompactModelCard);
    assert.deepEqual(plain(bound), { namespace: bundle.exports.SETTINGS_NS });
    const face = record.registered[0].options.inject();
    assert.equal(face.hooks.compactModel.options.namespace, bundle.exports.SETTINGS_NS);
    assert.equal(face.remoteSession, catalog);
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
    let bound;
    const served = [];
    const scope = {
        getSnapshot: () => ({ status: 'ready' }),
        set: () => Promise.resolve(),
        unset: () => Promise.resolve(),
    };
    const { ctx, record } = fakeContext({
        // `configForms` is 0.1.7's value service and is the 0.1.7-line signal; no 0.1.5
        // package mentions it.
        webUiSettings: { bind: (spec) => { bound = spec; return scope; } },
        configForms: {
            get: () => scope,
            whileServed: (ids, callback) => { served.push(ids); callback(); return () => undefined; },
        },
        'remote.session': { modelCatalog: () => Promise.resolve({ ok: true, value: {} }) },
    });
    bundle.exports.apply(ctx);
    assert.deepEqual(plain(record.injected), ['plugins.bundle.config']);
    assert.equal(record.registered.length, 1);
    assert.deepEqual(plain(bound), { namespace: bundle.exports.SETTINGS_NS });
    assert.equal(record.registered[0].component, bundle.exports.CompactModelCard);
    assert.equal(record.registered[0].options.key, 'dsh-compact-model');
    assert.ok(served.length === 1 && served[0].includes('compact-model'));
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
                return id === 'compact-model'
                    ? { getSnapshot: () => ({ status: 'ready', user: {} }), set: () => Promise.resolve() }
                    : undefined;
            },
            whileServed: (ids, callback) => { served.push(ids); callback(); return () => undefined; },
        },
        'remote.session': { modelCatalog: () => Promise.resolve({ ok: true, value: {} }) },
    });
    bundle.exports.apply(ctx);
    assert.equal(record.registered.length, 1);
    assert.equal(record.registered[0].options.name, 'plugins.bundle.config');
    assert.equal(record.registered[0].options.key, 'dsh-compact-model');
    assert.ok(gets.includes('compact-model'), 'the native form was never resolved by entry id');
    assert.ok(served.length === 1 && served[0].includes('compact-model'));
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
    const scope = { getSnapshot: () => ({ status: 'ready' }), set: () => Promise.resolve() };
    const served = [];
    const { ctx, record, provide } = fakeContext();
    bundle.exports.apply(ctx);
    assert.equal(record.registered.length, 0, 'apply itself must not register anything yet');
    assert.deepEqual(plain(record.ctxInjections),
        [['remote.session'], ['settingsScope'], ['webUiSettings'], ['configForms']]);
    provide('configForms', {
        get: () => scope,
        whileServed: (ids, callback) => { served.push(ids); callback(); return () => undefined; },
    });
    assert.equal(record.registered.length, 1, 'a late configForms is enough to mount the keyed seat');
    assert.equal(record.registered[0].options.name, 'plugins.bundle.config');
    assert.equal(record.registered[0].options.key, 'dsh-compact-model');
    // The family binder arriving afterwards must not add a second card.
    provide('webUiSettings', { bind: () => scope });
    assert.equal(record.registered.length, 1, 'the single latch must hold');
});

test('a late-arriving settingsScope still mounts on the community seat', () => {
    const bundle = loadBundle();
    const scope = { getSnapshot: () => ({ status: 'ready' }) };
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
});

test('the menu wrapper is a growing flex item and the anchor fills it', () => {
    // The regression this suite exists for. `Menu`'s root is inline-flex, i.e.
    // shrink-to-fit, and its width comes from the wrapper the plugin hands it.
    // `display:inline-flex` here would re-introduce the collapse: a shrink-to-fit
    // wrapper feeds the button an indefinite width, every child then sizes to
    // content, and the label is clipped away to nothing.
    const css = loadBundle().css();
    const value = /\.dsh-pcm-fieldValue\{([^}]*)\}/.exec(css);
    assert.ok(value !== null, '.dsh-pcm-fieldValue rule is missing');
    assert.match(value[1], /display:flex/);
    assert.doesNotMatch(value[1], /display:inline-flex/);
    assert.match(value[1], /min-width:0/);
    assert.match(value[1], /width:100%/);

    const select = /\.dsh-pcm-select\{([^}]*)\}/.exec(css);
    assert.ok(select !== null, '.dsh-pcm-select rule is missing');
    assert.match(select[1], /width:100%/);
    assert.match(select[1], /min-width:0/);
    // `flex:none` is exactly what collapsed the control.
    assert.doesNotMatch(select[1], /flex:none/);
});

test('the label is clipped with an ellipsis rather than hidden outright', () => {
    const css = loadBundle().css();
    const text = /\.dsh-pcm-selectText\{([^}]*)\}/.exec(css);
    assert.ok(text !== null, '.dsh-pcm-selectText rule is missing');
    assert.match(text[1], /text-overflow:ellipsis/);
    assert.match(text[1], /white-space:nowrap/);
});

test('the field chrome mirrors the framework field tokens', () => {
    const css = loadBundle().css();
    assert.match(css, /\.dsh-pcm-field\{flex-direction:column;gap:6px;padding:12px 0;display:flex\}/);
    assert.match(css, /\.dsh-pcm-field\+\.dsh-pcm-field\{border-top:\.5px solid var\(--dsw-alias-border-l2\)\}/);
    // Card chrome must use the same design tokens as the neighbouring cards.
    assert.match(css, /\.dsh-pcm-card\{border:\.5px solid var\(--dsw-alias-border-l4\);background:var\(--dsw-alias-bg-layer-3\)/);
    assert.match(css, /border-radius:16px/);
    // The card must not paint its own invented chrome any more.
    assert.doesNotMatch(css, /dsw-specific-input-major/);
});

test('the style tag is tagged so a hot reload replaces rather than stacks it', () => {
    const bundle = loadBundle();
    assert.equal(bundle.exports.CSS_TAG_ID, 'dsh-compact-model/Card.css');
    assert.ok(bundle.css().length > 0);
});

test('readCatalog flattens the remote envelope', () => {
    const { readCatalog } = loadBundle().exports;
    const catalog = readCatalog({
        ok: true,
        value: {
            routableProviders: ['deepseek'],
            failures: [{ provider: 'x' }],
            groups: [
                { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat', reasoning: { efforts: [{ id: 'high' }, { id: 'off' }] } }] },
                { id: 'kimi-coding', name: '', models: [{ id: 'k3' }] },
            ],
        },
    });
    assert.deepEqual(plain(catalog.providers), [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'kimi-coding', name: 'kimi-coding' },
    ]);
    assert.deepEqual(plain(catalog.models.get('deepseek')), [{ id: 'chat', name: 'Chat', efforts: ['high', 'off'] }]);
    assert.deepEqual(plain(catalog.models.get('kimi-coding')), [{ id: 'k3', name: 'k3', efforts: [] }]);
    assert.deepEqual(plain(catalog.routable), ['deepseek']);
    assert.equal(catalog.failures, 1);
    assert.equal(catalog.loaded, true);
});

test('readCatalog never throws on a hostile envelope', () => {
    const { readCatalog } = loadBundle().exports;
    // Envelopes that carry no usable group at all.
    for (const input of [null, undefined, {}, { ok: false }, { ok: true, value: null },
        { ok: true, value: { groups: 'no' } }, { ok: true, value: { groups: [null, 7, { models: [] }] } }]) {
        const catalog = readCatalog(input);
        assert.equal(catalog.loaded, false);
        assert.deepEqual(plain(catalog.routable), []);
        assert.equal(catalog.failures, 0);
    }
});

test('readCatalog keeps a named group even when its model rows are junk', () => {
    const { readCatalog } = loadBundle().exports;
    const catalog = readCatalog({ ok: true, value: { groups: [{ id: 'p', models: [null, {}, { id: 5 }] }] } });
    // The provider itself is real and selectable, so the card must offer it.
    assert.deepEqual(plain(catalog.providers), [{ id: 'p', name: 'p' }]);
    assert.equal(catalog.loaded, true);
    // Rows without a string id are dropped rather than rendered as blanks.
    assert.deepEqual(plain(catalog.models.get('p')), []);
});

test('readCatalog counts only groups that actually became providers', () => {
    const { readCatalog } = loadBundle().exports;
    // A group with no usable id yields no selectable provider. Treating the reply
    // as "loaded" here would leave every dropdown empty with no warning at all.
    const unusable = readCatalog({ ok: true, value: { groups: [{ models: [] }, { id: '', models: [] }] } });
    assert.equal(unusable.loaded, false);
    assert.deepEqual(plain(unusable.providers), []);
    // One usable provider is enough.
    assert.equal(readCatalog({ ok: true, value: { groups: [{ id: 'p' }] } }).loaded, true);
});

test('a catalog that has not answered is distinct from an empty one', () => {
    const { readCatalog } = loadBundle().exports;
    // `loaded` drives the warning copy: not-yet-answered must not read as failure.
    assert.equal(readCatalog({ ok: true, value: { groups: [], routableProviders: [] } }).loaded, false);
    assert.equal(readCatalog({ ok: true, value: { groups: [{ id: 'p', models: [] }] } }).loaded, true);
});
test('every class the card emits is one the stylesheet defines', () => {
    const bundle = loadBundle();
    bundle.resetSlots();
    const tree = bundle.exports.CompactModelCard({
        useCompactModel: () => ({ status: 'ready', writable: true, value: pinnedSection }),
        setRoute: () => Promise.resolve(),
        setEffort: () => Promise.resolve(),
    });
    const css = bundle.css();
    for (const name of classes(tree)) {
        // Class names introduced by foreign components (Menu's own root) are not ours.
        if (!name.startsWith('dsh-pcm-')) continue;
        assert.ok(css.includes(`.${name}{`) || css.includes(`.${name}:`) || css.includes(`.${name},`),
            `class ${name} is emitted but never styled`);
    }
});

test('the old collapsed chrome is gone', () => {
    const css = loadBundle().css();
    for (const dead of ['dsh-pcm-row', 'dsh-pcm-label', 'dsh-pcm-head{', 'dsh-pcm-sub', 'dsh-pcm-chev{', 'dsh-pcm-note']) {
        assert.ok(!css.includes(dead), `stale rule still present: ${dead}`);
    }
});

test('a failed write can never be swallowed silently', () => {
    // The anti-pattern this pins, and the reason an earlier "I picked a provider
    // and the card still says 未选择" report could not be diagnosed from outside:
    // the write helper ended in `.catch(() => undefined)`, so a rejected write was
    // indistinguishable from a click nobody handled -- no message, no log, nothing.
    //
    // Deliberately a source-level check: this suite's hook double cannot drive a
    // re-render, and a test that pretends to observe one would be worse than none.
    const source = readFileSync(BUNDLE, 'utf8');
    assert.doesNotMatch(source, /\.catch\(\(\)\s*=>\s*undefined\)/,
        'a bare .catch(() => undefined) hides a failed write again');
    assert.match(source, /settings write failed:/,
        'a rejected write must name itself in the console');
    assert.match(source, /missing injected seat:/,
        'a missing injected writer must report instead of returning silently');
    assert.match(source, /reportMissingSeat/, 'the missing-seat guard helper is gone');
    // Both writers go through that guard rather than a bare `return`.
    assert.match(source, /typeof props\.setRoute !== 'function'/, 'setRoute lost its guard');
    assert.match(source, /typeof props\.setEffort !== 'function'/, 'setEffort lost its guard');
});

test('a write result is read back from the RAW user layer, not from a promise', () => {
    // The scope NEVER rejects a write: on a host refusal it calls its private
    // `recover()`, silently re-reads the mirror, and RESOLVES. So `.catch()` cannot
    // detect a refusal, and neither can a resolved-value comparison -- the card's
    // base layer makes `{}` and `{provider:'',model:''}` resolve identically.
    //
    // The framework's own cards read the outcome back from the raw user layer
    // (`PluginCard.store()` is `userLayer()?.[field] === value`), and this pins the
    // same contract here: the stored value must be compared against `snapshot.user`
    // -- whose PRESENCE is what marks a field overridden.
    const source = readFileSync(BUNDLE, 'utf8');
    assert.match(source, /getSnapshot\(\)\.user/, 'the user layer is never read back');
    assert.match(source, /assertStored/, 'the read-back assertion helper is gone');
    // An empty write must be allowed to leave the key ABSENT -- that is what an
    // `unset` means, and requiring `''` instead would report every clear as a fault.
    assert.match(source, /actual === undefined \|\| actual === ''/,
        'a cleared field must be accepted as absent');
});

test('switching provider judges the carried model against the NEW provider', () => {
    // Carrying the model over by looking at the STORED provider's entries produces
    // {provider:'B', model:<a model A offers>} on an A -> B switch. That pair is
    // perfectly "legal" (both halves non-empty), so it persists silently and the
    // compaction backend later asks provider B for a model id that belongs to A.
    const source = readFileSync(BUNDLE, 'utf8');
    assert.match(source, /const carriedModel = \(nextProvider\)/, 'carriedModel is not keyed on the target');
    assert.match(source, /catalog\.models\.has\(nextProvider\)/,
        'the carried model must be looked up in the TARGET provider catalogue');
    assert.match(source, /writeRoute\(nextProvider, nextProvider === '' \? '' : carriedModel\(nextProvider\)\)/,
        'pickProvider no longer uses the target-keyed decision');
});

test('a no-op selection is never submitted', () => {
    // The host skips an unchanged raw section in total silence (no persist, no
    // revision bump, no watcher call, no log). Submitting a no-op write therefore
    // reproduces the exact "dead control" symptom that started all of this, so the
    // card drops it before it reaches the wire.
    const source = readFileSync(BUNDLE, 'utf8');
    assert.match(source, /const sameRoute = \(nextProvider, nextModel\)/);
    assert.match(source, /if \(sameRoute\(nextProvider, nextModel\)\) return;/,
        'writeRoute must drop a no-op');
    assert.match(source, /if \(\(id === FOLLOW \? '' : id\) === effort\) return;/,
        'pickEffort must drop a no-op');
});
