/**
 * Host-half tests: the runtime gate and the tool guard, exercised against a
 * fake `SubagentRuntime` and a fake Cordis context. Nothing here needs DSH.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NAME, install } from '../lib/index.js';

const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash' };
const KIMI = { provider: 'kimi-coding', model: 'k3' };
const KIMI_256K = { provider: 'kimi-coding', model: 'k3-256k' };

/** A parent Agent whose request header owns its route. */
function parentAgent(route = DEEPSEEK) {
    return {
        id: 'session-parent',
        options: { ...route },
        session: { requestHeader: () => ({ config: { ...route } }) },
    };
}

/**
 * A stand-in `SubagentRuntime`: the two creation methods live on the prototype,
 * exactly as the shipped class defines them, so the plugin's own-property
 * shadowing is what the test observes.
 */
class FakeRuntime {
    constructor() {
        this.calls = [];
    }

    async start(providerName, request) {
        this.calls.push({ method: 'start', providerName, request });
        return { kind: 'start', providerName };
    }

    async startContinuable(spec) {
        this.calls.push({ method: 'startContinuable', spec });
        return { kind: 'continuable', childId: 'child-1' };
    }
}

/** A fake host context that records every registration the plugin makes. */
function fakeHostContext({ policy, runtime = new FakeRuntime(), tools = true } = {}) {
    const calls = { effects: [], labels: [], guard: undefined, warnings: [], infos: [] };
    // `policy` is either the section value or a thunk, so a test can prove the
    // plugin re-reads the live settings document instead of caching it.
    const readPolicy = typeof policy === 'function' ? policy : () => policy;
    const ctx = {
        subagents: runtime,
        tools: tools
            ? {
                guard(callback) {
                    calls.guard = callback;
                    return () => {
                        calls.guard = undefined;
                    };
                },
            }
            : undefined,
        logger: {
            info: (message) => calls.infos.push(message),
            warn: (message) => calls.warnings.push(message),
        },
        get: (name) => (name === 'settings' ? { get: () => readPolicy() } : undefined),
        effect(callback, label) {
            calls.labels.push(label);
            const dispose = callback();
            calls.effects.push(dispose);
            return () => {
                if (typeof dispose === 'function') dispose();
            };
        },
    };
    return { ctx, calls, runtime };
}

/** An enabled whitelist over the given routes. */
function activePolicy(routes = [DEEPSEEK]) {
    return { enabled: true, allowedModels: routes };
}

test('install wraps both creation methods and forwards their arguments unchanged', async () => {
    const { ctx, runtime } = fakeHostContext({ policy: activePolicy() });
    install(ctx, undefined);

    assert.notEqual(runtime.start, FakeRuntime.prototype.start, 'start is shadowed by an own property');
    assert.notEqual(runtime.startContinuable, FakeRuntime.prototype.startContinuable);

    const request = { parent: parentAgent(DEEPSEEK), agentOptions: { ...DEEPSEEK }, label: 'x' };
    const result = await runtime.start('spawn', request);
    assert.deepEqual(result, { kind: 'start', providerName: 'spawn' });
    assert.deepEqual(runtime.calls[0], { method: 'start', providerName: 'spawn', request });

    const spec = { provider: 'spawn', label: 'y', request: { parent: parentAgent(DEEPSEEK) }, signal: undefined };
    await runtime.startContinuable(spec);
    assert.deepEqual(runtime.calls[1], { method: 'startContinuable', spec });
});

test('the gate refuses an off-list explicit route before any child is created', async () => {
    const { ctx, runtime, calls } = fakeHostContext({ policy: activePolicy() });
    install(ctx, undefined);

    await assert.rejects(
        () => runtime.start('spawn', { parent: parentAgent(DEEPSEEK), agentOptions: { ...KIMI } }),
        (error) => {
            assert.match(error.message, /白名单拦截/);
            assert.match(error.message, /kimi-coding\/k3/);
            assert.match(error.message, /deepseek-official\/deepseek-flash/);
            assert.match(error.message, /list_subagent_models/);
            return true;
        },
    );
    assert.equal(runtime.calls.length, 0, 'the original creation method was never called');
    assert.equal(calls.warnings.length, 1, 'one refusal is logged');
});

