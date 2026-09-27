/**
 * Host-half wiring tests for dsh-agent-teams-limits.
 *
 * `lib/index.js` is driven through the real `install()` with a recording cordis
 * context, so the contracts that only show up at boot are pinned here:
 *
 *  1. **inject coverage.** `ctx.systemPrompt` is declared; `settings` is taken
 *     through the lazy `ctx.inject` ONLY (declaring a service the composition does
 *     not provide pends the fiber, and declaring one that exists only sometimes
 *     is what used to take the whole plugin tree down). A regression guard also
 *     pins that the settings service is never read off the mount context.
 *  2. **Config injection** through the loader's global `internal/config`
 *     waterfall: only the AgentTeams row is touched, every other key survives, and
 *     an unconfigured plugin returns `next()` untouched.
 *  3. **The live bridge**: a settings edit calls `__limits.apply`, a missing bridge
 *     warns exactly once and names the companion patch.
 *  4. **Prompt section**: empty (and therefore dropped) while nothing is
 *     configured, non-empty once a limit is set.
 *  5. **Degradation**: a context without `on`/`inject`/`systemPrompt` mounts and
 *     logs instead of throwing.
 *
 * @module dsh-agent-teams-limits/test/host
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIMITS_SYMBOL_KEY, MAX_CONCURRENT_FIELD, MAX_MEMBERS_FIELD, SETTINGS_NS, TARGET_PACKAGE } from '../lib/logic.js';
import { install, SettingsSchema, __internals } from '../lib/index.js';

const INDEX_SOURCE = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');

/**
 * Install-time dependencies for the tests: the schema is a stand-in (the service
 * is a double) and the bridge retry window is compressed, so a missing bridge
 * settles inside the test instead of after the production 0.5 s × 24 budget.
 */
const DEPS = { schema: {}, retryDelayMs: 1, retryAttempts: 3 };

/**
 * Build a recording host context.
 * @param options - `{ services }` already registered.
 * @returns the context plus its records.
 */
function fakeContext(options = {}) {
    const services = new Map(Object.entries(options.services ?? {}));
    const waiting = [];
    const lines = { info: [], warn: [] };
    const listeners = new Map();
    const sections = [];
    const effects = [];
    const injections = [];
    const ctx = {
        logger: {
            info: (line) => lines.info.push(String(line)),
            warn: (line) => lines.warn.push(String(line)),
        },
        on(event, listener, opts) {
            listeners.set(event, { listener, opts });
            return () => listeners.delete(event);
        },
        effect(fn, label) {
            const disposer = fn();
            effects.push({ label, disposer });
            return () => {
                if (typeof disposer === 'function') disposer();
            };
        },
        get(name) {
            return services.get(name);
        },
        inject(deps, callback) {
            injections.push({ deps, callback });
            const ready = deps.every((name) => services.has(name));
            if (ready) callback(scopedContext(ctx, services));
            else waiting.push({ deps, callback });
        },
        systemPrompt: {
            section(definition) {
                sections.push(definition);
                return () => undefined;
            },
        },
    };
    return {
        ctx,
        lines,
        listeners,
        sections,
        effects,
        injections,
        /** Register a service and run every injection waiting for it. */
        provide(name, service) {
            services.set(name, service);
            for (const entry of [...waiting]) {
                if (!entry.deps.every((needed) => services.has(needed))) continue;
                waiting.splice(waiting.indexOf(entry), 1);
                entry.callback(scopedContext(ctx, services));
            }
        },
        /**
         * Unmount: run every recorded effect disposer.
         *
         * Needed because the plugin's bridge retry keeps a timer alive; without
         * disposal a test's pending retry could apply through `globalThis` while a
         * later test is running.
         */
        dispose() {
            for (const entry of effects.splice(0)) {
                if (typeof entry.disposer === 'function') entry.disposer();
            }
        },
    };
}

/**
 * A scoped view of the same service registry (what cordis hands an inject callback).
 * @param ctx - the mount context.
 * @param services - the registry.
 * @returns a context whose `settings`/`slots` read through the registry.
 */
function scopedContext(ctx, services) {
    return {
        logger: ctx.logger,
        get: (name) => services.get(name),
        get settings() {
            return services.get('settings');
        },
        systemPrompt: ctx.systemPrompt,
        effect: ctx.effect,
        on: ctx.on,
    };
}

/**
 * A fake settings service: one namespace, one watcher, records every call.
 * @param section - the stored section.
 * @returns `{ service, record }`.
 */
