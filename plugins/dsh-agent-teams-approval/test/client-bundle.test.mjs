/**
 * Client-half tests: the hand-authored bundle must register the expected row on
 * the expected slot with the expected settings scope write path. The bundle is
 * evaluated here with stub baseline modules, exactly as the browser module table
 * would hand them over.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** Registration captured from the module-loader facade. */
let registration;
globalThis.window = {
    __ModuleLoader__: {
        load(value) {
            registration = value;
        },
    },
};

const SwitchStub = function SwitchStub() {};
const reactStub = {
    useState(initial) {
        return [initial, () => undefined];
    },
};
const jsxRuntimeStub = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
};
const primitivesStub = { Switch: SwitchStub };
const moduleStubs = {
    react: reactStub,
    'react/jsx-runtime': jsxRuntimeStub,
    '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
};
const stubRequire = (specifier) => {
    if (!Object.hasOwn(moduleStubs, specifier)) throw new Error(`unexpected module request: ${specifier}`);
    return moduleStubs[specifier];
};

await import('../lib/client.js');

const bundle = registration.factory(stubRequire);

/**
 * Fake cordis context whose service registry can be filled before OR after `apply`, so
 * both real orderings can be replayed:
 *
 *  - services already registered when `apply` runs — what the local gate harness does, providing
 *    everything up front, which is why that harness never saw the bug; and
 *  - services that register LATER — the real page, where `slots` is up long before the
 *    settings transports. That ordering used to leave the row unregistered forever.
 *
 * `inject(deps, callback)` mirrors cordis: the callback runs as soon as EVERY declared
 * dependency is registered (with a scoped context), and waits otherwise.
 *
 * @param options - `{ services, locale }` overrides.
 * @returns `{ ctx, record, provide }`.
 */
