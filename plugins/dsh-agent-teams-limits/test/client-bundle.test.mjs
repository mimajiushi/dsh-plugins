/**
 * Client-half contract tests for dsh-agent-teams-limits.
 *
 * These load the REAL `lib/client.js` bundle through a `node:vm` sandbox and drive
 * it with a hand-written React double whose hooks actually run (there is no jsdom
 * on this machine). The suite pins:
 *
 *  1. The card keeps the framework `PluginCard` DOM contract
 *     (`li.card > button.header + div.body`) and exposes exactly two number
 *     inputs with the documented ranges.
 *  2. SETTINGS TRANSPORT: the host-served `settingsScope` (0.1.5) registers the
 *     card in the `settings.plugin.item` seat keyed by the settings namespace; a
 *     0.1.7 composition (`configForms` present) goes to the plugin manager's
 *     `plugins.bundle.config` seat keyed by the bundle name instead, because the
 *     0.1.5 seat renders NOWHERE there.
 *  3. The write path drops a no-op before it reaches the wire (a host that ignores
 *     an unchanged section answers in total silence, which reads as a dead
 *     control) and reports a rejection instead of swallowing it.
 *  4. Input parsing refuses out-of-range / non-integer text instead of writing it.
 *
 * @module dsh-agent-teams-limits/test/client
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/**
 * Copy a value out of the sandbox realm.
 * @param value - a value produced inside the sandbox.
 * @returns the same data built from this realm's constructors.
 */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
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
 * Recursively collect every rendered element whose `props.type` is `type`.
 * @param node - rendered tree.
 * @param type - an HTML tag name.
 * @param into - accumulator.
 * @returns the accumulator.
 */
function tags(node, type, into = []) {
    if (node === null || node === undefined || typeof node !== 'object') return into;
    if (Array.isArray(node)) {
        for (const child of node) tags(child, type, into);
        return into;
    }
    if (node.type === type) into.push(node);
    tags(node.props === undefined ? undefined : node.props.children, type, into);
    return into;
}

/**
 * Load the client bundle in a sandbox.
 * @returns the bundle handle.
 */
