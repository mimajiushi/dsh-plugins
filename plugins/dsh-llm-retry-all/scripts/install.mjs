#!/usr/bin/env node
/**
 * Install (or remove) this plugin in a DSH profile.
 *
 * What it does, in order:
 *   1. resolves the profile directory (`$DSH_HOME/profiles/<name>`);
 *   2. links the harness package this plugin's HOST half imports at runtime
 *      (`@deepseek-ai/schemastery`, declared in package.json dependencies)
 *      into the plugin's own `node_modules` — a `link:`-installed package
 *      lives outside the profile tree, so the Loader cannot see it from
 *      there. `@deepseek-ai/dsh-llm` is deliberately NOT imported: its
 *      identity-based markers (WeakSet) cannot survive the app.asar vs
 *      link-copy module split — see lib/index.js.
 *   3. backs the profile manifest up once;
 *   4. runs `dsh plugin --profile <name> add link:<this directory>`, which lets
 *      pnpm install it and reconcile the package into `dsh.profile.bundles`;
 *   5. re-composes the profile with `--dump-config` to prove the row is really
 *      mounted — not merely listed;
 *   6. prints the restart + verification steps.
 *
 * Usage:
 *   node scripts/install.mjs --profile desktop [--dry-run]
 *   node scripts/install.mjs --profile desktop --uninstall
 *
 * @module dsh-llm-retry-all/install
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PACKAGE_NAME = 'dsh-llm-retry-all';
/**
 * Harness packages the HOST half imports at runtime. The client half needs no
 * link: every module it requires is a frozen seed word of the browser module
 * table (react, react/jsx-runtime, @deepseek-ai/dsh-client-ui-primitives).
 */
const HOST_IMPORTS = ['@deepseek-ai/schemastery'];

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

/** Resolve one harness package the way the host does: shared tree, then profile tree, then fallback. */
function resolveHarnessPackage(packageName, profileDir, dshHome) {
    const candidates = [
        join(dshHome, 'profiles', 'node_modules', packageName),
        join(profileDir, 'node_modules', packageName),
        join(profileDir, '.dsh-module-fallback', 'node_modules', packageName),
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
            results.push(`${packageName}: NOT FOUND in the profile trees — the host may still resolve it itself`);
            continue;
        }
        const linkPath = join(pluginDir, 'node_modules', ...packageName.split('/'));
        const created = linkDirectory(target, linkPath);
        results.push(`${packageName}: ${created ? 'linked' : 'already linked'} -> ${target}`);
    }
    return results;
}

/** Quote one shell argument; harmless on POSIX, required on Windows. */
function quoteShellArgument(value) {
    return /[\s"&|<>^]/.test(value) ? `"${value.split('"').join('""')}"` : value;
}

/** Run one `dsh` command through the platform shell (the Windows shim is a .cmd). */
function runDsh(args, options) {
    const line = ['dsh', ...args].map(quoteShellArgument).join(' ');
    return spawnSync(line, { cwd: options.cwd, stdio: 'inherit', shell: true });
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
        + `  links    : ${HOST_IMPORTS.join(', ')}\n`
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

const backupPath = `${manifestPath}.bak-llm-retry-all`;
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
process.stdout.write(`  bundles    : ${bundles.includes(PACKAGE_NAME) ? `includes ${PACKAGE_NAME}` : `MISSING ${PACKAGE_NAME}`}\n`);
if (dependency === undefined || !bundles.includes(PACKAGE_NAME)) {
    process.stderr.write('install: the profile did not end up mounted — check the messages above.\n');
    process.exit(1);
}

const dump = spawnSync(`dsh --profile ${quoteShellArgument(options.profile)} --dump-config`, {
    cwd: profileDir, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
if (dump.status === 0 && typeof dump.stdout === 'string') {
    const composed = dump.stdout.includes(`name: ${PACKAGE_NAME}`);
    process.stdout.write(`  composed   : ${composed ? `${PACKAGE_NAME} present in "--dump-config"` : 'MISSING from the composed tree'}\n`);
    if (!composed) {
        process.stderr.write('install: the composed profile tree does not contain the plugin row.\n');
        process.exit(1);
    }
}
else {
    process.stdout.write(`  composed   : unverified (run "dsh --profile ${options.profile} --dump-config" to inspect)\n`);
}

process.stdout.write(`
install: done. Next steps
  1. Restart DSH Desktop COMPLETELY (the host caches every plugin package's
     bytes at compose time; only a restart loads new code).
  2. Hard-refresh the Web page (Ctrl+Shift+R) to load the browser half.
  3. Verify: Settings -> 插件 -> 插件配置 must show the "模型重试（网关全错误）"
     card with 最大重试次数 = 10000.
  4. Functional check: cut the network (or point the provider at a dead
     port), send one message — the chat shows a model-retry card waiting
     5s, 10s, 15s, ...; restore the network and the turn continues by itself.
     With the network down, run /compact — it must WAIT and retry instead of
     failing the task.

Host log lines to look for:
  ${PACKAGE_NAME}: mounted; maxRetries = 10000, backoff = linear +5s steps capped at 300s
  ${PACKAGE_NAME}: direct-call retry installed on the shared LLM runtime
  ${PACKAGE_NAME}: <provider> request failed (<code>); retry N/10000 in Xs
  ${PACKAGE_NAME}: direct llm.stream (<route>, purpose=compaction) failed (...); retry ...

Uninstall: node scripts/install.mjs --profile ${options.profile} --uninstall
`);
process.stdout.write(`install: plugin files: ${join(pluginDir, 'lib')} (index.js, logic.js, client.js)\n`);
