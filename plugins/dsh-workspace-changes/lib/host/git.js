/**
 * Host git plumbing: the run-result shape, the runner seam over the
 * `subprocess` service, and the argv builders this plugin uses.
 *
 * Read-only by construction: only `status`, `diff`, `rev-parse` argv leave
 * this module. Windows spawns `git.exe` directly — a .cmd/.bat shim cannot be
 * spawned without a shell, and no shell is ever involved (several args carry
 * `%`-formats that a shell would corrupt).
 *
 * @module dsh-workspace-changes/host/git
 */

/** Collected-output cap for one git command (route-level diff caps apply on top). */
export const OUTPUT_CAP_BYTES = 4 << 20;

/** Per-command grace before the managed subprocess is terminated. */
const GRACE_MS = 10_000;

/** One finished git invocation. */
export class GitRun {
    constructor(exitCode, stdout, stderr) {
        this.exitCode = exitCode;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}

/**
 * The production runner over `ctx.subprocess`: one managed child per command,
 * bounded collect on both streams, caller-owned AbortSignal throughout.
 * Spawn/run failures degrade to exitCode 127 so the tab shows a friendly
 * "git unavailable" state instead of a bare transport error.
 * @param ctx - host context carrying the subprocess service.
 */
export function subprocessRunner(ctx) {
    const binary = process.platform === 'win32' ? 'git.exe' : 'git';
    return {
        async run(argv, cwd, signal) {
            signal?.throwIfAborted();
            let handle;
            try {
                handle = ctx.subprocess.spawn({
                    argv: [binary, ...argv],
                    cwd,
                    stdio: {
                        stdin: 'ignore',
                        stdout: { maxBytes: OUTPUT_CAP_BYTES },
                        stderr: { maxBytes: OUTPUT_CAP_BYTES }
                    },
                    graceMs: GRACE_MS,
                    signal
                });
            } catch (error) {
                signal?.throwIfAborted();
                return new GitRun(127, '', `git: spawn failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                const outcome = await handle.done;
                signal?.throwIfAborted();
                const stdout = handle.collected.stdout?.readFrom(0).text ?? '';
                const stderr = handle.collected.stderr?.readFrom(0).text ?? '';
                return new GitRun(outcome.exitCode, stdout, stderr);
            } catch (error) {
                signal?.throwIfAborted();
                return new GitRun(127, '', `git: run failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    };
}

/** `git status --porcelain=v2 --branch -z` (NUL-separated, no path quoting, rename records on). */
export function statusArgv() {
    return ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'];
}

/** Per-file added/deleted counts against HEAD, rename pairing off (post-image rows). */
export function numstatArgv() {
    return ['diff', '--numstat', '-z', '--no-renames', 'HEAD', '--'];
}

/** The whole working-tree-plus-index diff of one file against HEAD. */
export function fileDiffArgv(file) {
    return ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', file];
}

/** Scoped porcelain probe used to re-validate an untracked-file content read. */
export function untrackedProbeArgv(file) {
    return ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', file];
}

/** Repository root of a candidate directory (empty stdout + nonzero exit when not). */
export function topLevelArgv() {
    return ['rev-parse', '--show-toplevel'];
}
