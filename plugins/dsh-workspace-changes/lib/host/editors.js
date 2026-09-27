/**
 * Editor detection and the open-in-IDE command builder — file-oriented mirror
 * of the first-party `@deepseek-ai/dsh-host-open-in-app` catalog (which opens
 * workspace DIRECTORIES; this plugin opens FILES at a line).
 *
 * Detection copies the catalog's win32 locator strategies:
 *  - App Paths registry (`reg query …\App Paths\<exe> /ve`, HKLM + HKCU);
 *  - well-known install paths (%LOCALAPPDATA%\Programs\…, %ProgramFiles%\…);
 *  - JetBrains: newest versioned dir under %ProgramFiles%\JetBrains, then
 *    Toolbox apps, then Uninstall install-records (InstallLocation\bin\…);
 *  - Sublime / Git Bash / Windows Terminal: well-known paths + PATH probe.
 *
 * Launch argument dialects per family:
 *  - vscode-family: `exe -g file:line`   (VS Code / Cursor / Windsurf / Insiders)
 *  - jetbrains:     `exe --line N file`
 *  - sublime:       `exe file:line`
 *  - explorer:      `explorer.exe /select,"file"`
 *  - terminals:     `git-bash.exe --cd=dir`, `wt.exe -d dir`
 *  - custom config entries: `{file}` / `{line}` / `{dir}` template.
 *
 * Ids match the first-party catalog so the renderer can reuse its
 * `/open-in-app/icon/<id>` PNGs verbatim.
 *
 * @module dsh-workspace-changes/host/editors
 */

import { existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

// ─── catalog ────────────────────────────────────────────────────────────────

/**
 * The detection catalog, in menu order. Each entry: id (first-party-compatible,
 * doubles as the icon id), label, kind (editor|manager|terminal), and the
 * win32 locator plan. `available` resolution is cached process-wide.
 */
const CATALOG = [
    { id: 'explorer', label: '文件资源管理器', kind: 'manager' },
    { id: 'vscode', label: 'VS Code', kind: 'editor', family: 'vscode', appPaths: 'Code.exe', files: ['%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe', '%ProgramFiles%/Microsoft VS Code/Code.exe'] },
    { id: 'cursor', label: 'Cursor', kind: 'editor', family: 'vscode', appPaths: 'Cursor.exe', files: ['%LOCALAPPDATA%/Programs/cursor/Cursor.exe'] },
    { id: 'vscode-insiders', label: 'VS Code Insiders', kind: 'editor', family: 'vscode', appPaths: 'Code - Insiders.exe', files: ['%LOCALAPPDATA%/Programs/Microsoft VS Code Insiders/Code - Insiders.exe'] },
    { id: 'windsurf', label: 'Windsurf', kind: 'editor', family: 'vscode', appPaths: 'Windsurf.exe', files: ['%LOCALAPPDATA%/Programs/Windsurf/Windsurf.exe'] },
    { id: 'intellij', label: 'IntelliJ IDEA', kind: 'editor', family: 'jetbrains', product: 'IntelliJ IDEA', exe: 'idea64.exe' },
    { id: 'pycharm', label: 'PyCharm', kind: 'editor', family: 'jetbrains', product: 'PyCharm', exe: 'pycharm64.exe' },
    { id: 'webstorm', label: 'WebStorm', kind: 'editor', family: 'jetbrains', product: 'WebStorm', exe: 'webstorm64.exe' },
    { id: 'phpstorm', label: 'PhpStorm', kind: 'editor', family: 'jetbrains', product: 'PhpStorm', exe: 'phpstorm64.exe' },
    { id: 'goland', label: 'GoLand', kind: 'editor', family: 'jetbrains', product: 'GoLand', exe: 'goland64.exe' },
    { id: 'rider', label: 'Rider', kind: 'editor', family: 'jetbrains', product: 'Rider', exe: 'rider64.exe' },
    { id: 'clion', label: 'CLion', kind: 'editor', family: 'jetbrains', product: 'CLion', exe: 'clion64.exe' },
    { id: 'sublimetext', label: 'Sublime Text', kind: 'editor', family: 'sublime', appPaths: 'sublime_text.exe', files: ['%ProgramFiles%/Sublime Text/sublime_text.exe'] },
    { id: 'gitbash', label: 'Git Bash', kind: 'terminal', record: { prefix: 'Git version', relative: 'git-bash.exe' }, files: ['%ProgramFiles%/Git/git-bash.exe', '%ProgramFiles(x86)%/Git/git-bash.exe'] },
    { id: 'windowsterminal', label: 'Windows Terminal', kind: 'terminal', cli: 'wt.exe' }
];

/** The editor preference order `editor: 'auto'` walks. */
const AUTO_ORDER = ['vscode', 'cursor', 'vscode-insiders', 'windsurf', 'intellij', 'pycharm', 'webstorm', 'phpstorm', 'goland', 'rider', 'clion', 'sublimetext'];

// ─── locators (win32) ───────────────────────────────────────────────────────

/** Expand %VARS% in a candidate path. */
function expandEnv(path) {
    return path.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

/** App Paths registry lookup (HKLM then HKCU); returns the executable path or undefined. */
function appPathsLocate(exe, io) {
    for (const hive of ['HKLM', 'HKCU']) {
        const out = io.runReg(['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve']);
        if (out === undefined) continue;
        const match = /REG_SZ\s+(\S[^\r\n]*)$/mu.exec(out);
        const path = match?.[1]?.trim();
        if (path !== undefined && path !== '' && io.exists(path)) return path;
    }
    return undefined;
}

/** First existing candidate path. */
function fileLocate(candidates, io) {
    for (const candidate of candidates ?? []) {
        const expanded = expandEnv(candidate);
        if (io.exists(expanded)) return expanded;
    }
    return undefined;
}

/** JetBrains locator: %ProgramFiles%\JetBrains\<Product> <ver>\bin\<exe>, newest version first. */
function jetbrainsScan(product, exe, io) {
    const root = expandEnv('%ProgramFiles%/JetBrains');
    let dirs;
    try {
        dirs = io.readdir(root);
    } catch {
        return undefined;
    }
    const candidates = dirs
        .filter((name) => name.startsWith(product))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const dir of candidates) {
        const launcher = `${root}/${dir}/bin/${exe}`;
        if (io.exists(launcher)) return launcher;
    }
    return undefined;
}

/** JetBrains Toolbox locator: %LOCALAPPDATA%\JetBrains\Toolbox\apps\<app>\ch-*\<ver>\bin\<exe>. */
function toolboxScan(product, exe, io) {
    const root = expandEnv('%LOCALAPPDATA%/JetBrains/Toolbox/apps');
    const wanted = product.toLowerCase().replace(/[^a-z0-9]/gu, '');
    let apps;
    try {
        apps = io.readdir(root);
    } catch {
        return undefined;
    }
    for (const app of apps) {
        if (!app.toLowerCase().replace(/[^a-z0-9]/gu, '').includes(wanted)) continue;
        let channels;
        try {
            channels = io.readdir(`${root}/${app}`);
        } catch {
            continue;
        }
        for (const channel of channels) {
            let versions;
            try {
                versions = io.readdir(`${root}/${app}/${channel}`);
            } catch {
                continue;
            }
            const newest = versions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
            for (const version of newest) {
                const launcher = `${root}/${app}/${channel}/${version}/bin/${exe}`;
                if (io.exists(launcher)) return launcher;
            }
        }
    }
    return undefined;
}

/** Uninstall install-record locator: DisplayName prefix → InstallLocation + relative launcher. */
function installRecordLocate(prefix, relative, io) {
    for (const hive of ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
        const found = io.runReg(['query', hive, '/s', '/f', prefix, '/d']);
        if (found === undefined) continue;
        for (const block of found.split(/\r?\n\r?\n/u)) {
            const location = /InstallLocation\s+REG_SZ\s+(\S[^\r\n]*)/u.exec(block)?.[1]?.trim();
            if (location === undefined || location === '') continue;
            const launcher = `${location.replace(/[\\/]+$/u, '')}/${relative}`;
            if (io.exists(launcher)) return launcher;
        }
    }
    return undefined;
}

/** PATH probe for terminal CLIs (wt.exe). */
function cliLocate(name, io) {
    const out = io.runWhere([name]);
    if (out === undefined) return undefined;
    const first = out.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '');
    return first !== undefined && io.exists(first) ? first : undefined;
}

/** Resolve one catalog entry to an executable path (undefined = not installed). */
function resolveEntry(entry, io) {
    if (process.platform !== 'win32') return undefined;
    if (entry.id === 'explorer') return 'always'; // ships with the OS
    if (entry.appPaths !== undefined) {
        const hit = appPathsLocate(entry.appPaths, io);
        if (hit !== undefined) return hit;
    }
    const fromFile = fileLocate(entry.files, io);
    if (fromFile !== undefined) return fromFile;
    if (entry.family === 'jetbrains') {
        const scanned = jetbrainsScan(entry.product, entry.exe, io);
        if (scanned !== undefined) return scanned;
        const fromToolbox = toolboxScan(entry.product, entry.exe, io);
        if (fromToolbox !== undefined) return fromToolbox;
        return installRecordLocate(entry.product, `bin/${entry.exe}`, io);
    }
    if (entry.record !== undefined) {
        const fromRecord = installRecordLocate(entry.record.prefix, entry.record.relative, io);
        if (fromRecord !== undefined) return fromRecord;
    }
    if (entry.cli !== undefined) return cliLocate(entry.cli, io);
    return undefined;
}

// ─── public face ────────────────────────────────────────────────────────────

