/**
 * Web-fetch fake-ip allowance — dependency-free policy core.
 *
 * The host's `web_fetch` provider (`@deepseek-ai/dsh-web-fetch-http`) validates a
 * URL's resolved addresses before it opens a connection and refuses a non-public
 * destination. A local proxy in TUN + fake-ip mode (Clash/mihomo, sing-box, Surge)
 * answers every proxied domain with a placeholder address out of the RFC 2544
 * benchmarking block (198.18.0.0/15) — and, on a dual-stack resolver, with a second one
 * out of the RFC 5180 prefix (2001:2::/48) for the AAAA answer — and performs the real
 * connection itself, so that refusal fires on ordinary public sites — while the browser,
 * which just connects to the placeholder, works fine.
 *
 * This module owns the entire relaxation:
 *
 *  - the provider's own resolver stays authoritative, so every public destination
 *    keeps the exact behavior it had before this plugin existed;
 *  - a resolution is accepted only when EVERY answer lies inside an explicitly
 *    configured range, which is what a fake-ip pool looks like;
 *  - loopback, RFC 1918, link-local, CGNAT and IP literals keep the provider's own
 *    error object, bit for bit, because that object is re-thrown untouched.
 *
 * @module dsh-web-fetch-fakeip-allow/logic
 */
import { lookup as dnsLookup } from 'node:dns/promises';

/** Cordis plugin name: matches the bundle patch row id and the package name. */
export const NAME = 'web-fetch-fakeip-allow';

/**
 * Ranges relaxed by default — the two placeholder pools a local TUN + fake-ip proxy
 * hands out. `198.18.0.0/15` is the RFC 2544 benchmarking block a proxy uses for its
 * IPv4 pool (`fake-ip-range`); `2001:2::/48` is the RFC 5180 benchmarking prefix it
 * uses for the IPv6 one (`fake-ip-range6`, e.g. mihomo's `2001:2::/64`, which lies
 * inside this block).
 *
 * Both families matter: on a dual-stack resolver a fake-ip domain is answered with an
 * A *and* an AAAA placeholder at the same time, and the host refuses the whole answer
 * set as soon as one entry is not public — an IPv4-only allow list never matches there.
 */
export const DEFAULT_ALLOW = ['198.18.0.0/15', '2001:2::/48'];

/** Stable error code the fetch provider throws for its address-policy refusal. */
export const BLOCKED_CODE = 'WEB_BLOCKED_URL';

/** Message fragment used as a fallback when the code is missing (older/newer host). */
const BLOCKED_MESSAGE = 'resolves to a non-public IP address';

/**
 * Marks a resolver this plugin already wrapped. Mounting twice (an immediate patch
 * plus a service-rebuild patch) must never stack two wrappers on one provider.
 */
const PATCHED = Symbol.for('dsh-web-fetch-fakeip-allow.patched');

/**
 * Parse a dotted-quad IPv4 address into an unsigned 32-bit integer.
 * @param text - candidate address.
 * @returns the numeric value, or `undefined` when the text is not an IPv4 address.
 */
export function parseIpv4(text) {
    if (typeof text !== 'string') return undefined;
    const parts = text.trim().split('.');
    if (parts.length !== 4) return undefined;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return undefined;
        const octet = Number(part);
        if (octet > 255) return undefined;
        value = value * 256 + octet;
    }
    return value >>> 0;
}

/** Number of 16-bit groups in an IPv6 address. */
const IPV6_GROUPS = 8;

/**
 * Rewrite the RFC 4291 mixed form (`::ffff:198.18.0.38`) into pure hex groups, so the
 * rest of the parser only ever sees hex.
 * @param text - candidate address text.
 * @returns the rewritten text, the input unchanged when there is no dotted tail, or
 *   `undefined` when the tail is not a valid IPv4 address.
 */
