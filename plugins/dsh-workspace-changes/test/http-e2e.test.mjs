/**
 * HTTP end-to-end: the real registrar mounted on a real node:http server over
 * loopback, with a real git repository behind a child_process runner — every
 * layer exercised except DSH's own webServer plumbing (proven separately by
 * the in-production git-graph plugin using the same register() contract).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerChangesRoutes } from '../lib/host/routes.js';

function gitAvailable() {
    try {
        execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

/** Best-effort recursive removal: a lingering lock must not fail a green test. */
function sweep(dir) {
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
        console.warn(`test janitor: could not remove ${dir} yet (${String(error)}); the OS temp cleaner will`);
    }
}

/** Remove previous runs' leftovers (older than two minutes, so never a live run's). */
function sweepStale() {
    const cutoff = Date.now() - 120_000;
    for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('dsh-wc-http-')) continue;
        const dir = join(tmpdir(), entry.name);
        try {
            if (statSync(dir).mtimeMs < cutoff) sweep(dir);
        } catch {
            // gone already
        }
    }
}

/** child_process runner with the production seam shape (abortable). */
function realRunner() {
    return {
        async run(argv, cwd, signal) {
            return new Promise((resolve) => {
                const proc = spawn(GIT, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
                const out = [];
                const err = [];
                proc.stdout.on('data', (chunk) => out.push(chunk));
                proc.stderr.on('data', (chunk) => err.push(chunk));
                proc.on('error', () => resolve({ exitCode: 127, stdout: '', stderr: 'spawn failed' }));
                proc.on('close', (code) => resolve({ exitCode: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
            });
        }
    };
}

test('HTTP e2e: status/diff/editors over loopback against a real repository', { skip: !gitAvailable() }, async (t) => {
    sweepStale();
    const workspace = await realpath(mkdtempSync(join(tmpdir(), 'dsh-wc-http-')));
    const git = (argv) => execFileSync(GIT, argv, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-b', 'master']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\n');
    git(['add', '.']);
    git(['commit', '-m', 'init', '--quiet']);
    appendFileSync(join(workspace, 'a.txt'), 'three\n');
    writeFileSync(join(workspace, 'new.txt'), 'fresh\n');

    const handlers = [];
    const ctx = {
        webServer: {
            register(route) {
                handlers.push(route);
                return () => {};
            }
        },
        workspaceRegistry: { list: () => [{ path: workspace }] },
        logger: { warn() {} },
        on() { return () => {}; }
    };
    const dispose = registerChangesRoutes(ctx, realRunner(), () => ({
        editor: 'auto', editors: [], maxDiffBytes: 1024 * 1024, maxUntrackedBytes: 256 * 1024, pollIntervalMs: 30_000
    }));

    const server = createServer((req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        const exact = handlers.find((route) => route.kind === 'exact' && route.path === pathname);
        if (exact !== undefined) {
            void exact.handler(req, res);
            return;
        }
        const prefix = handlers.find((route) => route.kind === 'prefix' && pathname.startsWith(route.path));
        if (prefix !== undefined) void prefix.handler(req, res);
        else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, payload) => fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
    }).then((response) => response.json());

    try {
        const status = await post('/changes/status', { path: workspace });
        assert.equal(status.ok, true);
        assert.equal(status.value.branch, 'master');
        assert.deepEqual(status.value.groups.changes.map((entry) => entry.path), ['a.txt']);
        assert.deepEqual(status.value.groups.unversioned.map((entry) => entry.path), ['new.txt']);
        assert.equal(status.value.totals.files, 2);

        const diff = await post('/changes/diff', { path: workspace, file: 'a.txt' });
        assert.equal(diff.ok, true);
        assert.equal(diff.value.untracked, false);
        const added = diff.value.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.t === '+');
        assert.deepEqual(added.map((line) => line.text), ['three']);

        const fresh = await post('/changes/diff', { path: workspace, file: 'new.txt' });
        assert.equal(fresh.ok, true);
        assert.equal(fresh.value.untracked, true);
        assert.deepEqual(fresh.value.hunks[0].lines.map((line) => line.text), ['fresh']);

        const editors = await fetch(`${base}/changes/editors`).then((response) => response.json());
        assert.equal(editors.ok, true);
        assert.ok(editors.value.some((editor) => editor.id === 'system'));

        // SSE: opens, announces retry, and stays silent until a change.
        const controller = new AbortController();
        const sse = await fetch(`${base}/changes/events?path=${encodeURIComponent(workspace)}`, { signal: controller.signal });
        assert.equal(sse.status, 200);
        const reader = sse.body.getReader();
        const first = await reader.read();
        assert.ok(Buffer.from(first.value).toString('utf8').startsWith('retry:'));
        controller.abort();

        // Gate: an unregistered path is refused.
        const stranger = await post('/changes/status', { path: tmpdir() });
        assert.equal(stranger.ok, false);
        assert.equal(stranger.error.code, 'workspace-unknown');
    } finally {
        dispose();
        server.close();
        sweep(workspace);
    }
});
