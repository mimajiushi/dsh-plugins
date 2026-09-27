/**
 * Pure-logic tests for dsh-compact-model.
 *
 * Every rule the plugin applies lives in `lib/logic.js`, so these tests need no
 * DSH runtime and no harness modules at all. They pin the two decisions the
 * plugin's correctness rests on:
 *
 *   1. which fiber is the compaction backend (a miss means no override, a false
 *      positive means rewriting an unrelated plugin's config), and
 *   2. what the replacement config is — the pair rule and "only ever add keys the
 *      backend's schema accepts", because `resolveConfig` rejects unknown keys.
 *
 * @module dsh-compact-model/test/logic
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COMPACTION_CONFIG_KEYS,
    EFFORT_FIELD,
    EFFORT_VALUES,
    MODEL_FIELD,
    PROVIDER_FIELD,
    SETTINGS_NS,
    TARGET_PACKAGE,
    TARGET_ROW_ID,
    asText,
    decideInjection,
    hasRoute,
    identifyTarget,
    isEffortRejection,
    isEngine,
    liveConfig,
    resolveStreamOptions,
    routeOf,
    settingsPatch,
} from '../lib/logic.js';

const pinned = { [PROVIDER_FIELD]: 'kimi-coding', [MODEL_FIELD]: 'k3', [EFFORT_FIELD]: 'high' };
const following = { [PROVIDER_FIELD]: '', [MODEL_FIELD]: '', [EFFORT_FIELD]: '' };

/** Build a fiber-like object for one loader row. */
function fiber(options) {
    return {
        entry: { options },
        runtime: options.pluginName === undefined ? undefined : { callback: { name: options.pluginName } },
    };
}

test('namespace literal is lowercase and matches the settings grammar', () => {
    assert.equal(SETTINGS_NS, 'dsh-compact-model');
    assert.match(SETTINGS_NS, /^[a-z][a-z0-9-]*$/);
});

test('asText trims strings and rejects everything else', () => {
    assert.equal(asText('  a/b  '), 'a/b');
    assert.equal(asText(''), '');
    assert.equal(asText(undefined), '');
    assert.equal(asText(null), '');
    assert.equal(asText(42), '');
});

test('hasRoute requires both halves of the pair', () => {
    assert.equal(hasRoute(pinned), true);
    assert.equal(hasRoute(following), false);
    assert.equal(hasRoute({ [PROVIDER_FIELD]: 'kimi-coding' }), false);
    assert.equal(hasRoute({ [MODEL_FIELD]: 'k3' }), false);
    assert.equal(hasRoute(undefined), false);
    assert.equal(hasRoute({ [PROVIDER_FIELD]: '  ', [MODEL_FIELD]: 'k3' }), false);
});

test('a half-written pair is representable but never reaches the backend', () => {
    // The pair rule is enforced by ONE predicate at the point of use, not by a
    // settings-layer validate hook. That distinction is the bug fix: a validate
    // hook runs on every write, so it made the ordinary intermediate state
    // "provider chosen, model not chosen yet" unwritable, and the browser scope
    // turns a rejected write into a silent re-read (no error, no log, no
    // persistence) -- which is exactly why the card appeared to do nothing.
    const providerOnly = { [PROVIDER_FIELD]: 'kimi-coding', [MODEL_FIELD]: '' };
    const modelOnly = { [PROVIDER_FIELD]: '', [MODEL_FIELD]: 'k3' };
    // Representable: nothing in this module rejects storing either half.
    assert.equal(routeOf(providerOnly).provider, 'kimi-coding');
    assert.equal(providerOnly[MODEL_FIELD], '');
    // ...and inert: neither half is ever injected into the backend.
    for (const settings of [providerOnly, modelOnly, following, pinned]) {
        const verdict = decideInjection({ config: {}, isTarget: true, settings });
        if (hasRoute(settings)) {
            assert.equal(verdict.summarizationProvider, settings[PROVIDER_FIELD]);
            assert.equal(verdict.summarizationModel, settings[MODEL_FIELD]);
        }
        else {
            assert.equal(verdict, null, 'a half-pair must contribute no config at all');
        }
    }
});

test('routeOf always answers with three trimmed strings', () => {
    assert.deepEqual(routeOf(undefined), { provider: '', model: '', reasoningEffort: '' });
    assert.deepEqual(routeOf(pinned), { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'high' });
});