function fakeSettings(section = {}) {
    const record = { registered: [], watched: 0 };
    let current = section;
    let notify;
    const scope = {
        get: () => current,
        watch: (callback) => {
            record.watched += 1;
            notify = callback;
            return () => undefined;
        },
    };
    const service = {
        register(namespace, schema) {
            record.registered.push({ namespace, schema });
            return scope;
        },
    };
    return {
        service,
        record,
        /** Replace the stored section and fire the watcher. */
        update(next) {
            const previous = current;
            current = next;
            if (typeof notify === 'function') notify(next, previous);
        },
    };
}

/** A fake patched-instance bridge, recording what it was told. */
function fakeBridge() {
    const applied = [];
    return {
        bridge: {
            apply: (next) => {
                applied.push(next);
                return 1;
            },
            read: () => [{ maxMembers: 8, maxConcurrentMembers: 0 }],
        },
        applied,
    };
}

/** The AgentTeams fiber, as the waterfall listener receives it (`this`). */
function agentTeamsFiber(overrides = {}) {
    return {
        entry: { options: { id: 'agent-teams', name: TARGET_PACKAGE } },
        runtime: { callback: { name: 'agent-teams' } },
        ...overrides,
    };
}

/**
 * Run one waterfall pass for a fiber.
 * @param host - the fakeContext result.
 * @param config - the config the loader was about to resolve.
 * @param fiber - the emitting fiber.
 * @returns what the listener returned (the injected config, or the `next()` result).
 */
function waterfall(host, config, fiber) {
    const entry = host.listeners.get('internal/config');
    assert.ok(entry, 'the internal/config listener must be installed');
    assert.equal(entry.opts?.global, true, 'the listener must be global (the row may sit in another realm)');
    const untouched = { ...config };
    return entry.listener.call(fiber, config, () => untouched);
}

test('inject declares systemPrompt, keeps settings lazy, and never reads ctx.settings directly', () => {
    const bundle = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
    const declared = /export const inject = \[([^\]]*)\]/u.exec(bundle);
    assert.ok(declared, 'inject must be declared and exported');
    assert.match(declared[1], /'systemPrompt'/);
    assert.doesNotMatch(declared[1], /'settings'/,
        'settings must stay lazy: a declared-but-unprovided service pends the fiber');
    assert.doesNotMatch(INDEX_SOURCE, /ctx\.settings\b/,
        'the settings service is reached through the inject callback only');
    assert.doesNotMatch(INDEX_SOURCE, /ctx\.slots\b|ctx\.llm\b|ctx\.tools\b/,
        'the host half must not touch client-plane or unrelated services');
});

test('listener registration: global internal/config + a prompt section at order 119', () => {
    const host = fakeContext();
    install(host.ctx, {}, DEPS);
    const listener = host.listeners.get('internal/config');
    assert.ok(listener, 'the config waterfall listener is installed');
    assert.equal(listener.opts.global, true);
    assert.equal(host.sections.length, 1, 'one prompt section');
    assert.equal(host.sections[0].order, 119);
    assert.equal(host.sections[0].text(), '', 'unconfigured = empty section (dropped by the registry)');
    assert.equal(host.injections.some((entry) => entry.deps.includes('settings')), true,
        'settings is awaited through the lazy injection');
});

test('unconfigured: unrelated fibers and the AgentTeams row itself are untouched', () => {
    const host = fakeContext();
    install(host.ctx, {}, DEPS);
    const config = { stateDir: '.agent-teams', memberProvider: 'spawn' };
    assert.deepEqual(waterfall(host, config, agentTeamsFiber()), config,
        'nothing configured = next() (the very same object)');
    assert.deepEqual(waterfall(host, config, { entry: { options: { name: 'dsh-compact-model' } } }), config);
    const lines = host.lines.info.join('\n');
    assert.doesNotMatch(lines, /injected/, 'nothing is injected while no limit is configured');
    assert.match(lines, /recognised the AgentTeams row/, 'recognition is logged as boot evidence either way');
    assert.equal(host.lines.warn.length, 0, 'no bridge warning while nothing is configured');
});

