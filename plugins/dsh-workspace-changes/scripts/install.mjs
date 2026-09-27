#!/usr/bin/env node
/**
 * Install (or reinstall) this plugin into a DSH profile.
 *
 *   1. resolves the profile directory (`$DSH_HOME/profiles/<name>`);
 *   2. links the harness packages this plugin's *host* side resolves at runtime
 *      into the plugin's own `node_modules` (a `link:`-installed package lives
 *      outside the profile tree, so the Loader cannot see them from here);
 *   3. backs up the profile manifest once;
 *   4. runs `dsh plugin --profile <name> add link:<this directory>`;
 *   5. verifies the bundle layer list and, when the launcher allows it, the
 *      composed config tree;
 *   6. prints the restart/verification steps.
 *
 * Usage: node scripts/install.mjs [--profile desktop] [--dry-run] [--uninstall]
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PACKAGE_NAME = 'dsh-workspace-changes';
/** Harness packages the host half imports directly (schemastery for Config). */
const HOST_IMPORTS = ['@deepseek-ai/schemastery'];

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
    const options = { profile: 'desktop', dryRun: false, uninstall: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--profile') options.profile = argv[++index] ?? options.profile;
        else if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--uninstall') options.uninstall = true;
        else {
            process.stderr.write(`install: unknown argument ${JSON.stringify(arg)}\n`);
            process.exit(2);
        }
    }
    return options;
}

function readManifest(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

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

function linkDirectory(target, path) {
    if (existsSync(path)) return false;
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
}

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

function runDsh(args, options) {
    const line = ['dsh', ...args].map(quoteShellArgument).join(' ');
    return spawnSync(line, { cwd: options.cwd, stdio: 'inherit', shell: true });
}

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
    process.stdout.write(`install (dry run)\n  profile  : ${profileDir}\n  package  : ${PACKAGE_NAME} ${readManifest(join(pluginDir, 'package.json'))?.version ?? '?'}\n  spec     : ${spec}\n`);
    process.exit(0);
}

if (options.uninstall) {
    const removal = runDsh(['plugin', '--profile', options.profile, 'remove', PACKAGE_NAME], { cwd: profileDir });
    if (removal.error !== undefined) throw removal.error;
    process.stdout.write(`${PACKAGE_NAME} removed from profile "${options.profile}".\nRestart DSH, then hard-refresh the Web page.\n`);
    process.exit(removal.status ?? 1);
}

for (const line of linkHostImports(profileDir, dshHome)) process.stdout.write(`install: ${line}\n`);

const backupPath = `${manifestPath}.bak-workspace-changes`;
if (!existsSync(backupPath)) {
    copyFileSync(manifestPath, backupPath);
    process.stdout.write(`install: backed up ${manifestPath} -> ${backupPath}\n`);
}

process.stdout.write(`install: running "dsh plugin --profile ${options.profile} add ${spec}"\n`);
const install = runDsh(['plugin', '--profile', options.profile, 'add', spec], { cwd: profileDir });
if (install.error !== undefined) {
    if (install.error.code === 'ENOENT') {
        process.stderr.write('install: `dsh` was not found on PATH; run pnpm manually:\n'
            + `install:   cd ${profileDir} && pnpm add "${spec}"\n`
            + 'install: then append the package name to dsh.profile.bundles in the profile package.json.\n');
        process.exit(127);
    }
    throw install.error;
}
if (install.status !== 0) {
    process.stderr.write(`install: the installer failed with exit code ${install.status ?? '?'}\n`);
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

process.stdout.write(`
install: done. Next steps
  1. Restart DSH Desktop (the host half loads at boot; the /changes routes answer only afterwards).
  2. Hard-refresh the Web page (Ctrl+Shift+R) to load the browser half.
  3. Verify: open a session whose workspace is a git repository, open the right
     Sidebar's guide ("+"), click 变更 — the grouped changes tree appears; click
     a file for the diff view (复制 diff / 在 IDE 打开 / 统一⇄双栏).

Uninstall: node scripts/install.mjs --profile ${options.profile} --uninstall
`);
