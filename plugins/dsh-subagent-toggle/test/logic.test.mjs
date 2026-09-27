/**
 * Unit tests for dsh-subagent-toggle/lib/logic.js — the pure decision layer.
 * No DSH runtime needed; every rule is a function of its inputs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    DEFAULT_EXTRA_BLOCKED,
    ENABLED_FIELD,
    NAME,
    SETTINGS_NS,
    denialText,
    guardDecision,
    isBlockedToolName,
    isSubagentToolName,
    parsePolicy,
    resolvePluginConfig,
} from '../lib/logic.js';

describe('identity constants', () => {
    it('names the cordis row, the settings namespace, and the field', () => {
        assert.equal(NAME, 'subagent-toggle');
        assert.equal(SETTINGS_NS, 'dsh-subagent-toggle');
        assert.equal(ENABLED_FIELD, 'enabled');
    });

    it('ships the agreed default block list', () => {
        assert.deepEqual(DEFAULT_EXTRA_BLOCKED, ['workflow', 'ralph', 'list_subagent_models', 'send_message']);
    });
});

describe('isSubagentToolName', () => {
    it('matches the delegation family', () => {
        assert.equal(isSubagentToolName('subagent'), true);
        assert.equal(isSubagentToolName('subagent_fork'), true);
        assert.equal(isSubagentToolName('subagent_codex'), true);
        assert.equal(isSubagentToolName('subagent_claude_code'), true);
    });

    it('excludes reporting tools in the same family', () => {
        assert.equal(isSubagentToolName('subagent_report'), false);
        assert.equal(isSubagentToolName('subagent_report_result'), false);
    });

    it('rejects everything else, including AgentTeams and control tools', () => {
        for (const name of [
            'agent_teams_create', 'agent_teams_send_message', 'agent_teams_status',
            'list_agents', 'interrupt_agent', 'list_subagent_models',
            'workflow', 'ralph', 'send_message', 'pwsh', 'create_goal',
            '', 'sub', 'subagentx',
        ]) {
            assert.equal(isSubagentToolName(name), false, name);
        }
    });

    it('rejects non-strings', () => {
        assert.equal(isSubagentToolName(undefined), false);
        assert.equal(isSubagentToolName(null), false);
        assert.equal(isSubagentToolName(42), false);
    });
});

describe('isBlockedToolName', () => {
    const extras = [...DEFAULT_EXTRA_BLOCKED];

    it('blocks the delegation family regardless of extras', () => {
        assert.equal(isBlockedToolName('subagent', []), true);
        assert.equal(isBlockedToolName('subagent_fork', []), true);
    });

    it('blocks the agreed extra tools', () => {
        for (const name of extras) {
            assert.equal(isBlockedToolName(name, extras), true, name);
        }
    });

    it('leaves AgentTeams and the leftover-child control tools allowed', () => {
        for (const name of ['agent_teams_create', 'agent_teams_send_message', 'list_agents', 'interrupt_agent']) {
            assert.equal(isBlockedToolName(name, extras), false, name);
        }
    });

    it('tolerates a missing extras array', () => {
        assert.equal(isBlockedToolName('workflow', undefined), false);
        assert.equal(isBlockedToolName('subagent', undefined), true);
    });
});

describe('parsePolicy', () => {
    it('is ON unless the section explicitly says enabled: false', () => {
        assert.deepEqual(parsePolicy({ enabled: false }), { enabled: false });
        assert.deepEqual(parsePolicy({ enabled: true }), { enabled: true });
        assert.deepEqual(parsePolicy({}), { enabled: true });
        assert.deepEqual(parsePolicy(undefined), { enabled: true });
        assert.deepEqual(parsePolicy(null), { enabled: true });
        assert.deepEqual(parsePolicy('junk'), { enabled: true });
        // A truthy-but-wrong value is still ON: only `false` switches off.
        assert.deepEqual(parsePolicy({ enabled: 0 }), { enabled: true });
    });
});

describe('denialText', () => {
    it('redirects to Agent Teams and names the switch location', () => {
        const text = denialText('subagent');
        assert.match(text, /`subagent`/);
        assert.match(text, /agent_teams_create/);
        assert.match(text, /agent_teams_send_message/);
        assert.match(text, /interrupt_agent/);
        assert.match(text, /Subagent 开关/);
    });

    it('survives a missing tool name', () => {
        const text = denialText(undefined);
        assert.match(text, /agent_teams_create/);
    });
});

describe('guardDecision', () => {
    const off = { enabled: false };
    const on = { enabled: true };
    const extras = [...DEFAULT_EXTRA_BLOCKED];

    it('allows everything while the switch is on', () => {
        for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph', 'send_message', 'list_subagent_models']) {
            assert.equal(guardDecision({ name }, on, extras), undefined, name);
        }
    });

    it('denies every blocked tool while the switch is off', () => {
        for (const name of ['subagent', 'subagent_fork', 'subagent_codex', 'workflow', 'ralph', 'send_message', 'list_subagent_models']) {
            const reason = guardDecision({ name }, off, extras);
            assert.equal(typeof reason, 'string', name);
            assert.match(reason, /agent_teams_create/);
        }
    });

    it('never denies AgentTeams or the leftover-child control tools', () => {
        for (const name of ['agent_teams_create', 'agent_teams_add_member', 'list_agents', 'interrupt_agent', 'pwsh']) {
            assert.equal(guardDecision({ name }, off, extras), undefined, name);
        }
    });

    it('tolerates malformed executions', () => {
        assert.equal(guardDecision(undefined, off, extras), undefined);
        assert.equal(guardDecision(null, off, extras), undefined);
        assert.equal(guardDecision({}, off, extras), undefined);
    });
});

describe('resolvePluginConfig', () => {
    it('fills defaults from an empty/absent config', () => {
        assert.deepEqual(resolvePluginConfig(undefined), {
            enabled: true,
            extraBlockedTools: [...DEFAULT_EXTRA_BLOCKED],
        });
        assert.deepEqual(resolvePluginConfig(null).enabled, true);
        assert.deepEqual(resolvePluginConfig({}).extraBlockedTools, [...DEFAULT_EXTRA_BLOCKED]);
    });

    it('honors an explicit override', () => {
        const resolved = resolvePluginConfig({ enabled: false, extraBlockedTools: ['workflow'] });
        assert.equal(resolved.enabled, false);
        assert.deepEqual(resolved.extraBlockedTools, ['workflow']);
    });

    it('fails loud on typos', () => {
        assert.throws(() => resolvePluginConfig({ enabled: 'yes' }), /enabled/);
        assert.throws(() => resolvePluginConfig({ extraBlockedTools: 'workflow' }), /extraBlockedTools/);
        assert.throws(() => resolvePluginConfig({ extraBlockedTools: [''] }), /extraBlockedTools/);
    });
});