function fakeContext(options = {}) {
    const registry = new Map(Object.entries(options.services ?? {}));
    const waiting = [];
    const record = { ctxInjections: [], injected: [], registered: [], bound: undefined, locale: undefined };
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
        locale: options.locale ?? {
            register(namespace, dictionaries) {
                record.locale = [namespace, dictionaries];
                return () => undefined;
            },
        },
        slots: {
            inject(name, callback) {
                record.injected.push(name);
                callback();
                return () => undefined;
            },
            register(options2, component) {
                record.registered.push({ options: options2, component });
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

/**
 * Replace the global grace timer with a manually advanced one.
 *
 * The 0.1.7-without-the-group path parks the row for `FAMILY_GRACE_MS` before binding
 * the native form, so the suite must be able to advance that window instead of sleeping
 * two real seconds.
 *
 * @param run - a synchronous body receiving `{ advance, timers }`.
 * @returns whatever `run` returns.
 */
function withFakeTimers(run) {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timers = [];
    globalThis.setTimeout = (callback, ms) => {
        const entry = { callback, ms, cleared: false };
        timers.push(entry);
        return entry;
    };
    globalThis.clearTimeout = (entry) => {
        if (entry !== null && typeof entry === 'object') entry.cleared = true;
    };
    try {
        return run({
            timers,
            advance: () => {
                for (const entry of timers.splice(0)) {
                    if (!entry.cleared) entry.callback();
                }
            },
        });
    } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
    }
}

test('bundle registers under the package name with the baseline-only requires', () => {
    assert.equal(registration.id, 'dsh-agent-teams-approval');
    // Dual-platform contract (2026-09-26): `settingsScope` is resolved optionally at
    // runtime and must NOT be declared — declaring a service dsh 0.1.7 no longer
    // provides fails the whole client boot ("N entry did not activate").
    assert.deepEqual(bundle.inject, ['slots', 'locale']);
    assert.equal(bundle.SETTINGS_NS, 'agent-teams-approval');
    assert.equal(bundle.FLAG_FIELD, 'skipApproval');
    assert.equal(bundle.ROW_ID, 'agent-teams-approval');
    assert.equal(bundle.ROW_ORDER, 12);
    assert.equal(typeof bundle.apply, 'function');
    assert.equal(typeof bundle.ApprovalRow, 'function');
});

test('apply binds the namespace, registers dictionaries and the General row', () => {
    // 0.1.5 with the scope service already registered: the legacy transport wins, the row
    // lands on the very same General seat with the same options.
    const writes = [];
    const scope = {
        getSnapshot: () => ({ status: 'ready', user: {} }),
        set(field, value) {
            writes.push([field, value]);
            return Promise.resolve();
        },
    };
    let bound;
    const { ctx, record } = fakeContext({
        services: { settingsScope: { bind: (spec) => { bound = spec; return scope; } } },
    });

    bundle.apply(ctx);

    assert.deepEqual(bound, { namespace: 'agent-teams-approval' });
    assert.deepEqual(record.injected, ['settings.general.item']);
    assert.equal(record.locale[0], 'agent-teams-approval');
    assert.equal(record.locale[1].zh['row.title'], 'AgentTeams 免审批执行');
    assert.match(record.locale[1].en['row.description'], /Approve & Run/);

    const options = record.registered[0].options;
    assert.equal(options.name, 'settings.general.item');
    assert.equal(options.id, 'agent-teams-approval');
    assert.equal(options.order, 12);
    assert.equal(options.locale, 'agent-teams-approval');
    assert.equal(typeof options.inject, 'function');
    assert.equal(record.registered[0].component, bundle.ApprovalRow);

    const face = options.inject();
    assert.deepEqual(Object.keys(face.hooks), ['approval']);
    assert.equal(face.hooks.approval, scope);
    face.setSkipApproval(true);
    assert.deepEqual(writes, [['skipApproval', true]]);
    face.setSkipApproval('yes');
    assert.deepEqual(writes, [['skipApproval', true], ['skipApproval', false]]);
});

test('a 0.1.7 runtime with the Web UI plugin group keeps the General row and rebinds it', () => {
    // 0.1.7-rc.2 removed the client service `settingsScope` but NOT the
    // `settings.general.item` row seat, so the missing piece on the official desktop was
    // the scope bind — not the seat. The row must therefore still register into the very
    // same General seat with the same options, and only the binder switches to
    // `webUiSettings`.
    let bound;
    const scope = { getSnapshot: () => ({ status: 'ready', user: {} }), set: () => Promise.resolve() };
    const { ctx, record } = fakeContext({
        services: {
            // `configForms` is 0.1.7's value service and is how the binder tells the two
            // dsh lines apart; no 0.1.5 package mentions it.
            webUiSettings: { bind: (spec) => { bound = spec; return scope; } },
            configForms: { get: () => scope, whileServed: () => undefined },
        },
    });
    bundle.apply(ctx);
    assert.deepEqual(bound, { namespace: 'agent-teams-approval' });
    assert.deepEqual(record.injected, ['settings.general.item']);
    assert.equal(record.registered.length, 1);
    assert.equal(record.registered[0].options.name, 'settings.general.item');
    assert.equal(record.registered[0].options.id, 'agent-teams-approval');
    assert.equal(record.registered[0].options.order, 12);
    assert.equal(record.registered[0].options.locale, 'agent-teams-approval');
    assert.equal(typeof record.registered[0].options.inject, 'function');
});

test('a 0.1.7 runtime without the Web UI group binds the native config form and keeps the row', () => {
    // Same line, no dsh-web-settings: the value service itself is still there, so the
    // binder falls back to `ctx.configForms.get(<entry id>)` after the grace window. The
    // candidate ids are tried in order because the patch layer's row id and the package
    // name differ (`- id: agent-teams-approval / name: dsh-agent-teams-approval`).
    withFakeTimers(({ advance }) => {
        const gets = [];
        const { ctx, record } = fakeContext({
            services: {
                configForms: {
                    get(id) {
                        gets.push(id);
                        return id === 'agent-teams-approval'
                            ? { getSnapshot: () => ({ status: 'ready', user: {} }), set: () => Promise.resolve() }
                            : undefined;
                    },
                },
            },
        });
        bundle.apply(ctx);
        assert.equal(record.registered.length, 0, 'the group still gets its grace window');
        advance();
        assert.deepEqual(record.injected, ['settings.general.item']);
        assert.ok(gets.includes('agent-teams-approval'), 'the native form was never resolved by entry id');
        assert.equal(record.registered[0].options.name, 'settings.general.item');
        assert.equal(record.registered[0].options.id, 'agent-teams-approval');
        assert.equal(typeof record.registered[0].options.inject, 'function');
    });
});

test('settings services arriving AFTER apply still mount the row (real page ordering)', () => {
    // The diagnosed real-page failure: `slots` is up long before the settings services, so
    // apply() ran while all three transports were still absent, the old synchronous lookup
    // returned undefined, and the row was never registered. Deferred injection mounts it
    // the moment a transport registers instead.
    withFakeTimers(({ advance }) => {
        const scope = { getSnapshot: () => ({ status: 'ready', user: {} }), set: () => Promise.resolve() };
        const { ctx, record, provide } = fakeContext();
        bundle.apply(ctx);
        assert.equal(record.registered.length, 0, 'apply itself must not register anything yet');
        assert.deepEqual(record.ctxInjections, [['settingsScope'], ['webUiSettings'], ['configForms']]);
        // `configForms` lands first: the row must keep waiting for the group, which is
        // still inside its grace window.
        provide('configForms', { get: () => scope });
        assert.equal(record.registered.length, 0);
        provide('webUiSettings', { bind: () => scope });
        assert.equal(record.registered.length, 1);
        assert.equal(record.registered[0].options.name, 'settings.general.item');
        assert.equal(record.registered[0].options.id, 'agent-teams-approval');
        advance();
        assert.equal(record.registered.length, 1, 'the single latch must hold');
    });
});

test('a late-arriving settingsScope still mounts the row', () => {
    const scope = { getSnapshot: () => ({ status: 'ready', user: {} }), set: () => Promise.resolve() };
    const { ctx, record, provide } = fakeContext();
    bundle.apply(ctx);
    assert.equal(record.registered.length, 0);
    provide('settingsScope', { bind: () => scope });
    assert.equal(record.registered.length, 1);
    assert.equal(record.registered[0].options.name, 'settings.general.item');
});

test('a composition without any settings transport keeps dictionaries and skips the row', () => {
    // The entry must stay active instead of failing the web boot, and it must not
    // register the General row.
    const { ctx, record } = fakeContext();
    assert.equal(bundle.apply(ctx), undefined);
    assert.deepEqual(record.injected, []);
    assert.equal(record.locale[0], 'agent-teams-approval');
});

test('the row renders a switch reflecting the scope snapshot', async () => {
    const writes = [];
    const render = (snapshot) => bundle.ApprovalRow({
        t: (key) => key,
        useApproval: (selector) => selector(snapshot),
        setSkipApproval: (next) => {
            writes.push(next);
        },
    });

    const enabled = render({ status: 'ready', writable: true, value: { skipApproval: true } });
    assert.equal(enabled.type, 'div');
    assert.equal(enabled.props.className, 'dsh-ata-row');
    assert.equal(enabled.props.children[0].props.children[0].props.children, 'row.title');
    const control = enabled.props.children[1];
    assert.equal(control.type, SwitchStub);
    assert.equal(control.props.checked, true);
    assert.equal(control.props.disabled, false);
    assert.equal(control.props.label, 'row.title');
    control.props.onChange(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, [false]);

    const off = render({ status: 'ready', writable: true, value: { skipApproval: false } });
    assert.equal(off.props.children[1].props.checked, false);
    assert.equal(off.props.children[0].props.children[2], null);

    const blocked = render({ status: 'unavailable', writable: false, value: undefined });
    assert.equal(blocked.props.children[1].props.checked, false);
    assert.equal(blocked.props.children[1].props.disabled, true);
    assert.equal(blocked.props.children[0].props.children[2].props.children, 'row.unavailable');

    const loading = render({ status: 'loading', writable: false, value: undefined });
    assert.equal(loading.props.children[1].props.disabled, true);
    assert.equal(loading.props.children[0].props.children[2], null);
});