test('the gate refuses pure inheritance of an off-list parent route', async () => {
    const { ctx, runtime } = fakeHostContext({ policy: activePolicy([DEEPSEEK, KIMI_256K]) });
    install(ctx, undefined);

    await assert.rejects(
        () => runtime.startContinuable({ provider: 'spawn', request: { parent: parentAgent(KIMI) } }),
        /继承队长的路由 "kimi-coding\/k3"/,
    );
    assert.equal(runtime.calls.length, 0);
});

test('the gate allows an on-list route and an on-list inheritance', async () => {
    const { ctx, runtime } = fakeHostContext({ policy: activePolicy([DEEPSEEK, KIMI_256K]) });
    install(ctx, undefined);

    await runtime.start('spawn', { parent: parentAgent(DEEPSEEK), agentOptions: { ...KIMI_256K } });
    await runtime.startContinuable({ provider: 'spawn', request: { parent: parentAgent(KIMI_256K) } });
    assert.deepEqual(runtime.calls.map((call) => call.method), ['start', 'startContinuable']);
});

test('the gate stays inert while the whitelist is off', async () => {
    const { ctx, runtime, calls } = fakeHostContext({ policy: { enabled: false, allowedModels: [DEEPSEEK] } });
    install(ctx, undefined);

    await runtime.start('spawn', { parent: parentAgent(KIMI), agentOptions: { ...KIMI } });
    assert.equal(runtime.calls.length, 1);
    assert.deepEqual(calls.warnings, []);
});

test('the gate stays inert when the settings service is unavailable', async () => {
    const { ctx, runtime } = fakeHostContext({ policy: undefined });
    ctx.get = () => undefined;
    install(ctx, undefined);

    await runtime.start('spawn', { parent: parentAgent(KIMI), agentOptions: { ...KIMI } });
    assert.equal(runtime.calls.length, 1);
});

test('the gate is a no-op for a request without a parent', async () => {
    const { ctx, runtime } = fakeHostContext({ policy: activePolicy() });
    install(ctx, undefined);

    await runtime.start('spawn', { agentOptions: { ...KIMI } });
    await runtime.start('spawn', undefined);
    assert.equal(runtime.calls.length, 2, 'nothing to resolve is not a refusal by the gate itself');
});

test('one warning per distinct refused route, so a retry loop stays quiet', async () => {
    const { ctx, runtime, calls } = fakeHostContext({ policy: activePolicy() });
    install(ctx, undefined);

    const request = { parent: parentAgent(DEEPSEEK), agentOptions: { ...KIMI } };
    await assert.rejects(() => runtime.start('spawn', request));
    await assert.rejects(() => runtime.start('spawn', request));
    assert.equal(calls.warnings.length, 1);

    await assert.rejects(() => runtime.startContinuable({ provider: 'fork', request: { parent: parentAgent(DEEPSEEK), agentOptions: { ...KIMI } } }));
    assert.equal(calls.warnings.length, 2, 'a different source is its own line');
});

test('disposal restores the original prototype methods', async () => {
    const { ctx, runtime, calls } = fakeHostContext({ policy: activePolicy() });
    install(ctx, undefined);
    const guarded = runtime.start;

    for (const dispose of calls.effects) dispose();
    assert.equal(Object.getOwnPropertyDescriptor(runtime, 'start'), undefined);
    assert.equal(runtime.start, FakeRuntime.prototype.start);
    assert.equal(runtime.startContinuable, FakeRuntime.prototype.startContinuable);
    await runtime.start('spawn', { parent: parentAgent(KIMI), agentOptions: { ...KIMI } });
    assert.equal(runtime.calls.length, 1, 'after disposal the gate no longer runs');
    assert.notEqual(runtime.start, guarded);
});

