/**
 * Status model: parse `git status --porcelain=v2 --branch -z` and
 * `git diff --numstat -z HEAD` into the grouped view the tab renders.
 *
 * Groups follow the JetBrains commit tool window the design mirrors:
 *  - `conflicts`   — unmerged records (`u` lines), surfaced first;
 *  - `changes`     — tracked working-tree + index changes against HEAD
 *                    (ordinary `1` and rename `2` records; staged and
 *                    unstaged deliberately merged into one row per path);
 *  - `unversioned` — untracked files (`?` lines; `!` ignored files are
 *                    never requested).
 *
 * @module dsh-workspace-changes/host/status
 */

import { statusArgv, numstatArgv } from './git.js';

/** Entry kinds the client colors by. */
export const KIND = Object.freeze({
    MODIFIED: 'modified',
    ADDED: 'added',
    DELETED: 'deleted',
    RENAMED: 'renamed',
    TYPECHANGED: 'typechanged',
    CONFLICT: 'conflict',
    UNTRACKED: 'untracked'
});

/** XY letter → entry kind. Unmerged letters never reach this map. */
const LETTER_KIND = Object.freeze({
    M: KIND.MODIFIED,
    A: KIND.ADDED,
    D: KIND.DELETED,
    T: KIND.TYPECHANGED,
    R: KIND.RENAMED,
    C: KIND.ADDED
});

/** The harsher of the index/worktree letters wins the row's kind. */
function kindOf(xy) {
    const [x, y] = xy;
    if (x !== '.' && x !== undefined) return LETTER_KIND[x] ?? KIND.MODIFIED;
    if (y !== '.' && y !== undefined) return LETTER_KIND[y] ?? KIND.MODIFIED;
    return KIND.MODIFIED;
}

/**
 * Parse the NUL-separated porcelain v2 stream.
 * @param text - raw stdout of `git status --porcelain=v2 --branch -z`.
 * @returns `{ branch, oid, upstream, ahead, behind, entries }`; `branch` is ''
 *   when HEAD is detached (oid carries the commit).
 */
export function parsePorcelainV2(text) {
    const view = { branch: '', oid: '', upstream: '', ahead: 0, behind: 0, entries: [] };
    if (typeof text !== 'string' || text.length === 0) return view;
    const fields = text.split('\0');
    for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (field === '') continue;
        const head = field[0];
        if (head === '#') {
            const body = field.slice(2);
            if (body.startsWith('branch.head ')) view.branch = body.slice('branch.head '.length);
            else if (body.startsWith('branch.oid ')) view.oid = body.slice('branch.oid '.length);
            else if (body.startsWith('branch.upstream ')) view.upstream = body.slice('branch.upstream '.length);
            else if (body.startsWith('branch.ab ')) {
                const match = /^\+(\d+) -(\d+)$/.exec(body.slice('branch.ab '.length));
                if (match !== null) {
                    view.ahead = Number(match[1]);
                    view.behind = Number(match[2]);
                }
            }
            continue;
        }
        if (head === '?') {
            const path = field.slice(2);
            if (path !== '') view.entries.push({ kind: KIND.UNTRACKED, path });
            continue;
        }
        if (head === '!') continue; // ignored files are not requested; ignore defensively
        if (head === 'u') {
            // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            const parts = field.split(' ');
            const path = parts.slice(10).join(' ');
            if (path !== '') view.entries.push({ kind: KIND.CONFLICT, path });
            continue;
        }
        if (head === '1' || head === '2') {
            // 1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            // 2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
            const parts = field.split(' ');
            const xy = parts[1] ?? '..';
            if (head === '2') {
                const path = parts.slice(9).join(' ');
                const origPath = fields[index + 1] ?? '';
                index += 1; // the origPath field is consumed with the record
                if (path !== '') view.entries.push({ kind: KIND.RENAMED, path, oldPath: origPath, xy });
            } else {
                const path = parts.slice(8).join(' ');
                if (path === '') continue;
                if (xy === '..') continue; // unmodified rows never appear, but stay defensive
                view.entries.push({ kind: kindOf(xy), path, xy });
            }
        }
    }
    return view;
}

/**
 * Parse `git diff --numstat -z --no-renames HEAD` output.
 * Binary rows carry `-` counts and are kept as zeroes with `binary: true`.
 * @param text - raw stdout.
 * @returns Map from path to `{ added, deleted, binary }`.
 */
