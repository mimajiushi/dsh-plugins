/**
 * Web-fetch fake-ip allowance — host half.
 *
 * A host-plane plugin with no tools of its own: it patches the address policy of the
 * fetch providers registered on the web capability seam (`ctx.web`), so `web_fetch`
 * stops refusing the placeholder addresses a local TUN + fake-ip proxy hands out for
 * ordinary public domains. Everything else about the provider — redirect policy,
 * byte and character caps, charset decoding, timeouts, error codes — is untouched,
 * and every non-public destination outside the configured ranges keeps its original
 * refusal.
 *
 * Installation (bundle): `dsh plugin --profile <name> add link:<this directory>`
 * (or `node scripts/install.mjs --profile <name>`), then restart DSH.
 *
 * @module dsh-web-fetch-fakeip-allow
 */
import z from '@deepseek-ai/schemastery';

import { DEFAULT_ALLOW, NAME, install } from './logic.js';

export const name = NAME;

/** The web capability seam must exist before its provider registry can be patched. */
export const inject = ['web'];

/**
 * Composition entry config.
 * @see file:./cordis.patch.yml for the values this package ships with.
 */
export const Config = z.object({
    enabled: z.boolean().default(true),
    // IPv4 and IPv6 fake-ip pools, e.g. `198.18.0.0/15` and `2001:2::/48`.
    allow: z.array(z.string()).default(DEFAULT_ALLOW),
    log: z.boolean().default(true),
});

export {
    BLOCKED_CODE,
    DEFAULT_ALLOW,
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
} from './logic.js';

/**
 * Mount the plugin.
 *
 * The patch is applied to the registry that exists right now, so it never depends on
 * whether an already-satisfied `ctx.inject` callback runs synchronously. The injected
 * scope then covers exactly one other case: the host rebuilt the `web` service (a live
 * patch reload does), which produces a NEW registry needing the patch again.
 *
 * @param ctx - host plugin context.
 * @param config - composition entry config (`{ enabled, allow, log }`).
 */
export function apply(ctx, config) {
    const resolved = config ?? {};
    const registry = ctx?.web?.fetchProviders;
    if (registry !== undefined && registry !== null) install(ctx, resolved);
    if (typeof ctx?.inject === 'function') {
        ctx.inject(['web'], (scope) => {
            if (scope?.web?.fetchProviders === registry) return;
            install(scope, resolved);
        });
    }
}