function loadBundle() {
    const css = [];
    const errors = [];
    const state = new Map();
    let slot = 0;

    const hook = (init) => {
        const key = `s${slot++}`;
        if (!state.has(key)) state.set(key, typeof init === 'function' ? init() : init);
        return [state.get(key), (next) => {
            const value = typeof next === 'function' ? next(state.get(key)) : next;
            state.set(key, value);
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
        createElement: () => ({ dataset: {}, textContent: '' }),
        head: { appendChild: (tag) => { css.push(tag.textContent); return tag; } },
    };
    const primitives = {
        IconChevronDownOutline14: (props) => jsx('svg', { className: props.className }),
    };

    let captured;
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
        window: {
            __ModuleLoader__: {
                load: (definition) => { captured = definition; },
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
        definition: captured,
        exports: moduleExports,
        css: () => css.join('\n'),
        errors: () => errors,
        resetSlots: () => { slot = 0; },
    };
}

/**
 * A ready settings scope double.
 * @param options - `{ user, writable, withSnapshot }`.
 * @returns the scope plus its records.
 */
function fakeScope(options = {}) {
    const record = { user: { ...(options.user ?? {}) }, sets: [], unsets: [], bound: undefined };
    const scope = {
        bind: (args) => {
            record.bound = plain(args);
            return scope;
        },
        getSnapshot: () => ({
            status: 'ready',
            writable: options.writable !== false,
            value: { ...record.user },
            user: { ...record.user },
        }),
        set: (field, value) => {
            record.sets.push([field, value]);
            if (options.refuseWrites !== true) record.user[field] = value;
            return Promise.resolve();
        },
        unset: (field) => {
            record.unsets.push([field]);
            if (options.refuseWrites !== true) delete record.user[field];
            return Promise.resolve();
        },
    };
    return { scope, record };
}

/**
 * Fake client context: services can be registered before OR after `apply`, so the
 * real page's ordering (slots early, settings transports later) is replayable.
 * @param services - services already registered.
 * @returns `{ ctx, record, provide }`.
 */
function fakeContext(services = {}) {
    const registry = new Map(Object.entries(services));
    const waiting = [];
    const record = { registered: [], injectSeats: [], effects: [] };
    const ctx = {
        get: (name) => registry.get(name),
        inject(deps, callback) {
            const ready = deps.every((name) => registry.has(name));
            if (ready) callback(ctx);
            else waiting.push({ deps, callback });
        },
        effect(fn, label) {
            record.effects.push(label);
            const disposer = fn();
            return () => {
                if (typeof disposer === 'function') disposer();
            };
        },
        slots: {
            inject(seat, callback) {
                record.injectSeats.push(seat);
                const result = callback();
                return result;
            },
            register(options, component) {
                record.registered.push({ options, component });
                return () => undefined;
            },
        },
    };
    return {
        ctx,
        record,
        provide(name, service) {
            registry.set(name, service);
            for (const entry of [...waiting]) {
                if (!entry.deps.every((needed) => registry.has(needed))) continue;
                waiting.splice(waiting.indexOf(entry), 1);
                entry.callback(ctx);
            }
        },
    };
}

/**
 * Render the card once.
 * @param bundle - the loaded bundle.
 * @param snapshot - the scope snapshot the selector should answer.
 * @param face - the injected face (write functions).
 * @returns the rendered tree.
 */
function renderCard(bundle, snapshot, face = {}) {
    bundle.resetSlots();
    return bundle.exports.LimitsCard({
        useAgentTeamsLimits: (selector) => selector(snapshot),
        setLimit: face.setLimit ?? (() => Promise.resolve()),
    });
}

test('the bundle registers under its own id with the slot ledger declared', () => {
    const bundle = loadBundle();
    assert.equal(bundle.definition.id, 'dsh-agent-teams-limits');
    assert.deepEqual(plain(bundle.exports.inject), ['slots']);
    assert.equal(typeof bundle.exports.apply, 'function');
    assert.match(bundle.css(), /\.dsh-atl-input/);
    assert.match(bundle.exports.CSS_TAG_ID, /client\.js$|Card\.css$/);
});

test('0.1.5: settingsScope binds the namespace and lands in settings.plugin.item', () => {
    const bundle = loadBundle();
    const { scope, record } = fakeScope({ user: { maxMembers: 16 } });
    const host = fakeContext();
    bundle.exports.apply(host.ctx);
    host.provide('settingsScope', { bind: scope.bind });

    assert.deepEqual(record.bound, { namespace: 'agent-teams-limits' });
    assert.deepEqual(plain(host.record.injectSeats), ['settings.plugin.item']);
    assert.equal(host.record.registered.length, 1);
    const options = host.record.registered[0].options;
    assert.equal(options.name, 'settings.plugin.item');
    assert.equal(options.key, 'agent-teams-limits');
    assert.equal(typeof options.inject, 'function', 'the face is injected lazily per render');
    const face = options.inject();
    assert.deepEqual(Object.keys(face), ['hooks', 'setLimit']);
    assert.equal(face.hooks.agentTeamsLimits, scope);
    assert.equal(host.record.registered[0].component, bundle.exports.LimitsCard);
});

test('0.1.7: configForms present routes the card to the bundle seat, gated by whileServed', () => {
    const bundle = loadBundle();
    const served = [];
    const host = fakeContext({
        configForms: {
            whileServed: (ids, register) => { served.push(plain(ids)); return register(); },
        },
        webUiSettings: { bind: () => fakeScope().scope },
    });
    bundle.exports.apply(host.ctx);
    host.provide('settingsScope', { bind: () => fakeScope().scope });

    assert.deepEqual(plain(host.record.injectSeats), ['plugins.bundle.config']);
    assert.equal(host.record.registered[0].options.key, 'dsh-agent-teams-limits');
    assert.deepEqual(served[0], ['agent-teams-limits', 'dsh-agent-teams-limits']);
});

test('a composition with no settings transport still activates (no card, no crash)', () => {
    const bundle = loadBundle();
    const host = fakeContext();
    bundle.exports.apply(host.ctx);
    assert.equal(host.record.registered.length, 0);
    assert.equal(bundle.errors().length, 0);
});

test('write path: the transport writes exactly what it is told, and unsets on request', async () => {
    const bundle = loadBundle();
    const { scope, record } = fakeScope({ user: { maxMembers: 16 } });
    const host = fakeContext({ settingsScope: { bind: () => scope } });
    bundle.exports.apply(host.ctx);
    const face = host.record.registered[0].options.inject();

    await face.setLimit('maxMembers', { kind: 'set', value: 20 });
    assert.deepEqual(record.sets, [['maxMembers', 20]]);

    await face.setLimit('maxConcurrentMembers', { kind: 'unset' });
    assert.deepEqual(record.unsets, [['maxConcurrentMembers']]);
});

test('the card never sends an unchanged value, and writes a changed one on blur', async () => {
    const bundle = loadBundle();
    const calls = [];
    const visible = { status: 'ready', writable: true, user: { maxMembers: 16 } };
    const props = {
        useAgentTeamsLimits: (selector) => selector(visible),
        setLimit: (field, intent) => {
            calls.push([field, intent]);
            return Promise.resolve();
        },
    };
    // The write goes through the injected function asynchronously (it is a host
    // round-trip), so every assertion flushes the microtask queue first.
    const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
    const render = () => {
        // The hook double keys state by slot index, so every render starts the
        // counter over — exactly how the sibling plugins' harnesses drive it.
        bundle.resetSlots();
        return bundle.exports.LimitsCard(props);
    };
    const closed = render();
    closed.props.children[0].props.onClick();
    const first = tags(render(), 'input')[0];

    first.props.onBlur();
    await flush();
    assert.deepEqual(calls, [], 'the host ignores an unchanged section in silence, so no write is sent');

    first.props.onChange({ target: { value: '20' } });
    tags(render(), 'input')[0].props.onBlur();
    await flush();
    assert.deepEqual(plain(calls), [['maxMembers', { kind: 'set', value: 20 }]]);

    tags(render(), 'input')[0].props.onChange({ target: { value: '999' } });
    tags(render(), 'input')[0].props.onBlur();
    await flush();
    assert.equal(calls.length, 1, 'an out-of-range draft is refused locally');
    assert.match(find(render(), 'dsh-atl-warn').props.children, /写入失败/);
});

test('write path: a host refusal rejects loudly instead of looking like success', async () => {
    const bundle = loadBundle();
    const { scope } = fakeScope({ user: {}, refuseWrites: true });
    const host = fakeContext({ settingsScope: { bind: () => scope } });
    bundle.exports.apply(host.ctx);
    const face = host.record.registered[0].options.inject();
    await assert.rejects(() => face.setLimit('maxMembers', { kind: 'set', value: 12 }), /没有被接受/);
});

test('input parsing refuses out-of-range and non-integer text', () => {
    const bundle = loadBundle();
    const { parseLimitInput } = bundle.exports;
    assert.deepEqual(plain(parseLimitInput('16', 'maxMembers')), { kind: 'set', value: 16 });
    assert.deepEqual(plain(parseLimitInput('', 'maxMembers')), { kind: 'unset' });
    assert.deepEqual(plain(parseLimitInput('0', 'maxMembers')), { kind: 'invalid' }, 'the roster cap starts at 1');
    assert.deepEqual(plain(parseLimitInput('65', 'maxMembers')), { kind: 'invalid' });
    assert.deepEqual(plain(parseLimitInput('2.5', 'maxMembers')), { kind: 'invalid' });
    assert.deepEqual(plain(parseLimitInput('abc', 'maxMembers')), { kind: 'invalid' });
    assert.deepEqual(plain(parseLimitInput('0', 'maxConcurrentMembers')), { kind: 'set', value: 0 }, '0 = unlimited');
    assert.deepEqual(plain(parseLimitInput('33', 'maxConcurrentMembers')), { kind: 'invalid' });
    assert.deepEqual(plain(parseLimitInput('3', 'nope')), { kind: 'invalid' });
});

test('resolved display state falls back to the AgentTeams defaults', () => {
    const bundle = loadBundle();
    const { resolvedLimits } = bundle.exports;
    assert.deepEqual(plain(resolvedLimits({ status: 'ready', user: {} })),
        { maxMembers: 8, maxConcurrentMembers: 0, configured: false });
    assert.deepEqual(plain(resolvedLimits({ status: 'ready', user: { maxMembers: 16, maxConcurrentMembers: 2 } })),
        { maxMembers: 16, maxConcurrentMembers: 2, configured: true });
    assert.deepEqual(plain(resolvedLimits({ status: 'ready', user: { maxConcurrentMembers: '3' } })),
        { maxMembers: 8, maxConcurrentMembers: 3, configured: true });
});

test('the card renders the PluginCard contract, two number inputs and the live state', () => {
    const bundle = loadBundle();
    const ready = { status: 'ready', writable: true, user: { maxMembers: 16, maxConcurrentMembers: 2 } };
    const open = renderCard(bundle, ready);
    open.props.children[0].props.onClick();
    const expanded = renderCard(bundle, ready);

    assert.equal(expanded.type, 'li');
    assert.equal(find(expanded, 'dsh-atl-card') !== undefined, true);
    assert.equal(find(expanded, 'dsh-atl-header') !== undefined, true);
    assert.equal(find(expanded, 'dsh-atl-body') !== undefined, true);
    assert.equal(find(expanded, 'dsh-atl-name').props.children, 'Agent Teams 限制');
    assert.match(find(expanded, 'dsh-atl-description').props.children, /成员上限 16/);
    assert.match(find(expanded, 'dsh-atl-description').props.children, /并发上限 2/);

    const inputs = tags(expanded, 'input');
    assert.equal(inputs.length, 2);
    assert.deepEqual(plain(inputs.map((input) => ({
        id: input.props.id,
        type: input.props.type,
        min: input.props.min,
        max: input.props.max,
        value: input.props.value,
        placeholder: input.props.placeholder,
        disabled: input.props.disabled,
    }))), [
        { id: 'dsh-agent-teams-limits-max-members', type: 'number', min: 1, max: 64, value: '16', placeholder: '8', disabled: false },
        { id: 'dsh-agent-teams-limits-max-concurrent', type: 'number', min: 0, max: 32, value: '2', placeholder: '不限', disabled: false },
    ]);
});

test('the card reflects read-only, loading and unavailable transports', () => {
    const bundle = loadBundle();
    const readOnly = renderCard(bundle, { status: 'ready', writable: false, user: {} });
    readOnly.props.children[0].props.onClick();
    const readOnlyExpanded = renderCard(bundle, { status: 'ready', writable: false, user: {} });
    const inputs = tags(readOnlyExpanded, 'input');
    assert.equal(inputs.every((input) => input.props.disabled === true), true);
    assert.equal(inputs[0].props.value, '', 'unset renders empty, with the default as the placeholder');
    assert.match(find(readOnlyExpanded, 'dsh-atl-description').props.children, /未设置/);

    assert.equal(renderCard(bundle, { status: 'unavailable' }), null);
});
