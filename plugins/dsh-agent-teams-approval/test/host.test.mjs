/**
 * Host-half tests: the switch's decision logic and its wiring, with no DSH
 * runtime — `lib/logic.js` takes the two harness modules through `install`'s
 * dependency argument, so every rule is exercised directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CORRECTION_TEXT,
    CREATE_TOOL,
    FLAG_FIELD,
    GUARD_REASON,
    OVERRIDE_TEXT,
    PLUGIN_SOURCE,
    PROMPT_SECTION_ORDER,
    SETTINGS_NS,
    buildSettingsSchema,
    guardReason,
    install,
    promptSectionText,
    resolveSkipApproval,
    withApprovalCorrection,
} from '../lib/logic.js';
import { Config, SettingsSchema } from '../lib/index.js';

/** Minimal schemastery stand-in: records the shape it was asked to build. */
function fakeZ() {
    const boolean = () => {
        const node = { type: 'boolean', defaults: [], meta: {} };
        node.default = (value) => {
            node.defaults.push(value);
            return node;
        };
        return node;
    };
    return { object: (shape) => ({ type: 'object', shape, meta: {} }), boolean };
}

/** Message factory stand-in with the real shape the pre-step decision carries. */
function fakeCreateUserMessage(input) {
    return { id: 'message-1', role: 'user', ...input };
}

/** One command-sourced directive message, as the AgentTeams gesture boundary injects it. */
function commandMessage() {
    return {
        id: 'directive-1',
        role: 'user',
        content: [{ type: 'text', text: 'call agent_teams_create with approval="required"' }],
        source: { kind: 'agent-teams-command' },
    };
}

/** Fake host context that records every registration the plugin makes. */
function fakeHostContext({ failRegister = false } = {}) {
    const calls = { injected: undefined, namespace: undefined, schema: undefined, sections: [], guards: [], listeners: [], effects: [], warnings: [] };
    const scope = {
        value: { [FLAG_FIELD]: false },
        watchers: [],
        get() {
            return this.value;
        },
        watch(callback) {
            this.watchers.push(callback);
            return () => undefined;
        },
    };
    const ctx = {
        logger: { info() {}, warn: (message) => calls.warnings.push(message) },
        effect: (callback, label) => {
            calls.effects.push(label);
            return callback();
        },
        inject: (dependencies, callback) => {
            calls.injected = dependencies;
            callback({
                settings: {
                    register: (namespace, schema) => {
                        if (failRegister) throw new Error('already registered');
                        calls.namespace = namespace;
                        calls.schema = schema;
                        return scope;
                    },
                },
            });
        },
        systemPrompt: {
            section: (section) => {
                calls.sections.push(section);
                return () => undefined;
            },
        },
        tools: {
            guard: (guard) => {
                calls.guards.push(guard);
                return () => undefined;
            },
        },
        on: (event, listener, options) => {
            calls.listeners.push({ event, listener, options });
            return () => undefined;
        },
    };
    const flip = (value) => {
        scope.value = { [FLAG_FIELD]: value };
        for (const watcher of scope.watchers) watcher(scope.value);
    };
    return { ctx, calls, scope, flip };
}

test('settings schema declares the switch as a boolean defaulting to off, and volatile', () => {
    const schema = buildSettingsSchema(fakeZ());
    assert.equal(schema.type, 'object');
    const field = schema.shape[FLAG_FIELD];
    assert.equal(field.type, 'boolean');
    assert.deepEqual(field.defaults, [false]);
    // `meta.volatile` is what makes the 0.1.7 settings provider SERVE this entry at all:
    // its `describe()` drops every entry whose Config has no volatile field, and a
    // namespace that is not described never reaches the client row.
    assert.equal(field.meta.volatile, true, 'the switch field must be marked volatile');
});

test('the exported Config is the volatile switch schema the 0.1.7 loader parses', () => {
    assert.equal(Config, SettingsSchema);
    const field = SettingsSchema.dict[FLAG_FIELD];
    assert.equal(field.meta.default, false);
    assert.equal(field.meta.volatile, true);
});

test('resolveSkipApproval accepts only a literal true in a plain section', () => {
    assert.equal(resolveSkipApproval({ [FLAG_FIELD]: true }), true);
    assert.equal(resolveSkipApproval({ [FLAG_FIELD]: false }), false);
    assert.equal(resolveSkipApproval({ [FLAG_FIELD]: 'true' }), false);
    assert.equal(resolveSkipApproval({}), false);
    assert.equal(resolveSkipApproval(undefined), false);
    assert.equal(resolveSkipApproval(null), false);
});

test('promptSectionText is empty while the switch is off and an override while on', () => {
    assert.equal(promptSectionText(false), '');
    assert.equal(promptSectionText(undefined), '');
    assert.equal(promptSectionText(true), OVERRIDE_TEXT);
    assert.match(OVERRIDE_TEXT, /approval="automatic"/);
    assert.match(OVERRIDE_TEXT, /overrides every earlier AgentTeams instruction/);
});

