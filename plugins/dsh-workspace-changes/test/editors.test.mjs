/**
 * Editor catalog tests: detection locators (App Paths / well-known files /
 * JetBrains Program Files scan / Toolbox / Uninstall records / PATH) against
 * fake IO, and the per-family open-command dialects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { listEditors, buildOpenCommand, tokenizeCommand, resetEditorCache } from '../lib/host/editors.js';

const SKIP = process.platform !== 'win32';

/** Slash-normalize for assertions: detection joins env roots ('\') with '/' segments. */
const norm = (path) => path.replace(/\\/gu, '/');
const normArgv = (argv) => argv.map(norm);

/** Fake IO: a bag of existing paths plus canned reg/where answers. Paths are slash-normalized on both sides. */
function fakeIo({ files = [], dirs = {}, reg = {}, where = {} } = {}) {
    const norm = (path) => path.replace(/\\/gu, '/');
    const fileSet = new Set(files.map(norm));
    const dirMap = new Map(Object.entries(dirs).map(([key, value]) => [norm(key), value]));
    return {
        exists: (path) => fileSet.has(norm(path)),
        readdir: (path) => {
            const entries = dirMap.get(norm(path));
            if (entries === undefined) throw new Error('ENOENT');
            return entries;
        },
        runReg: (argv) => reg[argv.join(' ')],
        runWhere: (argv) => where[argv.join(' ')]
    };
}

const CONFIG = { editor: 'auto', editors: [], maxDiffBytes: 1, maxUntrackedBytes: 1, pollIntervalMs: 30_000 };

test('listEditors: App Paths resolves VS Code, scan resolves IDEA, file resolves Git Bash', { skip: SKIP }, () => {
    resetEditorCache();
    const io = fakeIo({
        files: [
            'C:/Users/u/AppData/Local/Programs/Microsoft VS Code/Code.exe',
            'C:/Program Files/JetBrains/IntelliJ IDEA 2024.3/bin/idea64.exe',
            'C:/Program Files/Git/git-bash.exe'
        ],
        dirs: {
            [`${process.env.ProgramFiles}/JetBrains`]: ['IntelliJ IDEA 2023.1', 'IntelliJ IDEA 2024.3']
        },
        reg: {
            'query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe /ve': '\nHKEY_LOCAL_MACHINE\\x\n    (默认)    REG_SZ    C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\n'
        }
    });
    const editors = listEditors(CONFIG, io, true);
    const ids = editors.map((editor) => editor.id);
    assert.ok(ids.includes('explorer'));
    assert.ok(ids.includes('vscode'));
    assert.ok(ids.includes('intellij'));
    assert.ok(ids.includes('gitbash'));
    assert.ok(!ids.includes('pycharm')); // not installed in this fixture
    assert.equal(ids[ids.length - 1], 'system');
});

test('listEditors: Toolbox fallback resolves Rider when Program Files has nothing', { skip: SKIP }, () => {
    resetEditorCache();
    const local = process.env.LOCALAPPDATA;
    const io = fakeIo({
        files: [`${local}/JetBrains/Toolbox/apps/Rider/ch-0/2024.3.2/bin/rider64.exe`],
        dirs: {
            [`${process.env.ProgramFiles}/JetBrains`]: ['IntelliJ IDEA 2024.3'], // no Rider here
            [`${local}/JetBrains/Toolbox/apps`]: ['Rider'],
            [`${local}/JetBrains/Toolbox/apps/Rider`]: ['ch-0'],
            [`${local}/JetBrains/Toolbox/apps/Rider/ch-0`]: ['2024.1.0', '2024.3.2']
        }
    });
    const editors = listEditors(CONFIG, io, true);
    assert.ok(editors.some((editor) => editor.id === 'rider'));
});