/** Real IO (production); tests inject a fake. */
const realIo = {
    exists: (path) => existsSync(path),
    readdir: (path) => readdirSync(path),
    runReg: (argv) => {
        const result = spawnSync('reg.exe', argv, { encoding: 'utf8' });
        return result.status === 0 ? result.stdout ?? '' : undefined;
    },
    runWhere: (argv) => {
        const result = spawnSync('where.exe', argv, { encoding: 'utf8' });
        return result.status === 0 ? result.stdout ?? '' : undefined;
    }
};

/** Process-wide resolution cache (id → path). */
let resolvedCache;

/** Tests only: drop the resolution cache between fixtures. */
export function resetEditorCache() {
    resolvedCache = undefined;
}

/**
 * The editor list for the client: every installed catalog entry, plus the
 * plugin config's custom templates. Unavailable entries are omitted.
 * @param config - effective plugin config.
 * @param io - IO seam (tests).
 * @param fresh - true bypasses the process-wide cache (the client's refresh).
 */
export function listEditors(config, io = realIo, fresh = false) {
    if (resolvedCache === undefined || fresh) {
        resolvedCache = new Map();
        for (const entry of CATALOG) resolvedCache.set(entry.id, resolveEntry(entry, io));
    }
    const editors = [];
    for (const entry of CATALOG) {
        const path = resolvedCache.get(entry.id);
        if (path === undefined) continue;
        editors.push({ id: entry.id, label: entry.label, kind: entry.kind, available: true });
    }
    for (const custom of config.editors ?? []) {
        if (typeof custom?.id !== 'string' || typeof custom?.label !== 'string' || typeof custom?.command !== 'string') continue;
        const [binary] = tokenizeCommand(custom.command);
        if (binary !== undefined && (io.exists(expandEnv(binary)) || cliLocate(binary, io) !== undefined)) {
            editors.push({ id: custom.id, label: custom.label, kind: 'editor', available: true });
        }
    }
    editors.push({ id: 'system', label: '系统默认关联', kind: 'manager', available: true });
    return editors;
}

/**
 * Split a command template into argv, honoring double-quoted segments.
 * @param command - e.g. `"C:\\Tools\\idea64.exe" {file}`.
 */
export function tokenizeCommand(command) {
    const argv = [];
    const pattern = /"([^"]*)"|(\S+)/gu;
    for (const match of command.matchAll(pattern)) argv.push(match[1] ?? match[2]);
    return argv;
}

/**
 * Build the spawn spec for one open request.
 * @param editorId - the chosen editor id, or undefined for the configured default.
 * @param config - effective plugin config (`editor`, `editors`).
 * @param file - absolute file path (already confined to the workspace).
 * @param line - 1-based line number when the dialect supports it.
 * @param io - IO seam (tests).
 * @returns `{ argv }` or `{ error }`.
 */
export function buildOpenCommand(editorId, config, file, line = 1, io = realIo) {
    const available = new Map(listEditors(config, io).map((editor) => [editor.id, editor]));
    let wanted = editorId ?? (config.editor !== undefined && config.editor !== 'auto' ? config.editor : undefined);
    if (wanted === undefined) {
        wanted = AUTO_ORDER.find((id) => available.has(id)) ?? 'explorer';
    }
    if (wanted === 'system') return { argv: ['explorer.exe', file] };
    if (wanted === 'explorer') return { argv: ['explorer.exe', `/select,"${file}"`] };
    const entry = CATALOG.find((candidate) => candidate.id === wanted);
    if (entry !== undefined) {
        if (!available.has(wanted)) return { error: `${entry.label} 未安装或检测不到` };
        const exe = resolvedCache.get(wanted);
        switch (entry.family) {
            case 'vscode': return { argv: [exe, '-g', `${file}:${String(line)}`] };
            case 'jetbrains': return { argv: [exe, '--line', String(line), file] };
            case 'sublime': return { argv: [exe, `${file}:${String(line)}`] };
            default:
                break;
        }
        if (entry.kind === 'terminal') {
            const dir = dirname(file);
            return entry.id === 'gitbash' ? { argv: [exe, `--cd=${dir}`] } : { argv: [exe, '-d', dir] };
        }
        return { argv: [exe, file] };
    }
    const custom = (config.editors ?? []).find((candidate) => candidate?.id === wanted);
    if (custom === undefined) return { error: `未知编辑器：${wanted}` };
    const argv = tokenizeCommand(custom.command.replaceAll('{file}', file).replaceAll('{line}', String(line)).replaceAll('{dir}', dirname(file)));
    if (argv.length === 0) return { error: '编辑器命令为空' };
    return { argv };
}

/**
 * Launch the editor detached; failures arrive as the returned error string.
 * explorer.exe exits nonzero on success often enough that its code is ignored.
 */
export function launch(spec) {
    try {
        const child = spawn(spec.argv[0], spec.argv.slice(1), {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        // spawn ENOENT arrives asynchronously; without a listener it would throw.
        child.on('error', () => {});
        child.unref();
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
