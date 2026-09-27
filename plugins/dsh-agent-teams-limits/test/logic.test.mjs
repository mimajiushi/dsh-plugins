/**
 * Pure-logic tests for dsh-agent-teams-limits.
 *
 * `lib/logic.js` imports nothing, so every rule the plugin applies — range
 * clamping, fiber identification, config injection, the live bridge lookup and
 * the prompt note — is pinned here without any DSH runtime.
 *
 * @module dsh-agent-teams-limits/test/logic
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CONCURRENT_MAX,
    LIMITS_SYMBOL_KEY,
    MAX_CONCURRENT_FIELD,
    MAX_MEMBERS_FIELD,
    MEMBERS_MAX,
    PROMPT_SECTION_ORDER,
    SETTINGS_NS,
    TARGET_PACKAGE,
    bridgeApply,
    clampInt,
    findLimitsBridge,
    formatLimits,
    hasLimits,
    identifyAgentTeamsFiber,
    injectLimits,
    isLimitsBridge,
    normalizeLimits,
    promptSectionText,
} from '../lib/logic.js';

test('clampInt accepts integers, rejects junk, clamps out-of-range', () => {
    assert.equal(clampInt(5, 1, 64), 5);
    assert.equal(clampInt('7', 1, 64), 7);
    assert.equal(clampInt(2.9, 0, 32), 2);
    assert.equal(clampInt(-4, 0, 32), 0);
    assert.equal(clampInt(999, 1, 64), 64);
    assert.equal(clampInt(undefined, 0, 32), undefined);
    assert.equal(clampInt(null, 0, 32), undefined);
    assert.equal(clampInt('', 0, 32), undefined);
    assert.equal(clampInt('abc', 0, 32), undefined);
    assert.equal(clampInt(Number.NaN, 0, 32), undefined);
    assert.equal(clampInt(Number.POSITIVE_INFINITY, 0, 32), undefined);
});

test('normalizeLimits keeps absent fields absent (unconfigured = contribute nothing)', () => {
    assert.deepEqual(normalizeLimits(undefined), {});
    assert.deepEqual(normalizeLimits(null), {});
    assert.deepEqual(normalizeLimits({}), {});
    assert.deepEqual(normalizeLimits({ unrelated: 3 }), {});
    assert.deepEqual(normalizeLimits({ [MAX_MEMBERS_FIELD]: 16 }), { maxMembers: 16 });
    assert.deepEqual(normalizeLimits({ [MAX_CONCURRENT_FIELD]: 0 }), { maxConcurrentMembers: 0 });
    assert.deepEqual(normalizeLimits({ [MAX_MEMBERS_FIELD]: 12, [MAX_CONCURRENT_FIELD]: 2 }),
        { maxMembers: 12, maxConcurrentMembers: 2 });
    assert.deepEqual(normalizeLimits({ [MAX_MEMBERS_FIELD]: 999 }), { maxMembers: MEMBERS_MAX });
    assert.deepEqual(normalizeLimits({ [MAX_CONCURRENT_FIELD]: 999 }), { maxConcurrentMembers: CONCURRENT_MAX });
});

test('hasLimits distinguishes "nothing configured" from "0 = unlimited"', () => {
    assert.equal(hasLimits({}), false);
    assert.equal(hasLimits(undefined), false);
    assert.equal(hasLimits({ maxConcurrentMembers: 0 }), true);
    assert.equal(hasLimits({ maxMembers: 8 }), true);
});

test('identifyAgentTeamsFiber recognises the package, the plugin name and the bare row id', () => {
    const byPackage = identifyAgentTeamsFiber({ entry: { options: { id: 'agent-teams', name: TARGET_PACKAGE } } });
    assert.equal(byPackage.isTarget, true);
    assert.deepEqual(byPackage.reasons, ['entry-name']);

    const byPluginName = identifyAgentTeamsFiber({
        entry: { options: { id: 'row-x', name: 'some-other-package' } },
        runtime: { callback: { name: 'agent-teams' } },
    });
    assert.equal(byPluginName.isTarget, true);
    assert.deepEqual(byPluginName.reasons, ['plugin-name']);

    const byRowId = identifyAgentTeamsFiber({ entry: { options: { id: 'agent-teams' } } });
    assert.equal(byRowId.isTarget, true);
    assert.deepEqual(byRowId.reasons, ['row-id']);

    const unrelated = identifyAgentTeamsFiber({ entry: { options: { id: 'compact-model', name: 'dsh-compact-model' } } });
    assert.equal(unrelated.isTarget, false);
    assert.deepEqual(unrelated.reasons, []);
    assert.equal(identifyAgentTeamsFiber(undefined).isTarget, false);
});

test('injectLimits preserves every other key and refuses a pointless rewrite', () => {
    const base = {
        stateDir: '.agent-teams',
        memberProvider: 'spawn',
        memberMaxDepth: 0,
        maxMembers: 8,
        profiles: { 'inline-plan': { members: [] } },
    };
    const injected = injectLimits(base, normalizeLimits({ [MAX_MEMBERS_FIELD]: 16, [MAX_CONCURRENT_FIELD]: 2 }));
    assert.deepEqual(injected, { ...base, maxMembers: 16, maxConcurrentMembers: 2 });
    assert.equal(base.maxMembers, 8, 'the incoming config is never mutated');

    assert.equal(injectLimits(base, {}), null, 'nothing configured = untouched');
    assert.equal(injectLimits(base, normalizeLimits({ [MAX_MEMBERS_FIELD]: 8 })), null, 'same value = untouched');
    assert.deepEqual(
        injectLimits(undefined, normalizeLimits({ [MAX_MEMBERS_FIELD]: 9 })),
        { maxMembers: 9 },
        'a missing config still becomes the injected object',
    );
});

test('isLimitsBridge requires both bridge methods', () => {
    assert.equal(isLimitsBridge(undefined), false);
    assert.equal(isLimitsBridge({}), false);
    assert.equal(isLimitsBridge({ apply: () => 0 }), false);
    assert.equal(isLimitsBridge({ apply: () => 0, read: () => [] }), true);
});

test('findLimitsBridge prefers the fiber namespace and falls back to the global symbol', () => {
    const bridge = { apply: () => 1, read: () => [] };
    const viaFiber = findLimitsBridge({ runtime: { callback: { __limits: bridge } } }, {});
    assert.equal(viaFiber.bridge, bridge);
    assert.equal(viaFiber.via, 'fiber');

    const globalObject = { [Symbol.for(LIMITS_SYMBOL_KEY)]: bridge };
    const viaGlobal = findLimitsBridge({ runtime: { callback: {} } }, globalObject);
    assert.equal(viaGlobal.bridge, bridge);
    assert.equal(viaGlobal.via, 'global');

    assert.equal(findLimitsBridge({}, {}), undefined);
    assert.equal(findLimitsBridge(undefined, undefined), undefined);
});

test('bridgeApply forwards only the configured fields and never throws', () => {
    const seen = [];
    const bridge = { apply: (next) => { seen.push(next); return 3; }, read: () => [] };
    assert.deepEqual(bridgeApply(bridge, normalizeLimits({ [MAX_MEMBERS_FIELD]: 12, [MAX_CONCURRENT_FIELD]: 1 })), { applied: 3 });
    assert.deepEqual(seen[0], { maxMembers: 12, maxConcurrentMembers: 1 });
    assert.deepEqual(bridgeApply(bridge, {}), { applied: 0 });
    assert.deepEqual(bridgeApply(undefined, normalizeLimits({ [MAX_MEMBERS_FIELD]: 12 })).error !== undefined, true);
    const exploding = { apply: () => { throw new Error('boom'); }, read: () => [] };
    assert.equal(bridgeApply(exploding, normalizeLimits({ [MAX_MEMBERS_FIELD]: 12 })).error, 'boom');
    const silent = { apply: () => undefined, read: () => [] };
    assert.deepEqual(bridgeApply(silent, normalizeLimits({ [MAX_MEMBERS_FIELD]: 12 })), { applied: 0 });
});

test('formatLimits and promptSectionText stay empty while nothing is configured', () => {
    assert.equal(formatLimits({}), '(未配置)');
    assert.equal(formatLimits({ maxMembers: 16 }), '成员上限 16');
    assert.equal(formatLimits({ maxMembers: 16, maxConcurrentMembers: 0 }), '成员上限 16、并发不限');
    assert.equal(formatLimits({ maxConcurrentMembers: 2 }), '并发上限 2');

    assert.equal(promptSectionText({}), '', 'an unconfigured plugin must not change the prompt');
    const text = promptSectionText({ maxMembers: 16, maxConcurrentMembers: 2 });
    assert.match(text, /单个团队最多 16 名成员/);
    assert.match(text, /最多 2 名成员同时干活/);
    assert.match(text, new RegExp(SETTINGS_NS));
    assert.equal(PROMPT_SECTION_ORDER > 118, true, 'the note follows the captain protocol (117) and the approval override (118)');
});
