#!/usr/bin/env node
/**
 * Install (or reinstall) this plugin into a DSH profile.
 *
 * What it does, in order:
 *   1. resolves the profile directory (`$DSH_HOME/profiles/<name>`);
 *   2. links the harness packages this plugin's *host* side resolves at runtime
 *      into the plugin's own `node_modules` (a `link:`-installed package lives
 *      outside the profile tree, so the Loader cannot see them from here);
 *   3. backs up the profile manifest once;
 *   4. runs `dsh plugin --profile <name> add link:<this directory>`, which pnpm
 *      installs and then reconciles into `dsh.profile.bundles`;
 *   5. verifies the bundle layer list and, when the launcher supports it,
 *      re-composes the profile tree to prove the row is really mounted;
 *   6. prints the restart/verification steps.
 *
 * Usage: node scripts/install.mjs [--profile desktop] [--dry-run] [--uninstall]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PACKAGE_NAME = 'dsh-plan-card-sidebar';
/** Harness packages the host half and the client bundle's graph row need. */
const HOST_IMPORTS = ['@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-primitives'];

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse the small flag surface this script accepts. */
function parseArgs(argv) {
    const options = { profile: 'desktop', dryRun: false, uninstall: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--profile')
            options.profile = argv[++index] ?? options.profile;
        else if (arg === '--dry-run')
            options.dryRun = true;
        else if (arg === '--uninstall')
            options.uninstall = true;
        else if (arg === '--help' || arg === '-h') {
            process.stdout.write('usage: node scripts/install.mjs [--profile <name>] [--dry-run] [--uninstall]\n');
            process.exit(0);
        }
        else {
            process.stderr.write(`install: unknown argument ${JSON.stringify(arg)}\n`);
            process.exit(2);
        }
    }
    return options;
}

/** Read one package manifest, or undefined when it is absent or unreadable. */
function readManifest(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}

/**
 * Resolve one harness package directory the way the host does: the active
 * profile's shared tree first, then the profile tree, then the app's fallback.
 */
function resolveHarnessPackage(packageName, profileDir, dshHome) {
    const candidates = [
        join(dshHome, 'profiles', 'node_modules', packageName),
        join(profileDir, 'node_modules', packageName),
        join(profileDir, '.dsh-module-fallback', 'node_modules', packageName)
    ];
    for (const candidate of candidates) {
        if (existsSync(join(candidate, 'package.json'))) return candidate;
    }
    return undefined;
}

/** Create one directory junction (Windows) or symlink, when it is missing. */
function linkDirectory(target, path) {
    if (existsSync(path)) return false;
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
}

/** Make the plugin's own `node_modules` resolve its host-side imports. */
function linkHostImports(profileDir, dshHome) {
    const results = [];
    for (const packageName of HOST_IMPORTS) {
        const target = resolveHarnessPackage(packageName, profileDir, dshHome);
        if (target === undefined) {
            results.push(`${packageName}: not found in the profile trees (the host resolves it itself)`);
            continue;
        }
        const linkPath = join(pluginDir, 'node_modules', ...packageName.split('/'));
        const created = linkDirectory(target, linkPath);
        results.push(`${packageName}: ${created ? 'linked' : 'already linked'} -> ${target}`);
    }
    return results;
}

/**
 * Run one `dsh` command through the platform shell. A single command string
 * avoids the argument-array-with-shell deprecation while still working with the
 * Windows `dsh.cmd` shim.
 */
function runDsh(args, options) {
    const line = ['dsh', ...args].map(quoteShellArgument).join(' ');
    return spawnSync(line, { cwd: options.cwd, stdio: 'inherit', shell: true });
}

