#!/usr/bin/env node
/**
 * Read-only installer helper for dsh-subagent-model-guard.
 *
 * Adding a bundle to a profile is two edits plus one `node_modules` link. This
 * script performs neither: it reports the exact state and prints the changes to
 * make, so a human (or an agent) can apply them deliberately and roll them back.
 *
 * Usage:
 *   node scripts/install.mjs --profile desktop
 *   node scripts/install.mjs                 # uses the active profile when known
 *
 * @module dsh-subagent-model-guard/install
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const PACKAGE_NAME = 'dsh-subagent-model-guard';

/** Read `--profile <name>`, or `undefined` to auto-detect. */
function requestedProfile(argv) {
    const index = argv.indexOf('--profile');
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error('--profile requires a profile name');
    }
    return value;
}

/**
 * Resolve the profile to inspect: the requested one, else the active desktop
 * profile recorded by DSH Desktop, else `web`.
 * @param requested - `--profile` value, when given.
 * @param dshHome - the DSH home directory.
 * @returns the profile name.
 */
function resolveProfileName(requested, dshHome) {
    if (requested !== undefined) return requested;
    const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    const stateFile = join(roaming, 'DSH Desktop', 'profile-selection', 'state.json');
    try {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        if (typeof state.active === 'string' && state.active !== '') return state.active;
    }
    catch {
        // Desktop state is optional: a CLI-only install has no selection file.
    }
    return 'web';
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileName = resolveProfileName(requestedProfile(process.argv.slice(2)), dshHome);
const profileDir = join(dshHome, 'profiles', profileName);
const manifestPath = join(profileDir, 'package.json');
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);

if (!existsSync(manifestPath)) {
    console.error(`✖ profile manifest not found: ${manifestPath}`);
    console.error(`  Pass --profile <name> to target another profile under ${join(dshHome, 'profiles')}.`);
    process.exitCode = 1;
} else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const bundles = manifest?.dsh?.profile?.bundles;
    const listed = Array.isArray(bundles) && bundles.includes(PACKAGE_NAME);
    const dependency = manifest?.dependencies?.[PACKAGE_NAME];
    let linked = false;
    try {
        linked = existsSync(linkPath) && statSync(linkPath).isDirectory() && existsSync(join(linkPath, 'package.json'));
    }
    catch {
        linked = false;
    }

    console.log(`profile:  ${profileName}  (${profileDir})`);
    console.log(`package:  ${PACKAGE_ROOT}`);
    console.log('');
    console.log(`${listed ? '✔' : '✖'} dsh.profile.bundles contains "${PACKAGE_NAME}"`);
    console.log(`${dependency === undefined ? '✖' : '✔'} dependencies["${PACKAGE_NAME}"] = ${dependency ?? '(missing)'}`);
    console.log(`${linked ? '✔' : '✖'} node_modules link resolves: ${linkPath}`);

    if (listed && dependency !== undefined && linked) {
        console.log('');
        console.log('Everything is registered. Restart DSH to load the plugin.');
    }
    else {
        console.log('');
        console.log('Apply these changes to ' + manifestPath + ':');
        if (!listed) console.log(`  · append "${PACKAGE_NAME}" to dsh.profile.bundles`);
        if (dependency === undefined) {
            console.log(`  · add "dependencies.${PACKAGE_NAME}": "link:${PACKAGE_ROOT.replace(/\\/g, '/')}"`);
        }
        console.log('Then create the node_modules link:');
        console.log(`  New-Item -ItemType Junction -Path "${linkPath}" -Target "${PACKAGE_ROOT}"`);
        console.log('Then restart DSH. See README.md for the rollback steps.');
    }
}
