/**
 * Host-half tests for dsh-subagent-toggle: the guard wiring over a fake
 * Cordis context. No DSH runtime needed — the plugin's only real
 * collaborators are `ctx.tools.guard`, `ctx.inject(['settings'], …)`, and
 * `ctx.effect`, all faked here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { install, name, inject } from '../lib/index.js';
import { DEFAULT_EXTRA_BLOCKED, SETTINGS_NS } from '../lib/logic.js';

/**
 * A fake settings service with a mutable live section, mirroring the real
 * contract: `register` returns a scope whose `get()` reflects the latest
 * resolved value.
 */
function makeSettings() {
    let section = { enabled: true };
    const service = {
        registrations: [],
        register(ns, schema, options) {
            service.registrations.push({ ns, schema, options });
            return {
                get: () => section,
                watch: () => () => {},
            };
        },
        set(next) {
            section = next;
        },
    };
    return service;
}

/**
 * A fake host context. `tools.guard` captures the guard and hands back a
 * disposer; `effect` runs immediately and stores the cleanup; `inject` fires
 * the settings callback synchronously when constructed with a settings
 * service, and never fires otherwise (a composition without settings).
 */
function makeCtx({ withSettings = true } = {}) {
    const settings = withSettings ? makeSettings() : undefined;
    const guards = [];
    const cleanups = [];
    const logs = [];
    const ctx = {
        tools: {
            guard(fn) {
                guards.push(fn);
                return () => {
                    const index = guards.indexOf(fn);
                    if (index !== -1) guards.splice(index, 1);
                };
            },
        },
        effect(fn) {
            const cleanup = fn();
            if (typeof cleanup === 'function') cleanups.push(cleanup);
            return cleanup;
        },
        inject(tokens, callback) {
            if (!Array.isArray(tokens) || tokens[0] !== 'settings' || settings === undefined) return;
            const settingsCtx = {
                settings,
                effect(fn) {
                    const cleanup = fn();
                    if (typeof cleanup === 'function') cleanups.push(cleanup);
                    return cleanup;
                },
            };
            callback(settingsCtx);
        },
        logger: {
            info: (line) => logs.push(['info', line]),
            warn: (line) => logs.push(['warn', line]),
        },
    };
    return { ctx, settings, guards, cleanups, logs };
}

describe('module shape', () => {
    it('exports the cordis name and requires the tools service', () => {
        assert.equal(name, 'subagent-toggle');
        assert.deepEqual(inject, ['tools']);
    });
});

describe('settings registration', () => {
    it('registers the namespace with a schema, a base, and NO validate hook', () => {
        const { ctx, settings } = makeCtx();
        install(ctx, { enabled: true });
        assert.equal(settings.registrations.length, 1);
        const registration = settings.registrations[0];
        assert.equal(registration.ns, SETTINGS_NS);
        assert.equal(typeof registration.schema, 'function');
        assert.deepEqual(registration.options.base, { enabled: true });
        // A validate hook would make the host reject writes SILENTLY (the
        // client scope controller recovers without surfacing anything). This
        // assertion exists so the hook never comes back.
        assert.equal(registration.options.validate, undefined);
    });
});

describe('capability guard', () => {
    it('allows subagent tools while the switch is on (the default)', () => {
        const { ctx, guards } = makeCtx();
        install(ctx, { enabled: true });
        assert.equal(guards.length, 1);
        const guard = guards[0];
        assert.equal(guard({ name: 'subagent' }), undefined);
        assert.equal(guard({ name: 'workflow' }), undefined);
    });

    it('denies every blocked tool with the Agent Teams redirect while off', () => {
        const { ctx, settings, guards } = makeCtx();
        install(ctx, { enabled: true });
        settings.set({ enabled: false });
        const guard = guards[0];
        for (const tool of ['subagent', 'subagent_fork', 'subagent_codex', ...DEFAULT_EXTRA_BLOCKED]) {
            const reason = guard({ name: tool });
            assert.equal(typeof reason, 'string', tool);
            assert.match(reason, /agent_teams_create/);
        }
    });

    it('keeps AgentTeams and leftover-child control tools allowed while off', () => {
        const { ctx, settings, guards } = makeCtx();
        install(ctx, { enabled: true });
        settings.set({ enabled: false });
        const guard = guards[0];
        for (const tool of ['agent_teams_create', 'agent_teams_send_message', 'list_agents', 'interrupt_agent']) {
            assert.equal(guard({ name: tool }), undefined, tool);
        }
    });

    it('re-reads the setting on every call, so the switch is live', () => {
        const { ctx, settings, guards } = makeCtx();
        install(ctx, { enabled: true });
        const guard = guards[0];
        assert.equal(guard({ name: 'subagent' }), undefined);
        settings.set({ enabled: false });
        assert.equal(typeof guard({ name: 'subagent' }), 'string');
        settings.set({ enabled: true });
        assert.equal(guard({ name: 'subagent' }), undefined);
    });

    it('honors an extraBlockedTools override', () => {
        const { ctx, settings, guards } = makeCtx();
        install(ctx, { enabled: true, extraBlockedTools: ['workflow'] });
        settings.set({ enabled: false });
        const guard = guards[0];
        assert.equal(typeof guard({ name: 'workflow' }), 'string');
        // Not on the custom list anymore.
        assert.equal(guard({ name: 'ralph' }), undefined);
        // The delegation family is always gated.
        assert.equal(typeof guard({ name: 'subagent' }), 'string');
    });

    it('the effect disposer unregisters the guard', () => {
        const { ctx, guards, cleanups } = makeCtx();
        install(ctx, { enabled: true });
        assert.equal(guards.length, 1);
        assert.equal(cleanups.length >= 1, true);
        for (const cleanup of cleanups) cleanup();
        assert.equal(guards.length, 0);
    });

    it('a second install on the same runtime does not double-register', () => {
        const first = makeCtx();
        const second = makeCtx();
        // Share ONE tools runtime between both installs, like an HMR reload.
        second.ctx.tools = first.ctx.tools;
        install(first.ctx, { enabled: true });
        install(second.ctx, { enabled: true });
        assert.equal(first.guards.length, 1);
    });

    it('stays inert when the composition has no settings service', () => {
        const { ctx, guards } = makeCtx({ withSettings: false });
        install(ctx, { enabled: true });
        assert.equal(guards.length, 1);
        assert.equal(guards[0]({ name: 'subagent' }), undefined);
    });

    it('config enabled:false mounts nothing', () => {
        const { ctx, guards } = makeCtx();
        const handle = install(ctx, { enabled: false });
        assert.equal(guards.length, 0);
        assert.deepEqual(handle.policy(), { enabled: true });
    });

    it('throws when the tools service cannot guard', () => {
        const { ctx } = makeCtx();
        ctx.tools = {};
        assert.throws(() => install(ctx, { enabled: true }), /tools\.guard/);
    });

    it('warns at most once per off-period', () => {
        const { ctx, settings, guards, logs } = makeCtx();
        install(ctx, { enabled: true });
        const guard = guards[0];
        settings.set({ enabled: false });
        guard({ name: 'subagent' });
        guard({ name: 'subagent' });
        assert.equal(logs.filter(([level]) => level === 'warn').length, 1);
        settings.set({ enabled: true });
        guard({ name: 'subagent' });
        settings.set({ enabled: false });
        guard({ name: 'subagent' });
        assert.equal(logs.filter(([level]) => level === 'warn').length, 2);
    });
});