test('buildOpenCommand speaks each family dialect', { skip: SKIP }, () => {
    resetEditorCache();
    const io = fakeIo({
        files: [
            'C:/Program Files/JetBrains/PyCharm 2024.3/bin/pycharm64.exe',
            'C:/Program Files/Sublime Text/sublime_text.exe',
            'C:/Program Files/Git/git-bash.exe'
        ],
        dirs: { [`${process.env.ProgramFiles}/JetBrains`]: ['PyCharm 2024.3'] }
    });
    const file = 'D:/repo/scene/player/player.gd';
    assert.deepEqual(normArgv(buildOpenCommand('pycharm', CONFIG, file, 42, io).argv), [
        'C:/Program Files/JetBrains/PyCharm 2024.3/bin/pycharm64.exe', '--line', '42', file
    ]);
    assert.deepEqual(normArgv(buildOpenCommand('sublimetext', CONFIG, file, 7, io).argv), [
        'C:/Program Files/Sublime Text/sublime_text.exe', `${file}:7`
    ]);
    assert.deepEqual(normArgv(buildOpenCommand('explorer', CONFIG, file, 1, io).argv), ['explorer.exe', `/select,"${file}"`]);
    assert.deepEqual(normArgv(buildOpenCommand('system', CONFIG, file, 1, io).argv), ['explorer.exe', file]);
    assert.deepEqual(normArgv(buildOpenCommand('gitbash', CONFIG, file, 1, io).argv), [
        'C:/Program Files/Git/git-bash.exe', '--cd=D:/repo/scene/player'
    ]);
});

test('buildOpenCommand: auto prefers VS Code when present, else first available editor', { skip: SKIP }, () => {
    resetEditorCache();
    const withCode = fakeIo({
        files: ['C:/Users/u/AppData/Local/Programs/Microsoft VS Code/Code.exe'],
        reg: {
            'query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe /ve': '\nHKEY_LOCAL_MACHINE\\x\n    (默认)    REG_SZ    C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\n'
        }
    });
    const auto = buildOpenCommand(undefined, CONFIG, 'D:/repo/a.txt', 9, withCode);
    assert.deepEqual(normArgv(auto.argv), ['C:/Users/u/AppData/Local/Programs/Microsoft VS Code/Code.exe', '-g', 'D:/repo/a.txt:9']);

    resetEditorCache();
    const onlyIdea = fakeIo({
        files: ['C:/Program Files/JetBrains/IntelliJ IDEA 2024.3/bin/idea64.exe'],
        dirs: { [`${process.env.ProgramFiles}/JetBrains`]: ['IntelliJ IDEA 2024.3'] }
    });
    const fallback = buildOpenCommand(undefined, CONFIG, 'D:/repo/a.txt', 3, onlyIdea);
    assert.deepEqual(normArgv(fallback.argv), ['C:/Program Files/JetBrains/IntelliJ IDEA 2024.3/bin/idea64.exe', '--line', '3', 'D:/repo/a.txt']);
});

test('buildOpenCommand: custom templates substitute {file}/{line}/{dir}', { skip: SKIP }, () => {
    resetEditorCache();
    const config = { ...CONFIG, editors: [{ id: 'myedit', label: 'My Editor', command: '"C:\\Tools\\my editor.exe" --goto {file}:{line} --cwd {dir}' }] };
    const io = fakeIo({ files: ['C:\\Tools\\my editor.exe'] });
    const spec = buildOpenCommand('myedit', config, 'D:\\repo\\a.txt', 12, io);
    assert.deepEqual(spec.argv, ['C:\\Tools\\my editor.exe', '--goto', 'D:\\repo\\a.txt:12', '--cwd', 'D:\\repo']);
    const unknown = buildOpenCommand('nope', config, 'D:\\repo\\a.txt', 1, io);
    assert.ok(typeof unknown.error === 'string');
});

test('tokenizeCommand honors double-quoted segments', { skip: SKIP }, () => {
    assert.deepEqual(tokenizeCommand('"C:\\Program Files\\app.exe" /flag "two words"'), ['C:\\Program Files\\app.exe', '/flag', 'two words']);
});