test('re-installing does not double-wrap the same runtime', async () => {
    const { ctx, runtime, calls } = fakeHostContext({ policy: activePolicy() });
    install(ctx, undefined);
    const once = runtime.start;
    install(ctx, undefined);
    assert.equal(runtime.start, once, 'the second install recognised the already-wrapped runtime');
    assert.equal(calls.labels.length, 2, 'the other layer (settings/tool guard) is still installed');

    await assert.rejects(
        () => runtime.start('spawn', { parent: parentAgent(DEEPSEEK), agentOptions: { ...KIMI } }),
        /白名单拦截/,
    );
    assert.equal(runtime.calls.length, 0);
});

test('re-installing after disposal is idempotent for the tool guard', () => {
    const { ctx, calls } = fakeHostContext({ policy: activePolicy(), runtime: new FakeRuntime() });
    install(ctx, undefined);
    assert.equal(typeof calls.guard, 'function');
    install(ctx, undefined);
    assert.equal(calls.labels.filter((label) => label.endsWith('delegation tool guard')).length, 1);

    for (const dispose of calls.effects) dispose();
    assert.equal(calls.guard, undefined, 'disposal unregistered the guard');
    install(ctx, undefined);
    assert.equal(typeof calls.guard, 'function', 'a remount registers it again');
});

test('the registered tool guard denies an off-list delegation and allows the rest', () => {
    const { ctx, calls } = fakeHostContext({ policy: activePolicy([DEEPSEEK, KIMI_256K]) });
    install(ctx, undefined);

    assert.match(calls.guard({ name: 'subagent', arguments: { provider: 'kimi-coding', model: 'k3' } }), /白名单拦截/);
    assert.equal(calls.guard({ name: 'subagent', arguments: { provider: 'deepseek-official', model: 'deepseek-flash' } }), undefined);
    assert.equal(calls.guard({ name: 'subagent', arguments: { prompt: 'p' } }), undefined);
    assert.equal(calls.guard({ name: 'workflow', arguments: { provider: 'kimi-coding', model: 'k3' } }), undefined);
});

test('the registered tool guard refuses an AgentTeams roster that could never spawn', () => {
    const { ctx, calls } = fakeHostContext({ policy: activePolicy([DEEPSEEK, KIMI_256K]) });
    install(ctx, undefined);

    const create = (members) => ({
        name: 'agent_teams_create',
        arguments: { name: 'team-x', plan: { members, tasks: [] } },
        agent: parentAgent(KIMI),
    });
    const denial = calls.guard(create([{ name: 'inherits-captain' }]));
    assert.match(denial, /白名单拦截/);
    assert.match(denial, /agent_teams_create/);
    assert.match(denial, /继承队长的路由 "kimi-coding\/k3"/);
    assert.match(denial, /deepseek-official\/deepseek-flash/);
    assert.match(denial, /kimi-coding\/k3-256k/);

    assert.match(
        calls.guard(create([{ name: 'explicit', provider: 'kimi-coding', model: 'k3' }])),
        /成员 "explicit"/,
    );
    assert.equal(
        calls.guard(create([
            { name: 'a', provider: 'deepseek-official', model: 'deepseek-flash' },
            { name: 'b', provider: 'kimi-coding', model: 'k3-256k' },
        ])),
        undefined,
        'an all-whitelist roster passes the creation gate',
    );

    const addMember = {
        name: 'agent_teams_add_member',
        arguments: { name: 'm', provider: 'kimi-coding', model: 'k3' },
        agent: parentAgent(DEEPSEEK),
    };
    assert.match(calls.guard(addMember), /agent_teams_add_member/);
});

