/**
 * Mount tests against the REAL cordis runtime, not a fake context.
 *
 * `host.test.mjs` runs `apply` over a hand-written context double, so it cannot
 * see the one thing that broke the plugin in the loader: a context property read
 * for a service the plugin never declared. Cordis' context proxy raises
 * `cannot get property "<name>" without inject` for that read, and because the
 * loader row for this plugin is a SIBLING of the `llm` row (both are inserted
 * into the same composition root), no ancestor offers the service either — the
 * throw unwound the whole plugin tree at boot.
 *
 * These tests therefore provide `llm` from a sibling fiber and mount the plugin
 * through the real registry, which is the shape the harness produces.
 *
 * @module dsh-compact-model/test/inject
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { EFFORT_FIELD, MODEL_FIELD, PROVIDER_FIELD } from '../lib/logic.js';
import { __internals, apply, inject as declaredInject, name } from '../lib/index.js';

/** A streaming LLM runtime double, as `LlmRuntime` is seen from a context. */
function fakeLlm() {
    return {
        calls: [],
        stream(options) {
            this.calls.push(options);
            return { async *[Symbol.asyncIterator]() {} };
        },
    };
}

/** Pin a compaction route so the effort wrapper has something to inject. */
function pinRoute(effort) {
    __internals.state.settings = {
        [PROVIDER_FIELD]: 'kimi-coding',
        [MODEL_FIELD]: 'k3',
        [EFFORT_FIELD]: effort,
    };
}

/** Mount the plugin's host half as a loader row would. */
function mountPlugin(ctx) {
    return ctx.plugin({ name, inject: declaredInject, apply });
}

test('the plugin is reachable through the module surface the loader uses', () => {
    assert.deepEqual(declaredInject, [], 'the plugin still requires no service to mount');
});

test('mounting beside a sibling llm row patches the runtime instead of failing the tree', async () => {
    const root = new Context();
    const llm = fakeLlm();
    root.plugin((ctx) => {
        ctx.provide('llm', llm);
    });

    await mountPlugin(root);

    assert.equal(llm.__compactModelPatched, true);

    pinRoute('high');
    llm.stream({ purpose: 'compaction' });
    llm.stream({ purpose: 'chat' });
    llm.stream({ purpose: 'session-title' });

    assert.equal(llm.calls[0].reasoningEffort, 'high');
    assert.equal(llm.calls[1].reasoningEffort, undefined);
    assert.equal(llm.calls[2].reasoningEffort, undefined);
});

test('an llm row that appears after the plugin still gets patched', async () => {
    const root = new Context();
    const llm = fakeLlm();

    const mounted = mountPlugin(root);
    assert.equal(llm.__compactModelPatched, undefined, 'nothing to patch yet');

    root.plugin((ctx) => {
        ctx.provide('llm', llm);
    });
    await mounted;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(llm.__compactModelPatched, true);
});

test('a runtime without a stream method is left alone instead of breaking the tree', async () => {
    const root = new Context();
    root.plugin((ctx) => {
        ctx.provide('llm', { resolveModelInfo: async () => ({}) });
    });

    await mountPlugin(root);
});
