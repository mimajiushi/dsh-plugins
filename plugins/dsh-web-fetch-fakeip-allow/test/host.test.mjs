/**
 * Host-half wiring tests: the plugin's mount path and the loader contract it must
 * satisfy, driven through a fake cordis context. The `lib/index.js` import needs
 * `@deepseek-ai/schemastery`, which `scripts/install.mjs` links into this package —
 * until then that one test skips instead of failing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BLOCKED_CODE, NAME, install, isPatchedResolver } from '../lib/logic.js';

/** The refusal the shipped provider throws. */
function blockedError() {
    return Object.assign(new Error('URL hostname "docs.godotengine.org" resolves to a non-public IP address'), { code: BLOCKED_CODE });
}

/** `dns.promises.lookup` stand-in returning one fake-ip answer. */
const fakeIpLookup = async () => [{ address: '198.18.0.133', family: 4 }];

/** A provider shaped like the shipped `HttpFetchProvider`. */
function fakeProvider(id = 'http') {
    return {
        id,
        resolveAddresses: async () => {
            throw blockedError();
        },
        available: () => true,
    };
}

/**
 * A cordis host context double. `inject` runs its callback immediately with a scope
 * that mirrors the real one (`web`, `logger`, `effect`), and `reprovide()` simulates
 * the host rebuilding the `web` service after a live patch reload.
 */
function fakeHostContext(providers = [fakeProvider()]) {
    const logs = { info: [], warn: [] };
    const effects = [];
    let registry = new Map(providers.map((provider) => [provider.id, provider]));
    const injectCallbacks = [];
    const ctx = {
        get web() {
            return { fetchProviders: registry };
        },
        logger: {
            info: (message) => logs.info.push(message),
            warn: (message) => logs.warn.push(message),
        },
        effect: (register, label) => {
            effects.push({ register, label });
            return () => {};
        },
        inject: (deps, callback) => {
            assert.deepEqual(deps, ['web']);
            injectCallbacks.push(callback);
            callback(ctx);
        },
    };
    return {
        ctx,
        logs,
        effects,
        get registry() {
            return registry;
        },
        reprovide(next) {
            registry = next;
            for (const callback of injectCallbacks) callback(ctx);
        },
    };
}

test('install() is the mount path used by apply()', () => {
    const host = fakeHostContext();
    const result = install(host.ctx, {}, { lookup: fakeIpLookup });

    assert.deepEqual(result.patchedIds, ['http']);
    assert.equal(host.effects.length, 1);
    assert.equal(host.logs.warn.length, 0);
    assert.match(host.logs.info[0], /^web-fetch-fakeip-allow: patched 1 fetch provider\(s\) \[http\]; allow=198\.18\.0\.0\/15, 2001:2::\/48$/);
    assert.equal(isPatchedResolver(host.registry.get('http').resolveAddresses), true);

    // The registered effect is what undoes the patch when the plugin unloads.
    const patched = host.registry.get('http').resolveAddresses;
    host.effects[0].register()();
    assert.notEqual(host.registry.get('http').resolveAddresses, patched);
});

const hasSchemastery = await import('@deepseek-ai/schemastery').then(() => true, () => false);

test('lib/index.js exports the loader contract and mounts idempotently', {
    skip: hasSchemastery ? false : 'link @deepseek-ai/schemastery first (node scripts/install.mjs)',
}, async () => {
    const mod = await import('../lib/index.js');

    assert.equal(mod.name, NAME, 'the row id and the cordis plugin name stay in sync');
    assert.deepEqual(mod.inject, ['web'], 'the web seam must exist first');
    assert.equal(typeof mod.apply, 'function');
    assert.notEqual(mod.Config, undefined, 'the entry config is validated by a schema');
    assert.equal(typeof mod.install, 'function', 'the policy core is re-exported for diagnostics');

    const host = fakeHostContext();
    mod.apply(host.ctx, {});

    assert.equal(host.logs.warn.length, 0);
    assert.equal(host.logs.info.length, 1, 'the injected callback recognises the registry it already patched');
    assert.match(host.logs.info[0], /patched 1 fetch provider\(s\) \[http\]/);

    const provider = host.registry.get('http');
    const patched = provider.resolveAddresses;
    assert.equal(isPatchedResolver(patched), true, 'the mounted plugin wraps the provider resolver');

    // Mounting again must not stack a second wrapper.
    mod.apply(host.ctx, {});
    assert.equal(provider.resolveAddresses, patched, 'the wrapper is reused');
    assert.match(host.logs.info.at(-1), /patched 0 fetch provider\(s\).*already patched: http/);

    // The web service rebuilt (live patch reload): the fresh registry is patched too.
    const rebuiltProvider = fakeProvider();
    host.reprovide(new Map([['http', rebuiltProvider]]));
    assert.equal(isPatchedResolver(rebuiltProvider.resolveAddresses), true, 'a rebuilt registry is patched again');
});
