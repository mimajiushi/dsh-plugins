/**
 * Policy-core tests: every rule this plugin applies, with no DSH runtime and no
 * network — the DNS lookup is injected, so the fake-ip path is exercised directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BLOCKED_CODE,
    DEFAULT_ALLOW,
    NAME,
    acceptFakeIpAnswerSet,
    install,
    ipv4InRanges,
    ipv6InRanges,
    isBlockedUrl,
    isPatchedResolver,
    parseCidr,
    parseCidr6,
    parseIpv4,
    parseIpv6,
    parseRange,
    parseRanges,
    patchProvider,
    patchRegistry,
    resolveWithFakeIpAllowance,
} from '../lib/logic.js';

/** The refusal the shipped provider throws: an Error carrying a stable code. */
function blockedError(hostname = 'docs.godotengine.org') {
    return Object.assign(new Error(`URL hostname "${hostname}" resolves to a non-public IP address`), {
        code: BLOCKED_CODE,
        name: 'WebError',
    });
}

/** A DNS answer set in the shape `dns.promises.lookup(host, { all: true })` returns. */
function answers(...addresses) {
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

/** A resolver that returns `result`, or throws `error`. */
function resolverOf({ result, error }) {
    const calls = [];
    const resolve = async (hostname, signal) => {
        calls.push({ hostname, signal });
        if (error !== undefined) throw error;
        return result;
    };
    return { resolve, calls };
}

/** A lookup stand-in recording every call. */
function lookupOf(entries) {
    const calls = [];
    const lookup = async (hostname, options) => {
        calls.push({ hostname, options });
        if (entries instanceof Error) throw entries;
        return entries;
    };
    return { lookup, calls };
}

/** An in-memory copy of `ctx.web.fetchProviders`. */
function fakeRegistry(providers = []) {
    const registry = new Map(providers.map((provider) => [provider.id, provider]));
    return registry;
}

/** A provider shaped like the shipped `HttpFetchProvider`. */
function fakeProvider(id, resolveAddresses) {
    return { id, resolveAddresses, available: () => true };
}

const { ranges: defaultRanges } = parseRanges(DEFAULT_ALLOW);

test('module identity', () => {
    assert.equal(NAME, 'web-fetch-fakeip-allow');
    assert.deepEqual(DEFAULT_ALLOW, ['198.18.0.0/15', '2001:2::/48'], 'both fake-ip pools are relaxed by default');
    assert.equal(BLOCKED_CODE, 'WEB_BLOCKED_URL');
});

test('parseIpv4 encodes a dotted quad and rejects anything else', () => {
    assert.equal(parseIpv4('0.0.0.0'), 0);
    assert.equal(parseIpv4('255.255.255.255'), 4294967295);
    assert.equal(parseIpv4('198.18.0.133'), 198 * 2 ** 24 + 18 * 2 ** 16 + 133);
    assert.equal(parseIpv4(' 10.0.0.1 '), 10 * 2 ** 24 + 1);
    for (const bad of ['198.18.0', '198.18.0.256', 'a.b.c.d', '', '1.2.3.4.5', '::1', undefined, 42, null]) {
        assert.equal(parseIpv4(bad), undefined, `should reject ${String(bad)}`);
    }
});

test('parseIpv6 encodes an address and rejects anything else', () => {
    assert.equal(parseIpv6('::'), 0n);
    assert.equal(parseIpv6('::1'), 1n);
    assert.equal(parseIpv6('2001:2::24'), (0x2001n << 112n) | (0x2n << 96n) | 0x24n);
    assert.equal(parseIpv6('2001:02::0024'), parseIpv6('2001:2::24'), 'leading zeros are not significant');
    assert.equal(parseIpv6('2001:2:0:0:0:0:0:24'), parseIpv6('2001:2::24'), 'the expanded form matches');
    assert.equal(parseIpv6('::ffff:198.18.0.38'), parseIpv6('::ffff:c612:26'), 'the mixed form is equivalent');
    assert.equal(parseIpv6('2001:DB8::1'), parseIpv6('2001:db8::1'), 'either case');
    for (const bad of [
        ':::', '1:::2', '12345::1', '2001:2::24::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9',
        'fe80::1%eth0', '198.18.0.38', '2001:2::24/48', '::ffff:999.1.1.1', '', undefined, 42, null,
    ]) {
        assert.equal(parseIpv6(bad), undefined, `should reject ${String(bad)}`);
    }
});

test('parseCidr normalizes a block and rejects malformed ones', () => {
    assert.deepEqual(parseCidr('198.18.0.0/15'), {
        base: parseIpv4('198.18.0.0'),
        mask: 0xfffe0000,
        prefix: 15,
        text: '198.18.0.0/15',
    });
    assert.equal(parseCidr('198.18.5.7/15').base, parseIpv4('198.18.0.0'), 'base is masked down');
    assert.equal(parseCidr('10.0.0.0/0').mask, 0);
    assert.equal(parseCidr('10.0.0.0/32').mask, 0xffffffff);
    assert.equal(parseCidr(' 10.0.0.0/8 ').text, '10.0.0.0/8');
    for (const bad of ['10.0.0.0/33', '10.0.0.0', '10.0.0.0/8/9', '10.0.0.0/x', '10.0.0.256/8', undefined, 8]) {
        assert.equal(parseCidr(bad), undefined, `should reject ${String(bad)}`);
    }
});

test('parseCidr6 normalizes a block and parseRange tags either family', () => {
    const range = parseCidr6('2001:2::/48');
    assert.equal(range.family, 6);
    assert.equal(range.prefix, 48);
    assert.equal(range.base, parseIpv6('2001:2::'));
    assert.equal(range.mask, parseIpv6('ffff:ffff:ffff::'), '48 leading bits set');
    assert.equal(parseCidr6('2001:2::24/48').base, parseIpv6('2001:2::'), 'base is masked down');
    assert.equal(parseCidr6('::/0').mask, 0n);
    assert.equal(parseCidr6('2001:2::1/128').mask, (1n << 128n) - 1n);
    assert.equal(parseCidr6(' 2001:2::/64 ').text, '2001:2::/64', 'mihomo pins the narrower pool');
    for (const bad of ['2001:2::/129', '2001:2::', '2001:2::/48/9', '2001:2::/x', '198.18.0.0/15', undefined, 8]) {
        assert.equal(parseCidr6(bad), undefined, `should reject ${String(bad)}`);
    }

    assert.equal(parseRange('198.18.0.0/15').family, 4);
    assert.equal(parseRange('2001:2::/48').family, 6);
    assert.equal(parseRange('not-a-cidr'), undefined);
});

test('parseRanges keeps the valid blocks and reports the rest', () => {
    const { ranges, rejected } = parseRanges(['198.18.0.0/15', 'not-a-cidr', '10.0.0.0/8', '::/129']);
    assert.deepEqual(ranges.map((range) => range.text), ['198.18.0.0/15', '10.0.0.0/8']);
    assert.deepEqual(ranges.map((range) => range.family), [4, 4]);
    assert.deepEqual(rejected, ['not-a-cidr', '::/129']);
    assert.deepEqual(parseRanges(undefined), { ranges: [], rejected: [] });

    const mixed = parseRanges(['198.18.0.0/15', '2001:2::/48']);
    assert.deepEqual(mixed.ranges.map((range) => range.family), [4, 6], 'a list may hold both families');
});

test('ipv4InRanges tests block membership', () => {
    assert.equal(ipv4InRanges('198.18.0.133', defaultRanges), true);
    assert.equal(ipv4InRanges('198.18.0.1', defaultRanges), true);
    assert.equal(ipv4InRanges('198.19.255.255', defaultRanges), true, '/15 spans 198.18 and 198.19');
    assert.equal(ipv4InRanges('198.17.255.255', defaultRanges), false);
    assert.equal(ipv4InRanges('198.20.0.1', defaultRanges), false);
    assert.equal(ipv4InRanges('127.0.0.1', defaultRanges), false);
    assert.equal(ipv4InRanges('10.0.0.1', defaultRanges), false);
    assert.equal(ipv4InRanges('::1', defaultRanges), false);
});

test('ipv6InRanges tests block membership and never crosses families', () => {
    const { ranges } = parseRanges(['2001:2::/48']);
    assert.equal(ipv6InRanges('2001:2::24', ranges), true);
    assert.equal(ipv6InRanges('2001:2:0:0:ffff::1', ranges), true, '/48 keeps the first three groups');
    assert.equal(ipv6InRanges('2001:2::1', ranges), true);
    assert.equal(ipv6InRanges('2001:3::1', ranges), false);
    assert.equal(ipv6InRanges('2001:db8::1', ranges), false, 'the documentation prefix is not a fake-ip pool');
    assert.equal(ipv6InRanges('::1', ranges), false);
    assert.equal(ipv6InRanges('fe80::1', ranges), false, 'link-local stays blocked');
    assert.equal(ipv6InRanges('198.18.0.38', ranges), false, 'an IPv4 answer never matches an IPv6 pool');
    assert.equal(ipv4InRanges('198.18.0.38', ranges), false, 'nor the other way round');
});

test('isBlockedUrl recognizes only the provider refusal', () => {
    assert.equal(isBlockedUrl(blockedError()), true);
    assert.equal(isBlockedUrl(Object.assign(new Error('x'), { code: 'WEB_PROVIDER_ERROR' })), false);
    assert.equal(isBlockedUrl(new Error('URL hostname "x" resolves to a non-public IP address')), true, 'message fallback');
    assert.equal(isBlockedUrl(new Error('something else')), false);
    for (const bad of [undefined, null, 'boom', 42]) assert.equal(isBlockedUrl(bad), false);
});

test('acceptFakeIpAnswerSet is all-or-nothing', () => {
    assert.deepEqual(acceptFakeIpAnswerSet(answers('198.18.0.133'), defaultRanges), [{ address: '198.18.0.133', family: 4 }]);
    assert.deepEqual(acceptFakeIpAnswerSet(answers('198.18.0.62', '198.18.0.140'), defaultRanges), [
        { address: '198.18.0.62', family: 4 },
        { address: '198.18.0.140', family: 4 },
    ]);
    assert.equal(acceptFakeIpAnswerSet(answers('198.18.0.133', '127.0.0.1'), defaultRanges), undefined, 'mixed set refused');
    assert.equal(acceptFakeIpAnswerSet(answers('127.0.0.1'), defaultRanges), undefined);
    assert.equal(acceptFakeIpAnswerSet(answers('10.0.0.1'), defaultRanges), undefined);
    assert.equal(acceptFakeIpAnswerSet(answers('2001:db8::1'), defaultRanges), undefined, 'IPv6 outside every configured pool');
    assert.equal(acceptFakeIpAnswerSet(answers('198.18.0.133'), []), undefined);
    assert.equal(acceptFakeIpAnswerSet([], defaultRanges), undefined);
    assert.equal(acceptFakeIpAnswerSet([null], defaultRanges), undefined);
    assert.equal(acceptFakeIpAnswerSet('198.18.0.133', defaultRanges), undefined);
});

test('a dual-stack fake-ip answer set is accepted when both pools are configured', async () => {
    const dual = answers('198.18.0.38', '2001:2::24');
    assert.deepEqual(
        acceptFakeIpAnswerSet(dual, defaultRanges),
        [{ address: '198.18.0.38', family: 4 }, { address: '2001:2::24', family: 6 }],
        'the live mihomo answer for api.github.com with dns.ipv6 enabled',
    );

    // The same set against an IPv4-only list is refused — that was the reported failure.
    const ipv4Only = parseRanges(['198.18.0.0/15']).ranges;
    assert.equal(acceptFakeIpAnswerSet(dual, ipv4Only), undefined, 'an AAAA placeholder has no pool to match');

    // A family outside every configured pool still refuses the whole set.
    assert.equal(acceptFakeIpAnswerSet(answers('198.18.0.38', '2001:db8::1'), defaultRanges), undefined);
    assert.equal(acceptFakeIpAnswerSet(answers('2001:2::24', '192.168.1.10'), defaultRanges), undefined);

    // …and the resolver really hands that set to the provider.
    const resolve = resolveWithFakeIpAllowance(
        resolverOf({ error: blockedError('api.github.com') }).resolve,
        { ranges: defaultRanges },
        lookupOf(dual).lookup,
    );
    assert.deepEqual(await resolve('api.github.com', undefined), [
        { address: '198.18.0.38', family: 4 },
        { address: '2001:2::24', family: 6 },
    ]);
});

test('a public destination keeps the original resolver untouched', async () => {
    const original = resolverOf({ result: [{ address: '93.184.216.34', family: 4 }] });
    const { lookup, calls } = lookupOf(answers('198.18.0.133'));
    const resolve = resolveWithFakeIpAllowance(original.resolve, { ranges: defaultRanges }, lookup);

    const resolved = await resolve('example.com', undefined);

    assert.deepEqual(resolved, [{ address: '93.184.216.34', family: 4 }]);
    assert.equal(calls.length, 0, 'no re-resolution on the fast path');
    assert.equal(original.calls.length, 1);
});

test('a fake-ip answer set is accepted after the refusal', async () => {
    const original = resolverOf({ error: blockedError() });
    const { lookup } = lookupOf(answers('198.18.0.133'));
    const accepted = [];
    const resolve = resolveWithFakeIpAllowance(
        original.resolve,
        { ranges: defaultRanges, onAccept: (event) => accepted.push(event) },
        lookup,
    );

    const resolved = await resolve('docs.godotengine.org', undefined);

    assert.deepEqual(resolved, [{ address: '198.18.0.133', family: 4 }]);
    assert.deepEqual(accepted, [{ hostname: 'docs.godotengine.org', addresses: [{ address: '198.18.0.133', family: 4 }] }]);
});

test('the original error object survives every refusal path', async () => {
    const refusal = blockedError();

    // Genuine private destination.
    const privateLookup = lookupOf(answers('127.0.0.1'));
    await assert.rejects(
        resolveWithFakeIpAllowance(resolverOf({ error: refusal }).resolve, { ranges: defaultRanges }, privateLookup.lookup)('127.0.0.1', undefined),
        (error) => error === refusal,
    );

    // Mixed set.
    const mixedLookup = lookupOf(answers('198.18.0.133', '192.168.1.10'));
    await assert.rejects(
        resolveWithFakeIpAllowance(resolverOf({ error: refusal }).resolve, { ranges: defaultRanges }, mixedLookup.lookup)('mixed.test', undefined),
        (error) => error === refusal,
    );

    // Re-resolution failed.
    const failingLookup = lookupOf(new Error('ENOTFOUND'));
    await assert.rejects(
        resolveWithFakeIpAllowance(resolverOf({ error: refusal }).resolve, { ranges: defaultRanges }, failingLookup.lookup)('gone.test', undefined),
        (error) => error === refusal,
    );

    // No ranges configured at all.
    const disabledLookup = lookupOf(answers('198.18.0.133'));
    await assert.rejects(
        resolveWithFakeIpAllowance(resolverOf({ error: refusal }).resolve, { ranges: [] }, disabledLookup.lookup)('docs.godotengine.org', undefined),
        (error) => error === refusal,
    );
});

test('other failures and an already-aborted signal never re-resolve', async () => {
    const providerError = Object.assign(new Error('web fetch failed: socket hang up'), { code: 'WEB_PROVIDER_ERROR' });
    const first = lookupOf(answers('198.18.0.133'));
    await assert.rejects(
        resolveWithFakeIpAllowance(resolverOf({ error: providerError }).resolve, { ranges: defaultRanges }, first.lookup)('example.com', undefined),
        (error) => error === providerError,
    );
    assert.equal(first.calls.length, 0);

    const refusal = blockedError();
    const controller = new AbortController();
    controller.abort();
    const second = lookupOf(answers('198.18.0.133'));
    await assert.rejects(
        resolveWithFakeIpAllowance(resolverOf({ error: refusal }).resolve, { ranges: defaultRanges }, second.lookup)('docs.godotengine.org', controller.signal),
        (error) => error === refusal,
    );
    assert.equal(second.calls.length, 0, 'an aborted request must not start a second lookup');
});

test('a throwing onAccept callback cannot break the fetch', async () => {
    const resolve = resolveWithFakeIpAllowance(
        resolverOf({ error: blockedError() }).resolve,
        { ranges: defaultRanges, onAccept: () => { throw new Error('logger blew up'); } },
        lookupOf(answers('198.18.0.133')).lookup,
    );
    assert.deepEqual(await resolve('docs.godotengine.org', undefined), [{ address: '198.18.0.133', family: 4 }]);
});

test('patchProvider swaps the resolver and restores it', async () => {
    const original = resolverOf({ error: blockedError() });
    const provider = fakeProvider('http', original.resolve);

    const restore = patchProvider(provider, { ranges: defaultRanges }, lookupOf(answers('198.18.0.133')).lookup);
    assert.equal(typeof restore, 'function');
    assert.notEqual(provider.resolveAddresses, original.resolve);
    assert.deepEqual(await provider.resolveAddresses('docs.godotengine.org', undefined), [{ address: '198.18.0.133', family: 4 }]);

    restore();
    assert.equal(provider.resolveAddresses, original.resolve, 'the original resolver comes back');
    await assert.rejects(
        provider.resolveAddresses('docs.godotengine.org', undefined),
        (error) => error.code === BLOCKED_CODE,
        'the restored resolver refuses again',
    );

    // A later replacement wins over our restore.
    const replacement = async () => [];
    provider.resolveAddresses = replacement;
    restore();
    assert.equal(provider.resolveAddresses, replacement);
});

test('patching twice never stacks two wrappers', async () => {
    const original = resolverOf({ error: blockedError() });
    const provider = fakeProvider('http', original.resolve);
    const { lookup, calls } = lookupOf(answers('198.18.0.133'));

    const first = patchProvider(provider, { ranges: defaultRanges }, lookup);
    const patchedOnce = provider.resolveAddresses;
    const second = patchProvider(provider, { ranges: defaultRanges }, lookup);

    assert.equal(provider.resolveAddresses, patchedOnce, 'the second patch keeps the first wrapper');
    assert.equal(isPatchedResolver(patchedOnce), true);
    assert.equal(isPatchedResolver(original.resolve), false);
    second();
    assert.equal(provider.resolveAddresses, patchedOnce, 'the second restore is a no-op');

    assert.deepEqual(await provider.resolveAddresses('docs.godotengine.org', undefined), [{ address: '198.18.0.133', family: 4 }]);
    assert.equal(calls.length, 1, 'one wrapper performs exactly one re-resolution');

    first();
    assert.equal(provider.resolveAddresses, original.resolve);

    // A registry patched a second time reports the provider as already wrapped.
    const registry = fakeRegistry([provider]);
    patchRegistry(registry, { ranges: defaultRanges }, lookup);
    const again = patchRegistry(registry, { ranges: defaultRanges }, lookup);
    assert.deepEqual(again.patchedIds, []);
    assert.deepEqual(again.alreadyIds, ['http']);
});

test('patchProvider refuses providers it cannot understand', () => {
    assert.equal(patchProvider(undefined), undefined);
    assert.equal(patchProvider(null), undefined);
    assert.equal(patchProvider({ id: 'no-resolver' }), undefined);
    assert.equal(patchProvider({ id: 'string-resolver', resolveAddresses: 'nope' }), undefined);
});

test('patchRegistry patches the live registry and later registrations', async () => {
    const firstResolver = resolverOf({ error: blockedError() }).resolve;
    const first = fakeProvider('http', firstResolver);
    const registry = fakeRegistry([first]);
    const originalSet = registry.set;
    const { restore, patchedIds } = patchRegistry(registry, { ranges: defaultRanges }, lookupOf(answers('198.18.0.133')).lookup);

    assert.deepEqual(patchedIds, ['http']);
    const firstPatched = first.resolveAddresses;
    assert.deepEqual(await firstPatched('docs.godotengine.org', undefined), [{ address: '198.18.0.133', family: 4 }]);

    // A provider registered after the patch is wrapped on the way in.
    const late = fakeProvider('late', resolverOf({ error: blockedError() }).resolve);
    registry.set(late.id, late);
    assert.notEqual(late.resolveAddresses, undefined);
    assert.deepEqual(await late.resolveAddresses('docs.godotengine.org', undefined), [{ address: '198.18.0.133', family: 4 }]);

    const unpatchable = { id: 'opaque' };
    registry.set(unpatchable.id, unpatchable);
    assert.equal(unpatchable.resolveAddresses, undefined);

    restore();
    assert.equal(first.resolveAddresses, firstResolver, 'the original resolver comes back');
    assert.equal(registry.set, originalSet, 'the registry gets its own `set` back');
    assert.equal(registry.get('http'), first, 'the registry keeps its entries');
});

/** A host context double recording every registration the plugin makes. */
function fakeCtx({ providers = [], withRegistry = true } = {}) {
    const logs = { info: [], warn: [] };
    const effects = [];
    const ctx = {
        logger: {
            info: (message) => logs.info.push(message),
            warn: (message) => logs.warn.push(message),
        },
        effect: (register, label) => {
            effects.push({ register, label });
            return () => {};
        },
    };
    if (withRegistry) ctx.web = { fetchProviders: fakeRegistry(providers) };
    return { ctx, logs, effects };
}

test('install patches, logs one boot line, and registers one effect', () => {
    const provider = fakeProvider('http', resolverOf({ error: blockedError() }).resolve);
    const { ctx, logs, effects } = fakeCtx({ providers: [provider] });

    const result = install(ctx, {}, { lookup: lookupOf(answers('198.18.0.133')).lookup });

    assert.deepEqual(result.patchedIds, ['http']);
    assert.equal(effects.length, 1);
    assert.match(effects[0].label, /web-fetch-fakeip-allow/);
    assert.equal(logs.warn.length, 0);
    assert.equal(logs.info.length, 1);
    assert.match(logs.info[0], /^web-fetch-fakeip-allow: patched 1 fetch provider\(s\) \[http\]; allow=198\.18\.0\.0\/15, 2001:2::\/48$/);

    // The registered effect is what undoes the patch when the plugin unloads.
    const original = ctx.web.fetchProviders.get('http').resolveAddresses;
    effects[0].register()();
    assert.notEqual(ctx.web.fetchProviders.get('http').resolveAddresses, original);
});

test('install reports a late registration instead of staying silent', () => {
    const { ctx, logs } = fakeCtx();
    install(ctx, {}, { lookup: lookupOf(answers('198.18.0.133')).lookup });
    assert.match(logs.info[0], /none registered yet/);

    const late = fakeProvider('http', resolverOf({ error: blockedError() }).resolve);
    ctx.web.fetchProviders.set('http', late);
    assert.notEqual(late.resolveAddresses, undefined, 'a later provider is still patched');
});

test('install never throws on an unusable composition', () => {
    const noRegistry = fakeCtx({ withRegistry: false });
    assert.equal(install(noRegistry.ctx, {}), undefined);
    assert.equal(noRegistry.logs.warn.length, 1);
    assert.match(noRegistry.logs.warn[0], /fetchProviders is unavailable/);

    const noContext = { logger: { warn: () => {} } };
    assert.equal(install(noContext, {}), undefined);

    const broken = fakeCtx();
    broken.ctx.web = { fetchProviders: [] };
    assert.equal(install(broken.ctx, {}), undefined);
    assert.match(broken.logs.warn[0], /fetchProviders is unavailable/);
});

test('install honours enabled:false and an unusable allow list', () => {
    const provider = fakeProvider('http', resolverOf({ error: blockedError() }).resolve);
    const original = provider.resolveAddresses;

    const off = fakeCtx({ providers: [provider] });
    assert.equal(install(off.ctx, { enabled: false }), undefined);
    assert.equal(provider.resolveAddresses, original);
    assert.match(off.logs.info[0], /disabled by configuration/);

    const empty = fakeCtx({ providers: [provider] });
    assert.equal(install(empty.ctx, { allow: [] }), undefined);
    assert.equal(provider.resolveAddresses, original);
    assert.match(empty.logs.warn[0], /allow list holds no usable CIDR block/);

    const malformed = fakeCtx({ providers: [provider] });
    const result = install(malformed.ctx, { allow: ['nope', '198.18.0.0/15'] }, { lookup: lookupOf(answers('198.18.0.133')).lookup });
    assert.deepEqual(result.ranges.map((range) => range.text), ['198.18.0.0/15']);
    assert.match(malformed.logs.warn[0], /ignored 1 malformed allow entry: nope/);
    assert.notEqual(provider.resolveAddresses, original);
});
