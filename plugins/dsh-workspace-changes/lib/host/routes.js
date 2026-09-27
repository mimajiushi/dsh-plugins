/**
 * /changes/* route layer: JSON envelope for the queries and the IDE-open
 * action, plus an SSE stream that pushes change notices (fs/observed bursts,
 * debounced, and a slow poll digest for external edits).
 *
 * Trust fence, in order, on every route:
 *  1. loopback only — a non-loopback peer gets 403 whatever it asks;
 *  2. POST + application/json for the JSON verbs (415 otherwise) — cross-site
 *     forms cannot set that content-type without a CORS preflight;
 *  3. workspace gate — the requested path must realpath-equal a registered
 *     workspace root, so the browser can never point git at arbitrary host
 *     directories;
 *  4. untracked content reads are re-validated against a scoped porcelain
 *     probe, so /changes/diff cannot read files git does not report;
 *  5. /changes/open confines the file inside the workspace root before any
 *     spawn, and only ever launches an editor — never a repo mutation.
 *
 * @module dsh-workspace-changes/host/routes
 */

import { open, realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { topLevelArgv, fileDiffArgv, untrackedProbeArgv } from './git.js';
import { readStatus } from './status.js';
import { parseUnifiedDiff, syntheticUntrackedDiff } from './diff.js';
import { listEditors, buildOpenCommand, launch } from './editors.js';

/** JSON body cap: the verbs carry `{path, file, line}` and nothing larger. */
const BODY_CAP_BYTES = 64 * 1024;
/** Route deadline for one git read. */
const GIT_TIMEOUT_MS = 15_000;
/** Debounce of one fs/observed burst into one SSE notice. */
const OBSERVED_DEBOUNCE_MS = 300;
/** SSE keep-alive comment interval (proxies drop idle connections). */
const HEARTBEAT_INTERVAL_MS = 15_000;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' };

const OK = (value) => ({ ok: true, value });
const FAIL = (code, message) => ({ ok: false, error: { code, message } });

/** Loopback verdict on the socket peer. */
export function isLoopback(req) {
    const address = req.socket?.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Read one bounded JSON object body, or undefined on overflow/parse failure. */
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_CAP_BYTES) {
            req.destroy();
            return undefined;
        }
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '') return undefined;
    try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function writeJson(res, status, body, headers = {}) {
    res.writeHead(status, { ...JSON_HEADERS, ...headers });
    res.end(JSON.stringify(body));
}

/** Normalize separators (and case on win32) for path-prefix comparisons. */
function canonicalSlashes(path) {
    let value = path.replace(/[\\/]+/gu, sep);
    if (process.platform === 'win32') value = value.toLowerCase();
    return value.endsWith(sep) ? value : value + sep;
}

/** Whether `file` (already canonicalized) sits inside `root`. */
export function containedIn(root, file) {
    const r = canonicalSlashes(root);
    const f = canonicalSlashes(file);
    return f !== r && f.startsWith(r);
}

/**
 * The route registrar. Returned disposer drops routes, timers and subscribers.
 * @param ctx - host context (webServer, workspaceRegistry, logger; fs/observed events).
 * @param runner - the git runner.
 * @param config - effective-config thunk.
 */