test('entry config sets the limits: the AgentTeams row is injected with every key preserved', () => {
    const host = fakeContext();
    install(host.ctx, { maxMembers: 16, maxConcurrentMembers: 2 }, DEPS);
    const config = {
        stateDir: '.agent-teams',
        memberProvider: 'spawn',
        memberMaxDepth: 0,
        maxMembers: 8,
        profiles: { 'inline-plan': { members: [] } },
    };
    const injected = waterfall(host, config, agentTeamsFiber());
    assert.deepEqual(injected, { ...config, maxMembers: 16, maxConcurrentMembers: 2 });
    assert.equal(config.maxMembers, 8, 'the incoming config object is never mutated');
    assert.match(host.lines.info.join('\n'), /recognised the AgentTeams row via entry-name/);
    assert.match(host.lines.info.join('\n'), /injected .*at load time/);
    // A second (re)load with the same values must not rewrite the config.
    assert.deepEqual(waterfall(host, { ...config, maxMembers: 16, maxConcurrentMembers: 2 }, agentTeamsFiber()),
        { ...config, maxMembers: 16, maxConcurrentMembers: 2 });
    host.dispose();
});

test('settings edit is applied live through the fiber bridge, without a restart', () => {
    const bridge = fakeBridge();
    const fiber = agentTeamsFiber({ runtime: { callback: { name: 'agent-teams', __limits: bridge.bridge } } });
    const host = fakeContext();
    install(host.ctx, {}, DEPS);
    waterfall(host, { stateDir: '.agent-teams' }, fiber);

    const settings = fakeSettings({});
    host.provide('settings', settings.service);
    assert.deepEqual(settings.record.registered.map((entry) => entry.namespace), [SETTINGS_NS]);

    settings.update({ maxMembers: 12, maxConcurrentMembers: 1 });
    assert.deepEqual(bridge.applied, [{ maxMembers: 12, maxConcurrentMembers: 1 }]);
    const text = host.sections[0].text();
    assert.match(text, /单个团队最多 12 名成员/);
    assert.match(text, /最多 1 名成员同时干活/);

    // The next load of the row gets the same numbers from the config path.
    const injected = waterfall(host, { stateDir: '.agent-teams' }, fiber);
    assert.deepEqual(injected, { stateDir: '.agent-teams', maxMembers: 12, maxConcurrentMembers: 1 });
    host.dispose();
});

test('the global bridge symbol works when the fiber namespace carries none', () => {
    const bridge = fakeBridge();
    const previous = globalThis[Symbol.for(LIMITS_SYMBOL_KEY)];
    globalThis[Symbol.for(LIMITS_SYMBOL_KEY)] = bridge.bridge;
    try {
        const host = fakeContext();
        install(host.ctx, { maxMembers: 20 }, DEPS);
        waterfall(host, {}, agentTeamsFiber());
        const settings = fakeSettings({});
        host.provide('settings', settings.service);
        // The mount pass already carried the entry-config value through the global
        // bridge; the settings edit must land on top of it.
        assert.deepEqual(bridge.applied[0], { maxMembers: 20 });
        settings.update({ maxConcurrentMembers: 3 });
        assert.deepEqual(bridge.applied.at(-1), { maxConcurrentMembers: 3 });
        assert.match(host.lines.info.join('\n'), /bridge via global/);
        host.dispose();
    }
    finally {
        if (previous === undefined) delete globalThis[Symbol.for(LIMITS_SYMBOL_KEY)];
        else globalThis[Symbol.for(LIMITS_SYMBOL_KEY)] = previous;
    }
});

test('a bridge published after our own mount is picked up by the bounded retry', async () => {
    const previous = globalThis[Symbol.for(LIMITS_SYMBOL_KEY)];
    if (previous !== undefined) delete globalThis[Symbol.for(LIMITS_SYMBOL_KEY)];
    try {
        const host = fakeContext();
        install(host.ctx, { maxMembers: 16 }, DEPS);
        // Plugin rows activate in parallel: the row (and with it the bridge) may load
        // after us. Recognising the row starts a bounded retry, and nothing is
        // reported while the row legitimately has not mounted yet.
        waterfall(host, { stateDir: '.agent-teams' }, agentTeamsFiber());
        assert.equal(host.lines.warn.length, 0, 'no false "patch missing" alarm during a normal boot');

        const bridge = fakeBridge();
        globalThis[Symbol.for(LIMITS_SYMBOL_KEY)] = bridge.bridge;
        await new Promise((resolve) => { setTimeout(resolve, 30); });
        assert.deepEqual(bridge.applied, [{ maxMembers: 16 }], 'the retry applies once the bridge exists');
        assert.match(host.lines.info.join('\n'), /live-applied/);
        assert.equal(host.lines.warn.length, 0);
        host.dispose();
    }
    finally {
        if (previous === undefined) delete globalThis[Symbol.for(LIMITS_SYMBOL_KEY)];
        else globalThis[Symbol.for(LIMITS_SYMBOL_KEY)] = previous;
    }
});