test('a host without ctx.tools.guard still installs the runtime gate', async () => {
    const { ctx, runtime, calls } = fakeHostContext({ policy: activePolicy(), tools: false });
    install(ctx, undefined);

    assert.equal(calls.warnings.length, 1);
    assert.match(calls.warnings[0], /ctx\.tools\.guard` is unavailable/);
    await assert.rejects(
        () => runtime.start('spawn', { parent: parentAgent(DEEPSEEK), agentOptions: { ...KIMI } }),
        /白名单拦截/,
    );
});

test('install fails loud on a bad config and on a missing runtime', () => {
    const { ctx } = fakeHostContext({ policy: activePolicy() });
    assert.throws(() => install(ctx, { enforce: 'warn' }), /`enforce` must be "strict"/);
    assert.throws(() => install(ctx, { enabled: 'yes' }), /`enabled` must be a boolean/);
    assert.throws(() => install({ logger: {}, effect() {}, get: () => undefined }, undefined), /`subagents` service is unavailable/);
    assert.throws(() => install(null, undefined), /plugin context is required/);
});

test('a disabled plugin installs nothing at all', async () => {
    const { ctx, runtime, calls } = fakeHostContext({ policy: activePolicy() });
    const handle = install(ctx, { enabled: false });

    assert.equal(handle.enabled(), false);
    assert.deepEqual(calls.effects, []);
    await runtime.start('spawn', { parent: parentAgent(KIMI), agentOptions: { ...KIMI } });
    assert.equal(runtime.calls.length, 1, 'the gate is not installed while disabled');
});

test('the returned handle exposes the live policy and the gate', () => {
    const cell = { policy: activePolicy() };
    const { ctx, runtime } = fakeHostContext({ policy: () => cell.policy });
    const handle = install(ctx, undefined);

    assert.equal(handle.enabled(), true);
    assert.deepEqual(handle.policy().routes, [DEEPSEEK]);

    cell.policy = activePolicy([DEEPSEEK, KIMI]);
    assert.equal(handle.policy().routes.length, 2, 'the whitelist is re-read on every decision, not cached');
    handle.gate(parentAgent(DEEPSEEK), {});
    assert.throws(() => handle.gate(parentAgent(DEEPSEEK), { ...KIMI_256K }), /白名单拦截/);
    assert.equal(runtime.calls.length, 0);
});

test('an unreadable settings section leaves the gate inert instead of throwing', async () => {
    const { ctx, runtime, calls } = fakeHostContext({ policy: activePolicy() });
    ctx.get = (name) => (name === 'settings'
        ? {
            get() {
                throw new Error('section write conflict');
            },
        }
        : undefined);
    install(ctx, undefined);

    await runtime.start('spawn', { parent: parentAgent(KIMI), agentOptions: { ...KIMI } });
    assert.equal(runtime.calls.length, 1);
    assert.equal(calls.warnings.length, 1);
    assert.match(calls.warnings[0], /reading the "subagent-model-selection" settings section failed/);
});

test('the plugin name matches the bundle patch row id', () => {
    assert.equal(NAME, 'subagent-model-guard');
});

test('install accepts the whole ESM namespace Cordis hands to apply()', async () => {
    const namespace = await import('../lib/index.js');
    // Cordis' unwrapExports leaves the namespace itself as the runtime and
    // calls runtime.apply(ctx, config); passing it through must work unchanged.
    assert.equal(typeof namespace.apply, 'function');
    const { ctx, runtime } = fakeHostContext({ policy: activePolicy() });
    namespace.apply(ctx, namespace.Config);
    await assert.rejects(
        () => runtime.start('spawn', { parent: parentAgent(DEEPSEEK), agentOptions: { ...KIMI } }),
        /白名单拦截/,
    );
});

test('the module deliberately exports no Config schema', async () => {
    const namespace = await import('../lib/index.js');
    assert.equal(
        'Config' in namespace,
        false,
        'Cordis validates Config["~standard"]; a plain defaults object would throw at mount',
    );
});
