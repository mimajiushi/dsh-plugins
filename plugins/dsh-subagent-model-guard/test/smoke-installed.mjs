/**
 * Load smoke test: proves the plugin is importable through the *installed*
 * profile path (the `node_modules` junction the loader will resolve) and that
 * wrapping a realistic `SubagentRuntime` — prototype methods, real call
 * signatures — resolves the child route exactly as `resolveChildAgentOptions`
 * would.
 *
 * Run after wiring the profile: `node test/smoke-installed.mjs`
 * Skip it anywhere else: the plugin is not installed there, and the test
 * skips itself. `DSH_HOME` overrides the harness home it looks under.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const INSTALLED = join(HOME, 'profiles', 'desktop', 'node_modules',
    'dsh-subagent-model-guard', 'lib', 'index.js');

const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash' };
const KIMI = { provider: 'kimi-coding', model: 'k3' };
const KIMI_256K = { provider: 'kimi-coding', model: 'k3-256k' };

test('the wired desktop profile resolves the plugin entry', { skip: !existsSync(INSTALLED) }, async () => {
    const module = await import(pathToFileURL(INSTALLED).href);
    assert.equal(module.name, 'subagent-model-guard');
    assert.deepEqual(module.inject, ['subagents', 'tools']);
    assert.equal(typeof module.apply, 'function');
    assert.equal(module.SETTINGS_NS, 'subagent-model-selection');
    assert.equal(
        'Config' in module,
        false,
        'exporting a plain Config object would make Cordis validate against it and throw at mount',
    );
});

/**
 * A stand-in for the shipped `SubagentRuntime`: the two creation methods are
 * prototype methods, and `start` dispatches to a provider the way the real
 * class does (the provider — not this class — merges `agentOptions`).
 */
class RealisticRuntime {
    constructor() {
        this.dispatched = [];
    }

    async start(name, request) {
        if (typeof name !== 'string' || request === null || typeof request !== 'object') {
            throw new TypeError('no subagent provider registered');
        }
        this.dispatched.push({ name, request });
        return { run: 'ok' };
    }

    async startContinuable(spec) {
        // Mirrors the manager: the request carries `agentOptions`, which
        // `resolveChildAgentOptions` merges over the parent route.
        const { request } = spec;
        if (request === null || typeof request !== 'object') throw new TypeError('invalid spec');
        this.dispatched.push({ name: spec.provider, request });
        return { childId: 'child-1' };
    }
}

/** The parent Agent shape the gate reads. */
function parentAgent(route) {
    return { options: { ...route }, session: { requestHeader: () => ({ config: { ...route } }) } };
}

/** A minimal host context, mirroring what the real composition supplies. */
function hostContext(policy, runtime) {
    return {
        subagents: runtime,
        tools: { guard: () => () => undefined },
        logger: { info() {}, warn() {} },
        get: (name) => (name === 'settings' ? { get: () => policy } : undefined),
        effect: (callback) => {
            const dispose = callback();
            return () => {
                if (typeof dispose === 'function') dispose();
            };
        },
    };
}

test('a realistic runtime is gated through the installed entry point', { skip: !existsSync(INSTALLED) }, async () => {
    const { install } = await import(pathToFileURL(INSTALLED).href);
    const runtime = new RealisticRuntime();
    install(hostContext({ enabled: true, allowedModels: [DEEPSEEK] }, runtime), undefined);

    await runtime.start('spawn', { parent: parentAgent(DEEPSEEK), agentOptions: { ...DEEPSEEK } });
    assert.equal(runtime.dispatched.length, 1, 'the on-list request reached the provider');

    await assert.rejects(
        () => runtime.start('spawn', { parent: parentAgent(DEEPSEEK), agentOptions: { ...KIMI } }),
        /白名单拦截/,
    );
    await assert.rejects(
        () => runtime.startContinuable({ provider: 'spawn', request: { parent: parentAgent(KIMI_256K), agentOptions: { ...KIMI_256K } } }),
        /白名单拦截/,
    );
    assert.equal(runtime.dispatched.length, 1, 'every refusal happened before dispatch');
});

test('AgentTeams-style inheritance is gated too', { skip: !existsSync(INSTALLED) }, async () => {
    const { install } = await import(pathToFileURL(INSTALLED).href);
    const runtime = new RealisticRuntime();
    // The captain is off-list; the member names no model of its own, but the
    // member spawn still hands over a resolved route — the same thing.
    install(hostContext({ enabled: true, allowedModels: [DEEPSEEK, KIMI_256K] }, runtime), undefined);

    await runtime.startContinuable({
        provider: 'spawn',
        label: 'agent-teams-member:t1/m1',
        request: { parent: parentAgent(KIMI), agentOptions: { ...KIMI } },
    }).then(() => assert.fail('an off-list inherited route must not be dispatched'))
        .catch((error) => assert.match(error.message, /kimi-coding\/k3/));

    await runtime.startContinuable({
        provider: 'spawn',
        label: 'agent-teams-member:t1/m1',
        request: { parent: parentAgent(KIMI), agentOptions: { ...KIMI_256K } },
    });
    assert.equal(runtime.dispatched.length, 1);
});