test('a genuinely missing bridge is reported once, after the retry window is spent', async () => {
    const previous = globalThis[Symbol.for(LIMITS_SYMBOL_KEY)];
    if (previous !== undefined) delete globalThis[Symbol.for(LIMITS_SYMBOL_KEY)];
    try {
        const host = fakeContext();
        install(host.ctx, { maxMembers: 16 }, { schema: {}, retryAttempts: 2, retryDelayMs: 1 });
        waterfall(host, { stateDir: '.agent-teams' }, agentTeamsFiber());
        await new Promise((resolve) => { setTimeout(resolve, 30); });
        const warnings = host.lines.warn.filter((line) => line.includes('patch-agent-teams-limits.mjs'));
        assert.equal(warnings.length, 1, 'settled once, and only once');
        assert.match(warnings[0], /member cap applies at the next start/);
        host.dispose();
    }
    finally {
        if (previous === undefined) delete globalThis[Symbol.for(LIMITS_SYMBOL_KEY)];
        else globalThis[Symbol.for(LIMITS_SYMBOL_KEY)] = previous;
    }
});

test('a missing bridge warns once, names the companion patch, and never throws', () => {
    const host = fakeContext();
    install(host.ctx, { maxMembers: 16, maxConcurrentMembers: 2 }, DEPS);
    waterfall(host, { stateDir: '.agent-teams' }, agentTeamsFiber());
    const settings = fakeSettings({});
    host.provide('settings', settings.service);
    settings.update({ maxMembers: 16, maxConcurrentMembers: 2 });
    settings.update({ maxMembers: 14, maxConcurrentMembers: 2 });
    const warnings = host.lines.warn.filter((line) => line.includes('patch-agent-teams-limits.mjs'));
    assert.equal(warnings.length, 1, 'exactly one warning, not one per edit');
    assert.equal(host.lines.info.some((line) => line.includes('live-applied')), false);
    host.dispose();
});

test('degradation: no on/inject/systemPrompt still mounts and logs', () => {
    const lines = [];
    const bare = { logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) } };
    const runtime = install(bare, {}, DEPS);
    assert.deepEqual(runtime.limits(), {});
    assert.equal(lines.some((line) => line.includes('no lazy injection')), true);
    assert.equal(lines.some((line) => line.includes('no system-prompt registry')), true);
});

test('unknown extras in the entry config are ignored, and the schema is exported', () => {
    // schemastery schemas are callable objects, not plain data.
    assert.ok(SettingsSchema, 'a settings schema is exported');
    assert.equal(typeof SettingsSchema, 'function');
    assert.equal(__internals.SettingsSchema, SettingsSchema);
    assert.deepEqual(__internals.entrySection({ maxMembers: 6, junk: 1 }), { maxMembers: 6, maxConcurrentMembers: undefined });
    assert.equal(__internals.configIsLive({ maxMembers: 6 }), false);
    const live = { maxMembers: { get: () => 9 } };
    assert.equal(__internals.configIsLive(live), true);
    assert.deepEqual(__internals.entrySection(live), { maxMembers: 9, maxConcurrentMembers: undefined });
});

test('a throwing settings service cannot take the mount down', () => {
    const host = fakeContext();
    install(host.ctx, {}, DEPS);
    host.provide('settings', {
        register() {
            throw new Error('registration refused');
        },
    });
    assert.equal(host.lines.warn.some((line) => line.includes('registration failed')), true);
});

test('field names stay in sync with the companion patch and the card', () => {
    const patch = readFileSync(fileURLToPath(new URL('../scripts/patch-agent-teams-limits.mjs', import.meta.url)), 'utf8');
    assert.match(patch, new RegExp(`maxConcurrentMembers: z\\.natural\\(\\)\\.default\\(0\\)`),
        'the patched AgentTeams schema must declare the same field');
    assert.match(patch, /Symbol\.for\('dsh\.agent-teams\.limits'\)/);
    assert.equal(LIMITS_SYMBOL_KEY, 'dsh.agent-teams.limits');
    assert.equal(MAX_MEMBERS_FIELD, 'maxMembers');
    assert.equal(MAX_CONCURRENT_FIELD, 'maxConcurrentMembers');
});