test('identifyTarget matches the loader row name and the plugin name', () => {
    const byPackage = identifyTarget(fiber({ name: TARGET_PACKAGE, id: TARGET_ROW_ID, pluginName: TARGET_ROW_ID }));
    assert.equal(byPackage.isTarget, true);
    assert.deepEqual(byPackage.reasons, ['entry-name', 'plugin-name']);
    assert.equal(byPackage.rowId, TARGET_ROW_ID);

    const byPlugin = identifyTarget(fiber({ name: 'some/other-package', pluginName: TARGET_ROW_ID }));
    assert.equal(byPlugin.isTarget, true);
    assert.deepEqual(byPlugin.reasons, ['plugin-name']);

    // Last-resort signal: only consulted when neither stronger one is available.
    const byRowId = identifyTarget(fiber({ id: TARGET_ROW_ID }));
    assert.equal(byRowId.isTarget, true);
    assert.deepEqual(byRowId.reasons, ['row-id']);
});

test('identifyTarget leaves unrelated fibers and junk alone', () => {
    assert.equal(identifyTarget(fiber({ name: '@deepseek-ai/dsh-compaction-tool-result-pruner' })).isTarget, false);
    assert.equal(identifyTarget(fiber({ id: 'compaction' })).isTarget, false);
    assert.equal(identifyTarget(fiber({})).isTarget, false);
    assert.equal(identifyTarget(undefined).isTarget, false);
    assert.equal(identifyTarget(null).isTarget, false);
    assert.equal(identifyTarget('compaction-basic').isTarget, false);
    // A row id that matches while a different package name is present must NOT match.
    assert.equal(identifyTarget(fiber({ id: TARGET_ROW_ID, name: '@deepseek-ai/dsh-compaction-basic-copy' })).isTarget, false);
});

test('decideInjection contributes nothing while the route follows the session model', () => {
    assert.equal(decideInjection({ config: undefined, isTarget: true, settings: following }), null);
    assert.equal(decideInjection({ config: { auto: false }, isTarget: true, settings: {} }), null);
    assert.equal(decideInjection({ config: undefined, isTarget: false, settings: pinned }), null);
    assert.equal(decideInjection(null), null);
});

test('decideInjection writes exactly the summarization pair', () => {
    const injected = decideInjection({ config: undefined, isTarget: true, settings: pinned });
    assert.deepEqual(injected, {
        summarizationProvider: 'kimi-coding',
        summarizationModel: 'k3',
    });
    // Nothing beyond the backend's own schema may be added: resolveConfig rejects unknown keys.
    for (const key of Object.keys(injected)) {
        assert.equal(COMPACTION_CONFIG_KEYS.includes(key), true, `${key} must be a legal compaction config key`);
    }
    assert.equal(EFFORT_FIELD in injected, false, 'effort cannot ride the config; it is injected at the request');
});

test('decideInjection preserves every existing config key and never mutates the input', () => {
    const original = { thresholdRatio: 0.7, maxTokens: 4096, modelPolicies: [{ provider: 'a', model: 'b' }] };
    const frozen = JSON.parse(JSON.stringify(original));
    const injected = decideInjection({ config: original, isTarget: true, settings: pinned });
    assert.deepEqual(original, frozen, 'the loader-supplied config object must not be mutated');
    assert.equal(injected.thresholdRatio, 0.7);
    assert.equal(injected.maxTokens, 4096);
    assert.deepEqual(injected.modelPolicies, [{ provider: 'a', model: 'b' }]);
    assert.equal(injected.summarizationProvider, 'kimi-coding');
    assert.equal(injected.summarizationModel, 'k3');
});

test('decideInjection replaces an existing pair and survives odd config shapes', () => {
    const replaced = decideInjection({
        config: { summarizationProvider: 'old', summarizationModel: 'legacy', auto: true },
        isTarget: true,
        settings: pinned,
    });
    assert.equal(replaced.summarizationProvider, 'kimi-coding');
    assert.equal(replaced.summarizationModel, 'k3');
    assert.equal(replaced.auto, true);
    // A non-object config becomes a fresh object rather than throwing.
    assert.deepEqual(decideInjection({ config: null, isTarget: true, settings: pinned }), {
        summarizationProvider: 'kimi-coding',
        summarizationModel: 'k3',
    });
});

