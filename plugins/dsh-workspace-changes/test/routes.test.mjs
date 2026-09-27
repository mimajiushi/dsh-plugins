/**
 * Route-layer tests: trust fence, content-type hardening, workspace gate,
 * envelope shapes, and the untracked-content confinement — driven through the
 * real registrar with a fake webServer / runner / workspaceRegistry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerChangesRoutes, isLoopback, containedIn } from '../lib/host/routes.js';

/** A minimal fake request. */
function req({ method = 'POST', path = '/changes/status', body, contentType = 'application/json', remote = '127.0.0.1', query = '' }) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const listeners = {};
    return {
        method,
        url: query === '' ? path : `${path}?${query}`,
        headers: { 'content-type': contentType },
        socket: { remoteAddress: remote },
        on(event, fn) { listeners[event] = fn; },
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
        },
        destroy() {},
        _listeners: listeners
    };
}

/** A minimal fake response capturing status + body. */
function res() {
    return {
        status: undefined,
        body: '',
        writes: [],
        writeHead(status) { this.status = status; },
        write(chunk) { this.writes.push(String(chunk)); },
        end(payload) { if (typeof payload === 'string') this.body = payload; },
        on() {}
    };
}

/** Build the route set against a sandbox with one registered workspace. */
async function mount(options = {}) {
    // The registry stores canonical paths (DSH registers user-picked long-form
    // dirs); canonicalize the fixture root with the SAME async realpath the
    // gate uses — realpathSync on Windows keeps 8.3 short names while the
    // async form expands them.
    const workspace = options.workspace ?? await realpath(mkdtempSync(join(tmpdir(), 'dsh-wc-route-')));
    const handlers = new Map();
    const ctx = {
        webServer: {
            register(route) {
                handlers.set(route.path, route.handler);
                return () => handlers.delete(route.path);
            }
        },
        workspaceRegistry: { list: () => [{ path: workspace }] },
        logger: { warn() {} },
        on() { return () => {}; }
    };
    const runner = options.runner ?? {
        async run(argv) {
            if (argv[0] === 'rev-parse') return { exitCode: 0, stdout: `${workspace}\n`, stderr: '' };
            if (argv[0] === 'status' && argv.includes('--porcelain=v2')) return { exitCode: 0, stdout: '# branch.head master\0', stderr: '' };
            if (argv[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
            if (argv[0] === 'diff' && argv.includes('--numstat')) return { exitCode: 0, stdout: '', stderr: '' };
            if (argv[0] === 'diff') return { exitCode: 0, stdout: '', stderr: '' };
            return { exitCode: 1, stdout: '', stderr: 'unexpected argv' };
        }
    };
    const dispose = registerChangesRoutes(ctx, runner, () => ({
        editor: 'auto', editors: [], maxDiffBytes: 1024 * 1024, maxUntrackedBytes: 256 * 1024, pollIntervalMs: 30_000,
        ...(options.config ?? {})
    }));
    return { workspace, handlers, dispose };
}

test('isLoopback admits only loopback peers', () => {
    const local = req({ remote: '127.0.0.1' });
    const v6 = req({ remote: '::1' });
    const mapped = req({ remote: '::ffff:127.0.0.1' });
    const lan = req({ remote: '192.168.1.20' });
    assert.equal(isLoopback(local), true);
    assert.equal(isLoopback(v6), true);
    assert.equal(isLoopback(mapped), true);
    assert.equal(isLoopback(lan), false);
});

test('containedIn confines to the root with a separator boundary', () => {
    assert.equal(containedIn('/repo', '/repo/a.txt'), true);
    assert.equal(containedIn('/repo', '/repo2/a.txt'), false);
    assert.equal(containedIn('/repo', '/repo'), false);
    assert.equal(containedIn('C:\\ws', 'C:\\ws\\sub\\b.txt'), true);
    assert.equal(containedIn('C:\\ws', 'C:\\ws2\\b.txt'), false);
});

test('status route: loopback fence, 405, 415, gate, envelope', async () => {
    const { workspace, handlers, dispose } = await mount();
    try {
        const handler = handlers.get('/changes');

        const lan = res();
        await handler(req({ remote: '10.0.0.5' }), lan);
        assert.equal(lan.status, 403);

        const got = res();
        await handler(req({ method: 'GET' }), got);
        assert.equal(got.status, 405);

        const form = res();
        await handler(req({ contentType: 'application/x-www-form-urlencoded' }), form);
        assert.equal(form.status, 415);

        const outside = res();
        await handler(req({ body: { path: join(tmpdir(), 'definitely-not-registered-' + Date.now()) } }), outside);
        assert.equal(outside.status, 200);
        assert.equal(JSON.parse(outside.body).ok, false);
        assert.equal(JSON.parse(outside.body).error.code, 'workspace-unknown');

        const ok = res();
        await handler(req({ body: { path: workspace } }), ok);
        assert.equal(ok.status, 200);
        const envelope = JSON.parse(ok.body);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.value.branch, 'master');
        assert.deepEqual(envelope.value.totals, { files: 0, added: 0, deleted: 0 });
    } finally {
        dispose();
        rmSync(workspace, { recursive: true, force: true });
    }
});

test('status route answers null for a registered non-repository', async () => {
    const runner = {
        async run(argv) {
            if (argv[0] === 'rev-parse') return { exitCode: 128, stdout: '', stderr: 'not a git repository' };
            return { exitCode: 0, stdout: '', stderr: '' };
        }
    };
    const { workspace, handlers, dispose } = await mount({ runner });
    try {
        const response = res();
        await handlers.get('/changes')(req({ body: { path: workspace } }), response);
        assert.deepEqual(JSON.parse(response.body), { ok: true, value: null });
    } finally {
        dispose();
        rmSync(workspace, { recursive: true, force: true });
    }
});

test('diff route refuses to read a file git does not report as untracked', async () => {
    const { workspace, handlers, dispose } = await mount();
    try {
        writeFileSync(join(workspace, 'secret.txt'), 'top secret\n');
        // Runner reports nothing untracked for the scoped probe.
        const response = res();
        await handlers.get('/changes')(req({ path: '/changes/diff', body: { path: workspace, file: 'secret.txt' } }), response);
        const envelope = JSON.parse(response.body);
        // Falls to the tracked path: empty diff, never the file content.
        assert.equal(envelope.ok, true);
        assert.deepEqual(envelope.value.hunks, []);
    } finally {
        dispose();
        rmSync(workspace, { recursive: true, force: true });
    }
});

test('diff route serves untracked content only after the probe confirms it', async () => {
    const runner = {
        async run(argv) {
            if (argv[0] === 'rev-parse') return { exitCode: 0, stdout: `${workspaceGlobal}\n`, stderr: '' };
            if (argv[0] === 'status' && argv.includes('--untracked-files=all') && argv.includes('--')) {
                return { exitCode: 0, stdout: '?? new-file.txt\0', stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        }
    };
    let workspaceGlobal;
    const { workspace, handlers, dispose } = await (async () => {
        const mounted = await mount({ runner });
        workspaceGlobal = mounted.workspace;
        return mounted;
    })();
    try {
        writeFileSync(join(workspace, 'new-file.txt'), 'hello\nworld\n');
        const response = res();
        await handlers.get('/changes')(req({ path: '/changes/diff', body: { path: workspace, file: 'new-file.txt' } }), response);
        const envelope = JSON.parse(response.body);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.value.untracked, true);
        assert.deepEqual(envelope.value.hunks[0].lines.map((line) => line.text), ['hello', 'world']);
    } finally {
        dispose();
        rmSync(workspace, { recursive: true, force: true });
    }
});

test('diff route reads an untracked file only up to the byte cap', async () => {
    const runner = {
        async run(argv) {
            if (argv[0] === 'rev-parse') return { exitCode: 0, stdout: `${workspaceGlobal}\n`, stderr: '' };
            if (argv[0] === 'status' && argv.includes('--untracked-files=all') && argv.includes('--')) {
                return { exitCode: 0, stdout: '?? big.txt\0', stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        }
    };
    let workspaceGlobal;
    const { workspace, handlers, dispose } = await (async () => {
        const mounted = await mount({ runner, config: { maxUntrackedBytes: 1024 } });
        workspaceGlobal = mounted.workspace;
        return mounted;
    })();
    try {
        // 10 KB on disk; the route must read only the first 1024 bytes.
        writeFileSync(join(workspace, 'big.txt'), `head\n${'x'.repeat(10 * 1024)}\ntail\n`);
        const response = res();
        await handlers.get('/changes')(req({ path: '/changes/diff', body: { path: workspace, file: 'big.txt' } }), response);
        const envelope = JSON.parse(response.body);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.value.untracked, true);
        assert.equal(envelope.value.truncated, true);
        const text = envelope.value.hunks[0].lines.map((line) => line.text).join('\n');
        assert.ok(text.startsWith('head'));
        assert.ok(!text.endsWith('tail')); // the tail is past the cap
        assert.ok(text.length <= 1024);
    } finally {
        dispose();
        rmSync(workspace, { recursive: true, force: true });
    }
});

test('open route confines files to the workspace', async () => {
    const { workspace, handlers, dispose } = await mount();
    try {
        const escape = res();
        await handlers.get('/changes')(req({ path: '/changes/open', body: { path: workspace, file: '../../etc/hosts' } }), escape);
        const envelope = JSON.parse(escape.body);
        assert.equal(envelope.ok, false);
        assert.ok(['outside-workspace', 'not-found'].includes(envelope.error.code));
    } finally {
        dispose();
        rmSync(workspace, { recursive: true, force: true });
    }
});

test('unknown route is 404 and editors route lists the system fallback', async () => {
    const { workspace, handlers, dispose } = await mount();
    try {
        const missing = res();
        await handlers.get('/changes')(req({ path: '/changes/nope', body: { path: workspace } }), missing);
        assert.equal(missing.status, 404);

        const editors = res();
        handlers.get('/changes/editors')(req({ method: 'GET' }), editors);
        const envelope = JSON.parse(editors.body);
        assert.equal(envelope.ok, true);
        assert.ok(envelope.value.some((editor) => editor.id === 'system' && editor.available === true));
    } finally {
        dispose();
        rmSync(workspace, { recursive: true, force: true });
    }
});

test('SSE route rejects non-loopback and opens a stream for loopback', async () => {
    const { workspace, handlers, dispose } = await mount();
    try {
        const sse = handlers.get('/changes/events');
        const lan = res();
        sse(req({ method: 'GET', remote: '172.16.0.9', query: `path=${encodeURIComponent(workspace)}` }), lan);
        assert.equal(lan.status, 403);

        const local = res();
        const request = req({ method: 'GET', query: `path=${encodeURIComponent(workspace)}` });
        sse(request, local);
        assert.equal(local.status, 200);
        assert.ok(local.writes[0].startsWith('retry:'));
        // Closing the request removes the subscriber without throwing.
        request._listeners.close?.();
    } finally {
        dispose();
        rmSync(workspace, { recursive: true, force: true });
    }
});