/** Quote one shell argument; harmless on POSIX, required on Windows. */
function quoteShellArgument(value) {
    return /[\s"&|<>^]/.test(value) ? `"${value.split('"').join('""')}"` : value;
}

const options = parseArgs(process.argv.slice(2));
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', options.profile);
const manifestPath = join(profileDir, 'package.json');

if (!existsSync(manifestPath)) {
    process.stderr.write(`install: no profile manifest at ${manifestPath}\n`
        + `install: start DSH once with the "${options.profile}" profile first, or pass --profile <name>\n`);
    process.exit(1);
}

const spec = `link:${pluginDir.split('\\').join('/')}`;
if (options.dryRun) {
    process.stdout.write('install (dry run)\n'
        + `  profile  : ${profileDir}\n`
        + `  package  : ${PACKAGE_NAME} ${readManifest(join(pluginDir, 'package.json'))?.version ?? '?'}\n`
        + `  spec     : ${spec}\n`
        + `  command  : dsh plugin --profile ${options.profile} ${options.uninstall ? 'remove' : 'add'} ...\n`);
    process.exit(0);
}

if (options.uninstall) {
    const removal = runDsh(['plugin', '--profile', options.profile, 'remove', PACKAGE_NAME], { cwd: profileDir });
    if (removal.error !== undefined) throw removal.error;
    process.stdout.write(`${PACKAGE_NAME} removed from profile "${options.profile}".\n`
        + 'Restart DSH, then hard-refresh the Web page. The plugin directory can stay in place.\n');
    process.exit(removal.status ?? 1);
}

for (const line of linkHostImports(profileDir, dshHome)) process.stdout.write(`install: ${line}\n`);

const backupPath = `${manifestPath}.bak-plan-card-sidebar`;
if (!existsSync(backupPath)) {
    copyFileSync(manifestPath, backupPath);
    process.stdout.write(`install: backed up ${manifestPath} -> ${backupPath}\n`);
}

process.stdout.write(`install: running "dsh plugin --profile ${options.profile} add ${spec}"\n`);
const install = runDsh(['plugin', '--profile', options.profile, 'add', spec], { cwd: profileDir });
if (install.error !== undefined) {
    if (install.error.code === 'ENOENT') {
        process.stderr.write('install: `dsh` was not found on PATH; install DSH or run pnpm manually:\n'
            + `install:   cd ${profileDir} && pnpm add "${spec}"\n`
            + 'install: then append the package name to dsh.profile.bundles in the profile package.json.\n');
        process.exit(127);
    }
    throw install.error;
}
if (install.status !== 0) {
    process.stderr.write(`install: pnpm failed with exit code ${install.status ?? '?'}\n`);
    process.exit(install.status ?? 1);
}

const manifest = readManifest(manifestPath) ?? {};
const bundles = manifest.dsh?.profile?.bundles ?? [];
const dependency = Object.keys(manifest.dependencies ?? {}).find((name) => name === PACKAGE_NAME);
process.stdout.write('\ninstall: result\n');
process.stdout.write(`  dependency : ${dependency === undefined ? 'MISSING' : manifest.dependencies[dependency]}\n`);
process.stdout.write(`  bundles    : ${bundles.includes(PACKAGE_NAME) ? 'includes ' + PACKAGE_NAME : 'MISSING ' + PACKAGE_NAME}\n`);
if (dependency === undefined || !bundles.includes(PACKAGE_NAME)) {
    process.stderr.write('install: the profile did not end up mounted — check the messages above.\n');
    process.exit(1);
}

// The bundle layer must really compose our row — the composition the host reads
// at boot, without starting anything.
const dump = spawnSync(`dsh --profile ${quoteShellArgument(options.profile)} --dump-config`, {
    cwd: profileDir, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
});
if (dump.status === 0 && typeof dump.stdout === 'string') {
    const composed = dump.stdout.includes(`name: ${PACKAGE_NAME}`);
    process.stdout.write(`  composed   : ${composed ? PACKAGE_NAME + ' present in "--dump-config"' : 'MISSING from the composed tree'}\n`);
    if (!composed) {
        process.stderr.write('install: the composed profile tree does not contain the plugin row.\n');
        process.exit(1);
    }
}
else {
    process.stdout.write('  composed   : unverified (run "dsh --profile '
        + `${options.profile} --dump-config" to inspect)\n`);
}

process.stdout.write(`
install: done. Next steps
  1. Restart DSH Desktop (the host half and the client module row load at boot).
  2. Hard-refresh the Web page (Ctrl+Shift+R) to load the browser half.
  3. Verify: enter plan mode (/plan), have the agent present a plan, and the
     "计划待审" card must show a "侧边栏" button in its strip. Click it: the card
     moves into the right Sidebar as a "计划待审" tab, the conversation shows a
     status bar, and the same three decision buttons live in the sidebar tab.

Uninstall: node scripts/install.mjs --profile ${options.profile} --uninstall
`);
process.stdout.write(`install: client bundle: ${join(pluginDir, 'lib', 'client.js')}\n`);
process.stdout.write(`install: plugin files: ${readdirSync(join(pluginDir, 'lib')).join(', ')}\n`);
