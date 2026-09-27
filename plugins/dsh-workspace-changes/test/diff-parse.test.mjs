/**
 * Diff parsing tests: unified output → structured hunks, synthetic untracked
 * diffs, copy-text round-trips, and an end-to-end pass over a real repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseUnifiedDiff, syntheticUntrackedDiff, toUnifiedText, looksBinary } from '../lib/host/diff.js';

test('parseUnifiedDiff parses a plain modification', () => {
    const text = [
        'diff --git a/renamed.txt b/renamed.txt',
        'index a29bdeb..2b302a0 100644',
        '--- a/renamed.txt',
        '+++ b/renamed.txt',
        '@@ -1 +1,3 @@',
        ' line1',
        '+line2',
        '+more',
        ''
    ].join('\n');
    const files = parseUnifiedDiff(text);
    assert.equal(files.length, 1);
    assert.equal(files[0].file, 'renamed.txt');
    assert.equal(files[0].binary, false);
    assert.equal(files[0].hunks.length, 1);
    const hunk = files[0].hunks[0];
    assert.equal(hunk.oldStart, 1);
    assert.equal(hunk.oldLines, 1);
    assert.equal(hunk.newStart, 1);
    assert.equal(hunk.newLines, 3);
    assert.deepEqual(hunk.lines.map((line) => line.t), [' ', '+', '+']);
    assert.deepEqual(hunk.lines.map((line) => line.text), ['line1', 'line2', 'more']);
});

test('parseUnifiedDiff parses new-file and deleted-file forms', () => {
    const created = parseUnifiedDiff([
        'diff --git a/staged-new.txt b/staged-new.txt',
        'new file mode 100644',
        'index 0000000..ce01362',
        '--- /dev/null',
        '+++ b/staged-new.txt',
        '@@ -0,0 +1 @@',
        '+hello',
        ''
    ].join('\n'));
    assert.equal(created[0].file, 'staged-new.txt');
    assert.equal(created[0].oldFile, undefined);
    assert.equal(created[0].hunks[0].oldLines, 0);

    const deleted = parseUnifiedDiff([
        'diff --git a/del.txt b/del.txt',
        'deleted file mode 100644',
        'index abaddc0..0000000',
        '--- a/del.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-del',
        ''
    ].join('\n'));
    assert.equal(deleted[0].file, 'del.txt');
    assert.equal(deleted[0].oldFile, 'del.txt');
    assert.deepEqual(deleted[0].hunks[0].lines, [{ t: '-', text: 'del' }]);
});

test('parseUnifiedDiff keeps the section text and the no-newline marker', () => {
    const files = parseUnifiedDiff([
        'diff --git a/player.gd b/player.gd',
        'index 111..222 100644',
        '--- a/player.gd',
        '+++ b/player.gd',
        '@@ -10,3 +10,4 @@ func _ready():',
        ' context',
        '-old',
        '+new',
        '+tail',
        '\\ No newline at end of file',
        ''
    ].join('\n'));
    const hunk = files[0].hunks[0];
    assert.equal(hunk.section, 'func _ready():');
    assert.deepEqual(hunk.lines[4], { t: '\\', text: 'No newline at end of file' });
});

test('parseUnifiedDiff marks binary files and skips index/mode chatter', () => {
    const files = parseUnifiedDiff([
        'diff --git a/assets/logo.png b/assets/logo.png',
        'index 111..222 100644',
        'Binary files a/assets/logo.png and b/assets/logo.png differ',
        ''
    ].join('\n'));
    assert.equal(files[0].binary, true);
    assert.equal(files[0].hunks.length, 0);
});

test('parseUnifiedDiff handles rename headers and CJK paths with spaces', () => {
    const files = parseUnifiedDiff([
        'diff --git a/resources/旧 名.png b/resources/新 名.png',
        'similarity index 90%',
        'rename from resources/旧 名.png',
        'rename to resources/新 名.png',
        ''
    ].join('\n'));
    assert.equal(files[0].file, 'resources/新 名.png');
    assert.equal(files[0].oldFile, 'resources/旧 名.png');
});

test('parseUnifiedDiff splits several files and flags transport truncation', () => {
    const text = [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/c.txt b/c.txt',
        '--- a/c.txt',
        '+++ b/c.txt',
        '@@ -1 +1 @@',
        '-c'
    ].join('\n');
    const files = parseUnifiedDiff(text, true);
    assert.equal(files.length, 2);
    assert.equal(files[1].truncated, true);
});

test('syntheticUntrackedDiff adds every line and drops the trailing terminator', () => {
    const diff = syntheticUntrackedDiff('notes.md', Buffer.from('one\ntwo\n', 'utf8'), false);
    assert.equal(diff.untracked, true);
    assert.equal(diff.binary, false);
    assert.deepEqual(diff.hunks[0].lines, [
        { t: '+', text: 'one' },
        { t: '+', text: 'two' }
    ]);
    assert.equal(diff.hunks[0].newLines, 2);
});

test('syntheticUntrackedDiff sniffs binaries and reports the cap', () => {
    const binary = syntheticUntrackedDiff('a.png', Buffer.from([0x89, 0x50, 0, 0x0d]), false);
    assert.equal(binary.binary, true);
    assert.equal(binary.hunks.length, 0);
    const capped = syntheticUntrackedDiff('big.txt', Buffer.from('x'.repeat(100), 'utf8'), true);
    assert.equal(capped.truncated, true);
});

test('looksBinary only probes the first 8 KiB', () => {
    const clean = Buffer.concat([Buffer.from('x'.repeat(8192)), Buffer.from([0])]);
    assert.equal(looksBinary(clean), false);
    assert.equal(looksBinary(Buffer.from('a\0b')), true);
});

test('toUnifiedText round-trips a parsed diff', () => {
    const source = [
        'diff --git a/a.txt b/a.txt',
        'index 111..222 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-old',
        '+new',
        ''
    ].join('\n');
    const [diff] = parseUnifiedDiff(source);
    const text = toUnifiedText(diff);
    assert.ok(text.includes('@@ -1,2 +1,2 @@'));
    assert.ok(text.includes('-old'));
    assert.ok(text.includes('+new'));
    assert.ok(text.includes(' keep'));
});

// ── integration against real git ────────────────────────────────────────────

function gitAvailable() {
    try {
        execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

test('parseUnifiedDiff over real git diff output (incl. CRLF strip)', { skip: !gitAvailable() }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wc-diff-'));
    try {
        const binary = process.platform === 'win32' ? 'git.exe' : 'git';
        const git = (argv) => execFileSync(binary, argv, { cwd: dir, encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
        git(['init', '-b', 'master']);
        git(['config', 'user.email', 't@t']);
        git(['config', 'user.name', 't']);
        writeFileSync(join(dir, 'a.txt'), 'l1\r\nl2\r\nl3\r\n');
        git(['add', '.']);
        git(['commit', '-m', 'init', '--quiet']);
        appendFileSync(join(dir, 'a.txt'), 'l4\r\n');
        const out = git(['diff', '--no-color', 'HEAD', '--', 'a.txt']);
        const [diff] = parseUnifiedDiff(out);
        assert.equal(diff.file, 'a.txt');
        assert.equal(diff.hunks.length, 1);
        const added = diff.hunks[0].lines.filter((line) => line.t === '+');
        assert.deepEqual(added.map((line) => line.text), ['l4']);
        // No line text may carry a carriage return through to the renderer.
        for (const line of diff.hunks[0].lines) assert.ok(!line.text.includes('\r'), `CR stripped: ${JSON.stringify(line)}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