export function parseNumstat(text) {
    const counts = new Map();
    if (typeof text !== 'string' || text.length === 0) return counts;
    for (const field of text.split('\0')) {
        if (field === '') continue;
        const match = /^(\S+)\t(\S+)\t([\s\S]*)$/.exec(field);
        if (match === null) continue;
        const binary = match[1] === '-' || match[2] === '-';
        const path = match[3];
        if (path === '') continue;
        counts.set(path, {
            added: binary ? 0 : Number(match[1]) || 0,
            deleted: binary ? 0 : Number(match[2]) || 0,
            binary
        });
    }
    return counts;
}

/**
 * Hard cap per group: a repository carrying node_modules-scale untracked trees
 * must never hand the renderer a six-figure row list (2026-09-25: a renderer
 * OOM grey screen came from an unbounded client tree — the cap is the
 * host-side backstop so no data shape can repeat it). Totals are always
 * computed from the COMPLETE parse, before trimming.
 */
export const GROUP_ENTRY_CAP = 5000;

/** The display groups of one parsed status, counts merged in, stably sorted. */
export function buildGroups(status, counts, cap = GROUP_ENTRY_CAP) {
    const conflicts = [];
    const changes = [];
    const unversioned = [];
    for (const entry of status.entries) {
        if (entry.kind === KIND.CONFLICT) {
            conflicts.push({ path: entry.path, kind: entry.kind });
            continue;
        }
        if (entry.kind === KIND.UNTRACKED) {
            unversioned.push({ path: entry.path, kind: entry.kind });
            continue;
        }
        const stat = counts.get(entry.path);
        changes.push({
            path: entry.path,
            kind: entry.kind,
            ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
            added: stat?.added ?? 0,
            deleted: stat?.deleted ?? 0,
            ...(stat?.binary === true ? { binary: true } : {})
        });
    }
    const byPath = (left, right) => left.path.localeCompare(right.path);
    conflicts.sort(byPath);
    changes.sort(byPath);
    unversioned.sort(byPath);
    const trim = (entries) => {
        if (entries.length <= cap) return { entries, hidden: 0 };
        return { entries: entries.slice(0, cap), hidden: entries.length - cap };
    };
    const c = trim(conflicts);
    const g = trim(changes);
    const u = trim(unversioned);
    return {
        conflicts: c.entries,
        changes: g.entries,
        unversioned: u.entries,
        hidden: { conflicts: c.hidden, changes: g.hidden, unversioned: u.hidden }
    };
}

/** Totals for the header chip — computed from the COMPLETE parse, not the trimmed groups. */
export function totalsOf(groups, counts, totalEntries) {
    let added = 0;
    let deleted = 0;
    if (counts instanceof Map) {
        for (const stat of counts.values()) {
            added += stat.added;
            deleted += stat.deleted;
        }
    } else {
        for (const entry of groups.changes) {
            added += entry.added;
            deleted += entry.deleted;
        }
    }
    const shown = groups.conflicts.length + groups.changes.length + groups.unversioned.length;
    const hidden = groups.hidden === undefined ? 0 : groups.hidden.conflicts + groups.hidden.changes + groups.hidden.unversioned;
    return {
        files: typeof totalEntries === 'number' ? totalEntries : shown + hidden,
        added,
        deleted
    };
}

/**
 * Combine the two git reads into the status payload the route serves.
 * @param runner - the git runner.
 * @param root - repository root (already gated).
 * @param signal - caller deadline.
 */
export async function readStatus(runner, root, signal) {
    const [statusRun, numstatRun] = await Promise.all([
        runner.run(statusArgv(), root, signal),
        runner.run(numstatArgv(), root, signal)
    ]);
    if (statusRun.exitCode !== 0) {
        return { ok: false, stderr: statusRun.stderr.trim() };
    }
    const status = parsePorcelainV2(statusRun.stdout);
    const counts = numstatRun.exitCode === 0 ? parseNumstat(numstatRun.stdout) : new Map();
    const groups = buildGroups(status, counts);
    return {
        ok: true,
        value: {
            root,
            branch: status.branch,
            head: status.oid.slice(0, 7),
            detached: status.branch === '',
            upstream: status.upstream,
            ahead: status.ahead,
            behind: status.behind,
            groups,
            totals: totalsOf(groups, counts, status.entries.length)
        }
    };
}
