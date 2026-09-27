/**
 * Status parsing tests: hand-built fixtures mirroring real
 * `git status --porcelain=v2 --branch -z` bytes (captured 2026-09-25 from git
 * 2.x on Windows) plus an end-to-end pass over a real temporary repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePorcelainV2, parseNumstat, buildGroups, totalsOf, readStatus, KIND } from '../lib/host/status.js';

const NL = '\0';

test('parsePorcelainV2 reads branch headers, worktree changes, untracked', () => {
    const text = [
        '# branch.oid 845340d6509e45c72415616d345559f7fc09aea9',
        '# branch.head master',
        '1 .D N... 100644 100644 000000 abaddc0b9edd523c69166a2c9f3a9e31a4c873e3 abaddc0b9edd523c69166a2c9f3a9e31a4c873e3 del.txt',
        '1 .M N... 100644 100644 100644 a29bdeb434d874c9b1d8969c40c42161b03fafdc a29bdeb434d874c9b1d8969c40c42161b03fafdc renamed.txt',
        '? logs.txt',
        ''
    ].join(NL);
    const view = parsePorcelainV2(text);
    assert.equal(view.branch, 'master');
    assert.equal(view.oid, '845340d6509e45c72415616d345559f7fc09aea9');
    assert.equal(view.ahead, 0);
    assert.equal(view.behind, 0);
    assert.deepEqual(view.entries, [
        { kind: KIND.DELETED, path: 'del.txt', xy: '.D' },
        { kind: KIND.MODIFIED, path: 'renamed.txt', xy: '.M' },
        { kind: KIND.UNTRACKED, path: 'logs.txt' }
    ]);
});

test('parsePorcelainV2 reads staged add, staged rename (origPath field), conflict', () => {
    const text = [
        '# branch.oid f13549ae1ea0756cd4fe937965a9972eae00a3a0',
        '# branch.head master',
        '2 R. N... 100644 100644 100644 a29bdeb434d874c9b1d8969c40c42161b03fafdc a29bdeb434d874c9b1d8969c40c42161b03fafdc R100 moved.txt',
        'a.txt',
        '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 ce013625030ba8dba906f756967f9e9ca394464a staged-new.txt',
        'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 1f7391f92b6a3792204e07e99f71f643cc35e7e1 2299c37978265a95cbe835a4b0f0bbf15aad5549 conflict.txt',
        ''
    ].join(NL);
    const view = parsePorcelainV2(text);
    assert.deepEqual(view.entries, [
        { kind: KIND.RENAMED, path: 'moved.txt', oldPath: 'a.txt', xy: 'R.' },
        { kind: KIND.ADDED, path: 'staged-new.txt', xy: 'A.' },
        { kind: KIND.CONFLICT, path: 'conflict.txt' }
    ]);
});

test('parsePorcelainV2 reads ahead/behind and detached HEAD', () => {
    const text = [
        '# branch.oid 845340d6509e45c72415616d345559f7fc09aea9',
        '# branch.head (detached)',
        '# branch.upstream origin/master',
        '# branch.ab +3 -2',
        ''
    ].join(NL);
    const view = parsePorcelainV2(text);
    assert.equal(view.ahead, 3);
    assert.equal(view.behind, 2);
    assert.equal(view.upstream, 'origin/master');
    // Detached shows "(detached)" as the head name; the caller treats it via oid.
    assert.equal(view.branch, '(detached)');
});

test('parsePorcelainV2 keeps CJK and space-carrying paths literal', () => {
    const text = '? resources/texture/源石 虫.png\0? logs.txt\0';
    const view = parsePorcelainV2(text);
    assert.deepEqual(view.entries.map((entry) => entry.path), ['resources/texture/源石 虫.png', 'logs.txt']);
});

test('parsePorcelainV2 prefers the staged letter for a both-sides change', () => {
    const text = '1 AM N... 000000 100644 100644 0000000000000000000000000000000000000000 ce013625030ba8dba906f756967f9e9ca394464a added-then-edited.txt\0';
    const view = parsePorcelainV2(text);
    assert.equal(view.entries[0].kind, KIND.ADDED);
});

test('parseNumstat reads counts and binary rows', () => {
    const text = ['0\t1\tdel.txt', '2\t0\trenamed.txt', '-\t-\tassets/logo.png', ''].join(NL);
    const counts = parseNumstat(text);
    assert.deepEqual(counts.get('del.txt'), { added: 0, deleted: 1, binary: false });
    assert.deepEqual(counts.get('renamed.txt'), { added: 2, deleted: 0, binary: false });
    assert.deepEqual(counts.get('assets/logo.png'), { added: 0, deleted: 0, binary: true });
});

test('buildGroups splits conflicts/changes/unversioned and merges counts', () => {
    const status = {
        entries: [
            { kind: KIND.CONFLICT, path: 'conflict.txt' },
            { kind: KIND.MODIFIED, path: 'scene/player/player.gd' },
            { kind: KIND.RENAMED, path: 'moved.txt', oldPath: 'a.txt' },
            { kind: KIND.UNTRACKED, path: 'logs.txt' }
        ]
    };
    const counts = new Map([['scene/player/player.gd', { added: 30, deleted: 4, binary: false }]]);
    const groups = buildGroups(status, counts);
    assert.equal(groups.conflicts.length, 1);
    assert.equal(groups.changes.length, 2);
    assert.equal(groups.unversioned.length, 1);
    assert.deepEqual(groups.changes[0], { path: 'moved.txt', kind: KIND.RENAMED, oldPath: 'a.txt', added: 0, deleted: 0 });
    assert.equal(groups.changes[1].added, 30);
    assert.deepEqual(totalsOf(groups), { files: 4, added: 30, deleted: 4 });
});

test('buildGroups caps a group and keeps totals from the complete parse', () => {
    const entries = [];
    for (let index = 0; index < 5001; index += 1) entries.push({ kind: KIND.MODIFIED, path: `f${String(index).padStart(5, '0')}.txt`, xy: '.M' });
    const groups = buildGroups({ entries }, new Map());
    assert.equal(groups.changes.length, 5000);
    assert.equal(groups.hidden.changes, 1);
    assert.equal(groups.hidden.conflicts, 0);
    assert.equal(groups.hidden.unversioned, 0);
    // totals see the complete parse: 5001 files even though 5000 render.
    const totals = totalsOf(groups, new Map(), 5001);
    assert.equal(totals.files, 5001);
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

/** A child_process runner with the same seam shape as the production one. */
function realRunner() {
    const binary = process.platform === 'win32' ? 'git.exe' : 'git';
    return {
        async run(argv, cwd) {
            try {
                const stdout = execFileSync(binary, argv, { cwd, encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
                return { exitCode: 0, stdout, stderr: '' };
            } catch (error) {
                return { exitCode: error.status ?? 1, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '' };
            }
        }
    };
}

test('readStatus over a real repository groups every state', { skip: !gitAvailable() }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wc-it-'));
    try {
        const git = (argv) => execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', argv, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
        git(['init', '-b', 'master']);
        git(['config', 'user.email', 't@t']);
        git(['config', 'user.name', 't']);
        mkdirSync(join(dir, 'sub'), { recursive: true });
        writeFileSync(join(dir, 'a.txt'), 'line1\n');
        writeFileSync(join(dir, 'sub', 'b.txt'), 'x\n');
        git(['add', '.']);
        git(['commit', '-m', 'init', '--quiet']);
        appendFileSync(join(dir, 'a.txt'), 'line2\n');
        writeFileSync(join(dir, 'untracked.txt'), 'u\n');
        writeFileSync(join(dir, 'gone.txt'), 'g\n');
        git(['add', 'gone.txt']);
        git(['commit', '-m', 'two', '--quiet']);
        unlinkSync(join(dir, 'gone.txt'));
        // Staged after the last commit, so it survives as an index change.
        writeFileSync(join(dir, 'staged.txt'), 'new\n');
        git(['add', 'staged.txt']);

        const result = await readStatus(realRunner(), dir);
        assert.equal(result.ok, true);
        assert.equal(result.value.branch, 'master');
        assert.equal(result.value.detached, false);
        assert.equal(result.value.head.length, 7);
        const paths = {
            changes: result.value.groups.changes.map((entry) => entry.path),
            unversioned: result.value.groups.unversioned.map((entry) => entry.path)
        };
        assert.deepEqual(paths.changes, ['a.txt', 'gone.txt', 'staged.txt']);
        assert.deepEqual(paths.unversioned, ['untracked.txt']);
        const staged = result.value.groups.changes.find((entry) => entry.path === 'staged.txt');
        assert.equal(staged.kind, KIND.ADDED);
        const gone = result.value.groups.changes.find((entry) => entry.path === 'gone.txt');
        assert.equal(gone.kind, KIND.DELETED);
        assert.equal(result.value.totals.files, 4);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