export function registerChangesRoutes(ctx, runner, config) {
    const subscribers = new Set();
    let pollTimer;
    let heartbeatTimer;
    let observedFlush;
    const pendingObserved = new Set();

    /** Workspace gate: canonicalize, then require exact registry membership. */
    async function gate(path) {
        if (typeof path !== 'string' || path === '') return { ok: false, error: FAIL('bad-request', 'path is required') };
        let canonical;
        try {
            canonical = await realpath(path);
        } catch {
            return { ok: false, error: FAIL('workspace-unknown', 'path does not resolve on disk') };
        }
        const registered = ctx.workspaceRegistry.list().some((workspace) => {
            if (workspace.path === canonical) return true;
            // Windows realpath may differ from the registry only by casing.
            return process.platform === 'win32' && workspace.path.toLowerCase() === canonical.toLowerCase();
        });
        if (!registered) return { ok: false, error: FAIL('workspace-unknown', 'path is not a registered workspace') };
        return { ok: true, canonical };
    }

    /** Resolve the repo root of a gated workspace, or undefined when not a repo. */
    async function repoRoot(canonical, signal) {
        const probe = await runner.run(topLevelArgv(), canonical, signal);
        if (probe.exitCode !== 0) return undefined;
        const root = probe.stdout.trim();
        return root === '' ? undefined : root;
    }

    /** Run one git read under a fresh deadline controller. */
    async function withDeadline(work) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('git timed out')), GIT_TIMEOUT_MS);
        try {
            return await work(controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    /** In-flight status reads by requested path: a burst of callers shares one git round. */
    const statusFlights = new Map();

    async function statusView(path) {
        const existing = statusFlights.get(path);
        if (existing !== undefined) return existing;
        const flight = statusViewUncached(path);
        statusFlights.set(path, flight);
        const clear = () => {
            if (statusFlights.get(path) === flight) statusFlights.delete(path);
        };
        void flight.then(clear, clear);
        return flight;
    }

    async function statusViewUncached(path) {
        const gated = await gate(path);
        if (!gated.ok) return gated;
        return withDeadline(async (signal) => {
            const root = await repoRoot(gated.canonical, signal);
            if (root === undefined) return { ok: true, null: true };
            const result = await readStatus(runner, root, signal);
            if (!result.ok) return { ok: false, error: FAIL('git-failed', result.stderr || 'git status failed') };
            return { ok: true, value: result.value };
        });
    }

    async function diffView(path, file) {
        if (typeof file !== 'string' || file === '') return { ok: false, error: FAIL('bad-request', 'file is required') };
        const gated = await gate(path);
        if (!gated.ok) return gated;
        return withDeadline(async (signal) => {
            const root = await repoRoot(gated.canonical, signal);
            if (root === undefined) return { ok: false, error: FAIL('not-a-repo', 'workspace is not a git repository') };
            // Untracked first: re-validate against a scoped probe so this route
            // can never read a file git does not currently report as untracked.
            const probe = await runner.run(untrackedProbeArgv(file), root, signal);
            const untracked = probe.exitCode === 0 && probe.stdout.split('\0').some((field) => field === `?? ${file}`);
            if (untracked) {
                const absolute = await realpath(`${root}/${file}`);
                if (!containedIn(await realpath(root), absolute)) return { ok: false, error: FAIL('outside-workspace', 'file escapes the workspace') };
                const cap = config().maxUntrackedBytes;
                // Read at most `cap` bytes — never the whole file. A giant
                // untracked artifact (video/zip) must not land in host memory.
                let info;
                try {
                    info = await stat(absolute);
                } catch {
                    return { ok: false, error: FAIL('not-found', `no file at ${file}`) };
                }
                const length = Math.min(info.size, cap);
                const buffer = Buffer.alloc(length);
                const handle = await open(absolute, 'r');
                try {
                    await handle.read(buffer, 0, length, 0);
                } finally {
                    await handle.close();
                }
                const capped = info.size > cap;
                return { ok: true, value: syntheticUntrackedDiff(file, buffer, capped) };
            }
            const cap = config().maxDiffBytes;
            const run = await runner.run(fileDiffArgv(file), root, signal);
            if (run.exitCode !== 0 && run.stdout === '') {
                return { ok: false, error: FAIL('git-failed', run.stderr.trim() || 'git diff failed') };
            }
            const truncated = run.stdout.length > cap;
            const files = parseUnifiedDiff(run.stdout.slice(0, cap), truncated);
            const diff = files.find((entry) => entry.file === file) ?? files[0];
            if (diff === undefined) return { ok: true, value: { file, binary: false, truncated: false, untracked: false, hunks: [] } };
            diff.file = file; // the route's vocabulary, not the diff header's
            return { ok: true, value: diff };
        });
    }

    async function openView(path, file, line, editor) {
        if (typeof file !== 'string' || file === '') return { ok: false, error: FAIL('bad-request', 'file is required') };
        const gated = await gate(path);
        if (!gated.ok) return gated;
        let absolute;
        try {
            absolute = await realpath(`${gated.canonical}/${file}`);
        } catch {
            return { ok: false, error: FAIL('not-found', `no file at ${file}`) };
        }
        if (!containedIn(gated.canonical, absolute)) return { ok: false, error: FAIL('outside-workspace', 'file escapes the workspace') };
        const editorId = typeof editor === 'string' && editor !== '' ? editor : undefined;
        const spec = buildOpenCommand(editorId, config(), absolute, typeof line === 'number' && line > 0 ? Math.floor(line) : 1);
        if (spec.error !== undefined) return { ok: false, error: FAIL('editor-unavailable', spec.error) };
        const launched = launch(spec);
        return launched.ok ? { ok: true, value: { opened: true } } : { ok: false, error: FAIL('editor-unavailable', launched.error) };
    }

    // ── SSE ─────────────────────────────────────────────────────────────────

    const push = (subscriber, payload) => {
        try {
            subscriber.res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch {
            removeSubscriber(subscriber);
        }
    };

    const removeSubscriber = (subscriber) => {
        if (!subscribers.delete(subscriber)) return;
        clearTimeout(subscriber.debounce);
        try {
            subscriber.res.end();
        } catch {
            // socket already gone
        }
        if (subscribers.size === 0) {
            if (pollTimer !== undefined) clearInterval(pollTimer);
            if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
            pollTimer = undefined;
            heartbeatTimer = undefined;
        }
    };

    /** One poll round: recompute digests, push the changed ones. */
    const poll = async () => {
        await Promise.all([...subscribers].map(async (subscriber) => {
            try {
                const view = await statusView(subscriber.path);
                const digest = view.ok === true
                    ? JSON.stringify(view.null === true ? null : [view.value.branch, view.value.head, view.value.totals, view.value.groups.changes.length, view.value.groups.unversioned.length])
                    : 'error';
                if (digest === subscriber.last) return;
                subscriber.last = digest;
                push(subscriber, { kind: 'poll' });
            } catch (error) {
                ctx.logger?.warn?.(`dsh-workspace-changes: poll failed for ${subscriber.path}: ${String(error)}`);
            }
        }));
    };

    /** fs/observed burst → one debounced notice per affected subscriber. */
    const flushObserved = () => {
        observedFlush = undefined;
        const targets = [...pendingObserved];
        pendingObserved.clear();
        for (const subscriber of subscribers) {
            const root = subscriber.normalized;
            const hit = targets.some((target) => target === root || target.startsWith(`${root}/`));
            if (hit) push(subscriber, { kind: 'observed' });
        }
    };

    const disposeObserved = ctx.on?.('fs/observed', (target) => {
        if (subscribers.size === 0 || typeof target !== 'string') return;
        pendingObserved.add(target.replace(/\\/gu, '/'));
        if (observedFlush === undefined) observedFlush = setTimeout(flushObserved, OBSERVED_DEBOUNCE_MS);
    });

    const sse = (req, res) => {
        if (!isLoopback(req)) {
            writeJson(res, 403, FAIL('forbidden', 'loopback-only'));
            return;
        }
        const url = new URL(req.url ?? '/', 'http://x');
        const path = url.searchParams.get('path');
        if (path === null || path === '') {
            res.writeHead(400);
            res.end();
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        const subscriber = { path, normalized: path.replace(/\\/gu, '/'), last: '', res, debounce: undefined };
        subscribers.add(subscriber);
        res.on('error', () => removeSubscriber(subscriber));
        req.on('close', () => removeSubscriber(subscriber));
        if (heartbeatTimer === undefined) {
            heartbeatTimer = setInterval(() => {
                for (const current of subscribers) {
                    try {
                        current.res.write(': ping\n\n');
                    } catch {
                        removeSubscriber(current);
                    }
                }
            }, HEARTBEAT_INTERVAL_MS);
        }
        if (pollTimer === undefined) {
            const interval = Math.max(10_000, config().pollIntervalMs);
            pollTimer = setInterval(() => void poll(), interval);
        }
        // First push immediately so the client refreshes right after subscribing.
        void statusView(path).then((view) => {
            if (!subscribers.has(subscriber)) return;
            subscriber.last = view.ok === true ? JSON.stringify(view.null === true ? null : [view.value.branch, view.value.head, view.value.totals]) : 'error';
        }, () => {});
    };

    // ── JSON verbs ──────────────────────────────────────────────────────────

    const handler = async (req, res) => {
        if (!isLoopback(req)) {
            writeJson(res, 403, FAIL('forbidden', 'loopback-only'));
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
        }
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.toLowerCase().startsWith('application/json')) {
            res.writeHead(415);
            res.end();
            return;
        }
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        const payload = await readJson(req);
        if (payload === undefined) {
            writeJson(res, 200, FAIL('bad-request', 'malformed request'));
            return;
        }
        try {
            switch (pathname) {
                case '/changes/status': {
                    const view = await statusView(payload.path);
                    if (!view.ok) writeJson(res, 200, view.error);
                    else writeJson(res, 200, OK(view.null === true ? null : view.value));
                    return;
                }
                case '/changes/diff': {
                    const view = await diffView(payload.path, payload.file);
                    writeJson(res, 200, view.ok ? OK(view.value) : view.error);
                    return;
                }
                case '/changes/open': {
                    const view = await openView(payload.path, payload.file, payload.line, payload.editor);
                    writeJson(res, 200, view.ok ? OK(view.value) : view.error);
                    return;
                }
                default:
                    res.writeHead(404);
                    res.end();
            }
        } catch (error) {
            ctx.logger?.warn?.(`dsh-workspace-changes: ${pathname} failed: ${String(error)}`);
            writeJson(res, 200, FAIL('internal', error instanceof Error ? error.message : String(error)));
        }
    };

    const editorsHandler = (req, res) => {
        if (!isLoopback(req)) {
            writeJson(res, 403, FAIL('forbidden', 'loopback-only'));
            return;
        }
        writeJson(res, 200, OK(listEditors(config())));
    };

    const disposers = [
        ctx.webServer.register({ kind: 'prefix', path: '/changes', handler }),
        ctx.webServer.register({ kind: 'exact', path: '/changes/events', handler: sse }),
        ctx.webServer.register({ kind: 'exact', path: '/changes/editors', handler: editorsHandler })
    ];

    let disposed = false;
    return () => {
        if (disposed) return; // mount-once re-apply and fiber cleanup may both fire
        disposed = true;
        for (const dispose of disposers) dispose();
        disposeObserved?.();
        if (observedFlush !== undefined) clearTimeout(observedFlush);
        if (pollTimer !== undefined) clearInterval(pollTimer);
        if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
        for (const subscriber of [...subscribers]) removeSubscriber(subscriber);
    };
}