test('resolveStreamOptions injects effort only into compaction requests', () => {
    const options = { provider: 'kimi-coding', model: 'k3', purpose: 'compaction' };
    const patched = resolveStreamOptions({ options, effort: 'high', disabled: false });
    assert.notEqual(patched, options, 'a copy is returned, never the caller object');
    assert.equal(patched.reasoningEffort, 'high');
    assert.equal(options.reasoningEffort, undefined, 'the original options are untouched');

    for (const purpose of ['chat', 'session-title', undefined]) {
        const untouched = resolveStreamOptions({ options: { ...options, purpose }, effort: 'high', disabled: false });
        assert.equal(untouched.reasoningEffort, undefined);
    }
});

test('resolveStreamOptions is inert without an effort, once disabled, and for junk', () => {
    const options = { purpose: 'compaction' };
    assert.equal(resolveStreamOptions({ options, effort: '', disabled: false }), options);
    assert.equal(resolveStreamOptions({ options, effort: 'high', disabled: true }), options);
    assert.equal(resolveStreamOptions({ options, effort: 'turbo' }), options);
    assert.equal(resolveStreamOptions({ options: undefined, effort: 'high' }), undefined);
    assert.equal(resolveStreamOptions(undefined), undefined);
    assert.equal(EFFORT_VALUES.includes('off'), true, "'off' is a legal effort (disables thinking)");
    const off = resolveStreamOptions({ options, effort: 'off' });
    assert.equal(off.reasoningEffort, 'off');
});

test('isEffortRejection recognises both the code and a message-only failure', () => {
    assert.equal(isEffortRejection({ code: 'UNSUPPORTED_REASONING_EFFORT' }), true);
    assert.equal(isEffortRejection(new Error('DeepSeek does not support reasoning effort "turbo"')), true);
    assert.equal(isEffortRejection(new Error('socket hang up')), false);
    assert.equal(isEffortRejection(undefined), false);
    assert.equal(isEffortRejection('UNSUPPORTED_REASONING_EFFORT'), false);
});

test('settingsPatch reports exactly which fields moved', () => {
    const none = settingsPatch({ prev: pinned, next: pinned });
    assert.deepEqual(none.changedFields, []);
    assert.equal(none.routeChanged, false);
    assert.equal(none.effortChanged, false);

    const route = settingsPatch({ prev: following, next: pinned });
    assert.deepEqual(route.changedFields, [PROVIDER_FIELD, MODEL_FIELD, EFFORT_FIELD]);
    assert.equal(route.routeChanged, true);
    assert.equal(route.effortChanged, true);

    const effortOnly = settingsPatch({ prev: { ...pinned, [EFFORT_FIELD]: '' }, next: pinned });
    assert.deepEqual(effortOnly.changedFields, [EFFORT_FIELD]);
    assert.equal(effortOnly.routeChanged, false);
    assert.equal(effortOnly.effortChanged, true);

    const cleared = settingsPatch({ prev: pinned, next: undefined });
    assert.equal(cleared.routeChanged, true);
    assert.deepEqual(cleared.route, { provider: '', model: '', reasoningEffort: '' });
});

test('liveConfig merges the route over an engine config and freezes the result', () => {
    const engineConfig = Object.freeze({ auto: true, maxTokens: 8192, summarizationProvider: '', summarizationModel: '' });
    const next = liveConfig(engineConfig, pinned);
    assert.equal(next.auto, true);
    assert.equal(next.maxTokens, 8192);
    assert.equal(next.summarizationProvider, 'kimi-coding');
    assert.equal(next.summarizationModel, 'k3');
    assert.equal(Object.isFrozen(next), true);
    assert.equal(engineConfig.summarizationProvider, '', 'the engine config object is left as it was');
    assert.equal(liveConfig(engineConfig, following), null);
    assert.equal(liveConfig(undefined, pinned), null);
});

test('isEngine accepts only an object shaped like the compaction backend', () => {
    const engine = { summarize() {}, compactNow() {}, config: { auto: true } };
    assert.equal(isEngine(engine), true);
    assert.equal(isEngine({ summarize() {}, compactNow() {} }), false);
    assert.equal(isEngine({ summarize() {}, config: {} }), false);
    assert.equal(isEngine(null), false);
    assert.equal(isEngine(() => {}), false);
    assert.equal(isEngine({ summarize: true, compactNow() {}, config: {} }), false);
});