function expandEmbeddedIpv4(text) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon === -1) return text;
    const tail = text.slice(lastColon + 1);
    if (!tail.includes('.')) return text;
    const value = parseIpv4(tail);
    if (value === undefined) return undefined;
    return `${text.slice(0, lastColon + 1)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
}

/**
 * Parse an IPv6 address into an unsigned 128-bit integer.
 *
 * Accepts the compressed form (`::`), either case, and the RFC 4291 mixed form with a
 * dotted-quad tail. A zone suffix (`%eth0`) is refused: it names a local interface,
 * which is the opposite of what this plugin is allowed to accept.
 *
 * @param text - candidate address.
 * @returns the numeric value, or `undefined` when the text is not an IPv6 address.
 */
export function parseIpv6(text) {
    if (typeof text !== 'string') return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.includes('%')) return undefined;
    const expanded = expandEmbeddedIpv4(trimmed);
    if (expanded === undefined) return undefined;
    const compression = expanded.indexOf('::');
    if (compression !== expanded.lastIndexOf('::')) return undefined;
    const headText = compression === -1 ? expanded : expanded.slice(0, compression);
    const tailText = compression === -1 ? '' : expanded.slice(compression + 2);
    const head = headText === '' ? [] : headText.split(':');
    const tail = tailText === '' ? [] : tailText.split(':');
    const groups = [];
    for (const part of [...head, ...tail]) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
        groups.push(Number.parseInt(part, 16));
    }
    if (compression === -1) {
        if (groups.length !== IPV6_GROUPS) return undefined;
    }
    else {
        // `::` must stand for at least one zero group.
        if (groups.length >= IPV6_GROUPS) return undefined;
        groups.splice(head.length, 0, ...new Array(IPV6_GROUPS - groups.length).fill(0));
    }
    let value = 0n;
    for (const group of groups) value = (value << 16n) | BigInt(group);
    return value;
}

/**
 * Parse one IPv4 CIDR block.
 * @param text - candidate block, e.g. `198.18.0.0/15`.
 * @returns `{ base, mask, prefix, text }`, or `undefined` when malformed.
 */
export function parseCidr(text) {
    if (typeof text !== 'string') return undefined;
    const trimmed = text.trim();
    const parts = trimmed.split('/');
    if (parts.length !== 2) return undefined;
    const [address, prefixText] = parts;
    if (!/^\d{1,2}$/.test(prefixText)) return undefined;
    const prefix = Number(prefixText);
    if (prefix > 32) return undefined;
    const addressValue = parseIpv4(address);
    if (addressValue === undefined) return undefined;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { base: (addressValue & mask) >>> 0, mask, prefix, text: trimmed };
}

/**
 * Parse one IPv6 CIDR block.
 * @param text - candidate block, e.g. `2001:2::/48`.
 * @returns `{ family, base, mask, prefix, text }` with `BigInt` bounds, or `undefined`
 *   when malformed.
 */
export function parseCidr6(text) {
    if (typeof text !== 'string') return undefined;
    const trimmed = text.trim();
    const parts = trimmed.split('/');
    if (parts.length !== 2) return undefined;
    const [address, prefixText] = parts;
    if (!/^\d{1,3}$/.test(prefixText)) return undefined;
    const prefix = Number(prefixText);
    if (prefix > 128) return undefined;
    const addressValue = parseIpv6(address);
    if (addressValue === undefined) return undefined;
    const mask = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix));
    return { family: 6, base: addressValue & mask, mask, prefix, text: trimmed };
}

/**
 * Parse one CIDR block of either family — the accepted allow-list syntax.
 * @param text - candidate block, IPv4 (`198.18.0.0/15`) or IPv6 (`2001:2::/48`).
 * @returns a family-tagged range, or `undefined` when malformed.
 */
export function parseRange(text) {
    const ipv4 = parseCidr(text);
    if (ipv4 !== undefined) return { family: 4, ...ipv4 };
    return parseCidr6(text);
}

/**
 * Parse a configured allow list, keeping the valid blocks and reporting the rest.
 * @param list - configured value (anything; only an array of strings is usable).
 * @returns `{ ranges, rejected }` — `rejected` holds the entries as text.
 */
export function parseRanges(list) {
    const ranges = [];
    const rejected = [];
    for (const entry of Array.isArray(list) ? list : []) {
        const range = parseRange(entry);
        if (range === undefined) rejected.push(String(entry));
        else ranges.push(range);
    }
    return { ranges, rejected };
}

/**
 * Whether an address falls inside one of the parsed ranges.
 * @param address - textual IPv4 address.
 * @param ranges - parsed ranges from {@link parseRanges}.
 * @returns true when at least one range contains the address.
 */
export function ipv4InRanges(address, ranges) {
    const value = parseIpv4(address);
    if (value === undefined) return false;
    return ranges.some((range) => range.family !== 6 && ((value & range.mask) >>> 0) === range.base);
}

/**
 * Whether an address falls inside one of the parsed IPv6 ranges.
 * @param address - textual IPv6 address.
 * @param ranges - parsed ranges from {@link parseRanges}.
 * @returns true when at least one IPv6 range contains the address.
 */
export function ipv6InRanges(address, ranges) {
    const value = parseIpv6(address);
    if (value === undefined) return false;
    return ranges.some((range) => range.family === 6 && (value & range.mask) === range.base);
}

/**
 * Whether an error is the fetch provider's own address-policy refusal — the only
 * failure this plugin is allowed to reconsider. Never classify by parsing a message
 * when a code is present, but keep the message check as a cross-version safety net.
 * @param error - a thrown value.
 * @returns true when the error is a `WEB_BLOCKED_URL` refusal.
 */
export function isBlockedUrl(error) {
    if (error === null || typeof error !== 'object') return false;
    if (error.code === BLOCKED_CODE) return true;
    return typeof error.message === 'string' && error.message.includes(BLOCKED_MESSAGE);
}

/**
 * Decide whether a resolution may stand in for a fake-ip answer set.
 *
 * The rule is deliberately all-or-nothing: a set that mixes a placeholder with any
 * other address is refused, because it no longer describes what the proxy would do.
 * Every family present in the answer set must therefore have a configured range of its
 * own — a dual-stack answer (A + AAAA placeholder) is refused by an IPv4-only list.
 *
 * @param resolved - answers as returned by `dns.promises.lookup(..., { all: true })`.
 * @param ranges - parsed ranges from {@link parseRanges}.
 * @returns the address set in the provider's own shape (`{ address, family }[]`), or
 *   `undefined` when the set must be refused.
 */
export function acceptFakeIpAnswerSet(resolved, ranges) {
    if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
    if (!Array.isArray(ranges) || ranges.length === 0) return undefined;
    const accepted = [];
    for (const entry of resolved) {
        if (entry === null || typeof entry !== 'object') return undefined;
        if (entry.family === 4) {
            if (!ipv4InRanges(entry.address, ranges)) return undefined;
            accepted.push({ address: entry.address, family: 4 });
            continue;
        }
        if (entry.family === 6) {
            if (!ipv6InRanges(entry.address, ranges)) return undefined;
            accepted.push({ address: entry.address, family: 6 });
            continue;
        }
        return undefined;
    }
    return accepted;
}

/**
 * Wrap a provider's resolver with the fake-ip allowance.
 *
 * The wrapped resolver never invents an answer: it asks the original resolver first
 * and only re-resolves after that resolver refused. A refusal that is not about the
 * address policy, a genuine private destination, or a re-resolution failure all end
 * with the ORIGINAL error object re-thrown.
 *
 * @param originalResolve - the provider's `resolveAddresses(hostname, signal)`.
 * @param options - `{ ranges, onAccept }` — ranges from {@link parseRanges}.
 * @param lookup - `dns.promises.lookup` implementation (injectable for tests).
 * @returns the wrapped resolver.
 */
export function resolveWithFakeIpAllowance(originalResolve, options = {}, lookup = dnsLookup) {
    const ranges = Array.isArray(options.ranges) ? options.ranges : [];
    const onAccept = options.onAccept;
    return async function relaxedResolve(hostname, signal) {
        try {
            return await originalResolve(hostname, signal);
        }
        catch (error) {
            if (!isBlockedUrl(error)) throw error;
            if (signal !== null && signal !== undefined && signal.aborted === true) throw error;
            let resolved;
            try {
                resolved = await lookup(hostname, { all: true, order: 'verbatim' });
            }
            catch {
                throw error;
            }
            const accepted = acceptFakeIpAnswerSet(resolved, ranges);
            if (accepted === undefined) throw error;
            if (typeof onAccept === 'function') {
                try {
                    onAccept({ hostname, addresses: accepted });
                }
                catch {
                    // Diagnostics must never break a fetch.
                }
            }
            return accepted;
        }
    };
}

/**
 * Patch one provider object in place, replacing its resolver.
 * @param provider - the registered provider (`{ id, resolveAddresses, ... }`).
 * @param options - see {@link resolveWithFakeIpAllowance}.
 * @param lookup - `dns.promises.lookup` implementation.
 * @returns a restore function, or `undefined` when the provider is not patchable.
 */
export function patchProvider(provider, options = {}, lookup = dnsLookup) {
    if (provider === null || typeof provider !== 'object') return undefined;
    const original = provider.resolveAddresses;
    if (typeof original !== 'function') return undefined;
    // Already wrapped by an earlier mount: report success without stacking a wrapper.
    if (original[PATCHED] === true) return () => {};
    const relaxed = resolveWithFakeIpAllowance(original, options, lookup);
    relaxed[PATCHED] = true;
    provider.resolveAddresses = relaxed;
    return () => {
        // Only undo our own patch: leave a later replacement alone.
        if (provider.resolveAddresses === relaxed) provider.resolveAddresses = original;
    };
}

/**
 * Whether a resolver was produced by this plugin's own patch (used to make a second
 * mount a no-op instead of stacking a wrapper on a wrapper).
 * @param resolver - a candidate `resolveAddresses` value.
 * @returns true when {@link patchProvider} already wrapped it.
 */
export function isPatchedResolver(resolver) {
    return typeof resolver === 'function' && resolver[PATCHED] === true;
}

/**
 * Patch a live provider registry, and keep patching providers registered afterwards.
 *
 * `ctx.web.registerFetchProvider()` writes into this Map, so intercepting `set` makes
 * the result independent of composition order: whichever of the two plugins the host
 * mounts first, the provider ends up wrapped exactly once.
 *
 * @param registry - `ctx.web.fetchProviders`.
 * @param options - see {@link resolveWithFakeIpAllowance}.
 * @param lookup - `dns.promises.lookup` implementation.
 * @returns `{ restore, patchedIds, alreadyIds, skippedIds }`.
 */
export function patchRegistry(registry, options = {}, lookup = dnsLookup) {
    const restores = new Map();
    const patchedIds = [];
    const alreadyIds = [];
    const skippedIds = [];
    const patchOne = (provider) => {
        if (provider === null || typeof provider !== 'object') return;
        if (restores.has(provider)) return;
        if (isPatchedResolver(provider.resolveAddresses)) {
            // An earlier mount of this plugin already owns the wrapper and its restore.
            alreadyIds.push(String(provider.id ?? '?'));
            return;
        }
        const restore = patchProvider(provider, options, lookup);
        if (restore === undefined) {
            skippedIds.push(String(provider.id ?? '?'));
            return;
        }
        restores.set(provider, restore);
        patchedIds.push(String(provider.id ?? '?'));
    };

    if (typeof registry.values === 'function') {
        for (const provider of [...registry.values()]) patchOne(provider);
    }

    let restoreSet;
    if (typeof registry.set === 'function') {
        const originalSet = registry.set;
        const patchedSet = function patchedSet(key, value) {
            const result = originalSet.call(this, key, value);
            patchOne(value);
            return result;
        };
        registry.set = patchedSet;
        restoreSet = () => {
            if (registry.set === patchedSet) registry.set = originalSet;
        };
    }

    return {
        patchedIds,
        alreadyIds,
        skippedIds,
        restore: () => {
            if (restoreSet !== undefined) restoreSet();
            for (const restore of restores.values()) restore();
            restores.clear();
        },
    };
}

/**
 * Wire the plugin onto a host context: patch the live fetch registry, log what
 * happened, and register the cleanup through `ctx.effect`.
 *
 * Nothing here throws: a composition without the web seam, a registry that is not a
 * Map, or a provider whose resolver cannot be replaced only produce a warning, so a
 * future host change can never take the whole boot down with it.
 *
 * @param ctx - host plugin context (`web`, `logger`, `effect`).
 * @param config - composition entry config (`{ enabled, allow, log }`).
 * @param deps - test seams: `{ lookup, logger, effect }`.
 * @returns `{ restore, patchedIds, ranges }`, or `undefined` when nothing was patched.
 */
export function install(ctx, config = {}, deps = {}) {
    const logger = deps.logger ?? ctx?.logger;
    const effect = deps.effect ?? ((register, label) => ctx?.effect?.(register, label));
    const lookup = deps.lookup ?? dnsLookup;
    const wantsLog = config.log !== false;
    const info = (message) => {
        if (wantsLog) logger?.info?.(`${NAME}: ${message}`);
    };
    const warn = (message) => logger?.warn?.(`${NAME}: ${message}`);

    if (config.enabled === false) {
        info('disabled by configuration; no fetch provider patched');
        return undefined;
    }

    const { ranges, rejected } = parseRanges(config.allow ?? DEFAULT_ALLOW);
    if (rejected.length > 0) {
        warn(`ignored ${rejected.length} malformed allow entr${rejected.length === 1 ? 'y' : 'ies'}: ${rejected.join(', ')}`);
    }
    if (ranges.length === 0) {
        warn('the allow list holds no usable CIDR block; nothing relaxed, no provider patched');
        return undefined;
    }

    const registry = ctx?.web?.fetchProviders;
    if (registry === null || typeof registry !== 'object' || typeof registry.set !== 'function') {
        warn('ctx.web.fetchProviders is unavailable on this host; no fetch provider patched');
        return undefined;
    }

    const { restore, patchedIds, alreadyIds, skippedIds } = patchRegistry(registry, {
        ranges,
        onAccept: ({ hostname, addresses }) => info(`accepted fake-ip answer for ${hostname} -> ${addresses.map((address) => address.address).join(', ')}`),
    }, lookup);

    const allowed = ranges.map((range) => range.text).join(', ');
    info(`patched ${patchedIds.length} fetch provider(s) [${patchedIds.join(', ') || 'none registered yet'}]; allow=${allowed}`
        + (alreadyIds.length > 0 ? `; already patched: ${alreadyIds.join(', ')}` : '')
        + (skippedIds.length > 0 ? `; skipped (no replaceable resolver): ${skippedIds.join(', ')}` : ''));

    effect(() => restore, `${NAME}: fetch provider patch`);
    return { restore, patchedIds, ranges };
}