test('guardReason denies only the staged create call while the switch is on', () => {
    const create = (approval) => ({ name: CREATE_TOOL, arguments: approval === undefined ? {} : { approval } });
    assert.equal(guardReason(false, create('required')), undefined);
    assert.equal(guardReason(true, create('automatic')), undefined);
    assert.equal(guardReason(true, create(undefined)), undefined);
    assert.equal(guardReason(true, { name: 'agent_teams_status', arguments: { approval: 'required' } }), undefined);
    assert.equal(guardReason(true, create('required')), GUARD_REASON);
    assert.match(GUARD_REASON, /approval:"automatic"/);
});

test('withApprovalCorrection appends one control message after a command directive', () => {
    const base = { kind: 'enter', messages: [commandMessage()] };
    assert.equal(withApprovalCorrection(false, base, fakeCreateUserMessage), base);
    assert.equal(withApprovalCorrection(true, { kind: 'reject' }, fakeCreateUserMessage).kind, 'reject');
    const plain = { kind: 'enter', messages: [{ id: 'm', role: 'user', content: [], source: { kind: 'user' } }] };
    assert.equal(withApprovalCorrection(true, plain, fakeCreateUserMessage), plain);
    assert.equal(withApprovalCorrection(true, base, undefined), base);

    const corrected = withApprovalCorrection(true, base, fakeCreateUserMessage);
    assert.equal(corrected.kind, 'enter');
    assert.equal(corrected.messages.length, 2);
    assert.equal(corrected.messages[0], base.messages[0]);
    const appended = corrected.messages[1];
    assert.deepEqual(appended.source, { kind: 'plugin', plugin: PLUGIN_SOURCE });
    assert.equal(appended.role, 'user');
    assert.deepEqual(appended.content, [{ type: 'text', text: CORRECTION_TEXT }]);
    // The original decision stays untouched (the waterfall may still hand it on).
    assert.equal(base.messages.length, 1);

    const twice = withApprovalCorrection(true, corrected, fakeCreateUserMessage);
    assert.equal(twice, corrected);
});

test('install wires the namespace, the prompt section, the guard and the pre-step listener', async () => {
    const { ctx, calls, scope, flip } = fakeHostContext();
    const live = install(ctx, {}, { z: fakeZ(), createUserMessage: fakeCreateUserMessage });

    assert.deepEqual(calls.injected, ['settings']);
    assert.equal(calls.namespace, SETTINGS_NS);
    assert.equal(live.isSkipApproval(), false);

    assert.equal(calls.sections.length, 1);
    const section = calls.sections[0];
    assert.equal(section.name, 'agent-teams-approval:gate');
    assert.equal(section.order, PROMPT_SECTION_ORDER);
    assert.ok(section.order > 117, 'the override must follow the AgentTeams protocol section');
    assert.equal(section.text(), '');

    assert.equal(calls.guards.length, 1);
    const guard = calls.guards[0];
    assert.equal(guard({ name: CREATE_TOOL, arguments: { approval: 'required' } }), undefined);

    assert.equal(calls.listeners.length, 1);
    const listener = calls.listeners[0];
    assert.equal(listener.event, 'agent/pre-step');
    assert.deepEqual(listener.options, { prepend: true });

    const base = { kind: 'enter', messages: [commandMessage()] };
    assert.equal(await listener.listener({}, async () => base), base);

    flip(true);
    assert.equal(live.isSkipApproval(), true);
    assert.equal(section.text(), OVERRIDE_TEXT);
    assert.equal(guard({ name: CREATE_TOOL, arguments: { approval: 'required' } }), GUARD_REASON);
    const corrected = await listener.listener({}, async () => base);
    assert.equal(corrected.messages.length, 2);

    flip(false);
    assert.equal(live.isSkipApproval(), false);
    assert.equal(section.text(), '');
    assert.equal(guard({ name: CREATE_TOOL, arguments: { approval: 'required' } }), undefined);

    assert.ok(scope.watchers.length === 1, 'exactly one settings watcher');
});

test('install tolerates a missing settings service and a failing registration', () => {
    const bare = {
        logger: { info() {}, warn() {} },
        effect: (callback) => callback(),
        systemPrompt: { section: () => () => undefined },
        tools: { guard: () => () => undefined },
        on: () => () => undefined,
    };
    assert.equal(install(bare, {}, { z: fakeZ(), createUserMessage: fakeCreateUserMessage }).isSkipApproval(), false);

    const { ctx, calls } = fakeHostContext({ failRegister: true });
    assert.equal(install(ctx, {}, { z: fakeZ(), createUserMessage: fakeCreateUserMessage }).isSkipApproval(), false);
    assert.equal(calls.warnings.length, 1);
    assert.match(calls.warnings[0], /registration failed/);
});

test('install keeps working on a host whose tool registry has no guard', () => {
    const warnings = [];
    const ctx = {
        logger: { info() {}, warn: (message) => warnings.push(message) },
        effect: (callback) => callback(),
        inject: () => undefined,
        systemPrompt: { section: () => () => undefined },
        tools: { register: () => () => undefined },
        on: () => () => undefined,
    };
    install(ctx, {}, { z: fakeZ(), createUserMessage: fakeCreateUserMessage });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ctx\.tools\.guard is unavailable/);
});
