#!/usr/bin/env node
/**
 * Real-provider probe: prove — without restarting DSH — that the *shipped* fetch
 * provider refuses a domain's real answer set, and that this plugin's patch is what
 * rescues it.
 *
 * It loads `@deepseek-ai/dsh-web-fetch-http` straight out of the installed
 * `resources/app.asar`, so there is no mock in the loop: the refusal, the answer set
 * and the patched resolver are all the host's own code.
 *
 * Usage (Electron's node mode is required — plain node cannot read an asar):
 *
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "D:\software\dsh_desktop\DSH Desktop\DSH Desktop.exe" scripts/probe-provider.cjs api.github.com
 *
 * Override the app location with `DSH_APP_EXE`. Extra arguments are more hostnames;
 * `localhost` and `192.168.199.1` are always probed as negatives (the patch must NOT
 * rescue them).
 */
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_EXE = process.env.DSH_APP_EXE ?? 'D:\\software\\dsh_desktop\\DSH Desktop\\DSH Desktop.exe';
const ASAR = path.join(path.dirname(APP_EXE), 'resources', 'app.asar');
const PROVIDER_DIR = path.join(ASAR, 'node_modules', '@deepseek-ai', 'dsh-web-fetch-http');

/** Hostnames expected to be refused by the bare provider and rescued by the patch. */
const positives = process.argv.slice(2);
if (positives.length === 0) positives.push('api.github.com');

/** Destinations the patch must never rescue. */
const negatives = ['localhost', '192.168.199.1'];

/**
 * Run one resolution and capture its outcome instead of throwing.
 * @param resolver - `resolveAddresses(hostname, signal)`.
 * @param hostname - destination host.
 * @returns `{ ok, value }` or `{ ok: false, code, message }`.
 */
async function attempt(resolver, hostname) {
    // The shipped resolver reads `signal.aborted` eagerly, so hand it a live one.
    const signal = new AbortController().signal;
    try {
        return { ok: true, value: await resolver(hostname, signal) };
    }
    catch (error) {
        return { ok: false, code: error?.code ?? '?', message: error?.message ?? String(error) };
    }
}

/** Render one outcome as a single comparable line. */
function describe(outcome) {
    if (!outcome.ok) return `refused [${outcome.code}] ${outcome.message}`;
    return outcome.value.map((entry) => `${entry.address} (family ${entry.family})`).join(', ');
}

(async () => {
    const providerModule = require(PROVIDER_DIR);
    const logic = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'logic.js')).href);
    const { ranges } = logic.parseRanges(logic.DEFAULT_ALLOW);

    console.log(`provider   : ${PROVIDER_DIR}`);
    console.log(`allow      : ${ranges.map((range) => range.text).join(', ')}`);
    console.log('');

    // A fresh provider per call site: `patchProvider` mutates the instance in place.
    const bare = new providerModule.HttpFetchProvider({});
    const patched = new providerModule.HttpFetchProvider({});
    const restore = logic.patchProvider(patched, { ranges });
    if (typeof restore !== 'function') throw new Error('patchProvider refused the shipped resolver');

    let failures = 0;
    for (const hostname of [...positives, ...negatives]) {
        const expected = positives.includes(hostname) ? 'rescue' : 'keep refusing';
        const before = await attempt(bare.resolveAddresses, hostname);
        const after = await attempt(patched.resolveAddresses, hostname);
        const verdict = positives.includes(hostname)
            ? (!before.ok && after.ok ? 'ok' : 'FAILED')
            : (!after.ok ? 'ok' : 'FAILED');
        if (verdict === 'FAILED') failures += 1;
        console.log(`${hostname}  (want: ${expected})`);
        console.log(`  bare provider : ${describe(before)}`);
        console.log(`  with patch    : ${describe(after)}`);
        console.log(`  verdict       : ${verdict}`);
        console.log('');
    }

    restore();
    console.log(failures === 0
        ? `全部 ${positives.length + negatives.length} 项符合预期：补丁救回占位地址，反例照旧被拒。`
        : `${failures} 项不符合预期。`);
    process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
    console.error(error);
    process.exitCode = 2;
});
