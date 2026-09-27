/**
 * Diff model: parse `git diff HEAD -- <file>` unified output into structured
 * hunks the client renders directly, and synthesize an all-added diff for
 * untracked files (whose content git has no baseline for).
 *
 * The parse is deliberately lossless for the renderer: every hunk line keeps
 * its prefix kind and its text, hunk headers keep their section context, and
 * the `No newline at end of file` marker rides along as a `'\\'` line.
 *
 * @module dsh-workspace-changes/host/diff
 */

/** One parsed file diff. */
export class FileDiff {
    constructor(file) {
        this.file = file;
        this.oldFile = undefined;
        this.binary = false;
        this.truncated = false;
        this.untracked = false;
        this.hunks = [];
    }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/;

/**
 * Parse unified diff text (possibly several files) into FileDiff records.
 * @param text - raw stdout of one `git diff` invocation.
 * @param truncated - whether the transport cap cut the output short.
 * @returns FileDiff[].
 */
export function parseUnifiedDiff(text, truncated = false) {
    const files = [];
    if (typeof text !== 'string' || text.length === 0) return files;
    const lines = text.split('\n');
    let current = undefined;
    let hunk = undefined;

    const finishHunk = () => {
        if (current !== undefined && hunk !== undefined) current.hunks.push(hunk);
        hunk = undefined;
    };
    const finishFile = () => {
        finishHunk();
        if (current !== undefined) {
            current.truncated = truncated && files.length === 0;
            files.push(current);
        }
        current = undefined;
    };

    for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith('diff --git ')) {
            finishFile();
            // diff --git a/<old> b/<new> — prefixes may carry spaces in paths;
            // the halves are split at the LAST ' b/' which starts the new path.
            const body = line.slice('diff --git '.length);
            const pivot = body.lastIndexOf(' b/');
            const oldPath = pivot === -1 ? body : body.slice(0, pivot);
            const newPath = pivot === -1 ? body : body.slice(pivot + 3);
            current = new FileDiff(stripPrefix(newPath));
            current.oldFile = stripPrefix(oldPath);
            continue;
        }
        if (current === undefined) continue;
        if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
            current.binary = true;
            continue;
        }
        if (line.startsWith('rename from ')) {
            current.oldFile = line.slice('rename from '.length);
            continue;
        }
        if (line.startsWith('rename to ')) {
            current.file = line.slice('rename to '.length);
            continue;
        }
        if (line.startsWith('new file mode')) {
            current.oldFile = undefined;
            continue;
        }
        if (line.startsWith('deleted file mode')) {
            // oldFile stays: the viewer can name the removed baseline.
            continue;
        }
        if (line.startsWith('--- ')) {
            const name = line.slice(4);
            if (name !== '/dev/null') current.oldFile = stripPrefix(name);
            continue;
        }
        if (line.startsWith('+++ ')) {
            const name = line.slice(4);
            if (name !== '/dev/null') current.file = stripPrefix(name);
            continue;
        }
        const header = HUNK_HEADER.exec(line);
        if (header !== null) {
            finishHunk();
            hunk = {
                oldStart: Number(header[1]),
                oldLines: header[2] === undefined ? 1 : Number(header[2]),
                newStart: Number(header[3]),
                newLines: header[4] === undefined ? 1 : Number(header[4]),
                section: header[5] ?? '',
                collapsed: false,
                lines: []
            };
            continue;
        }
        if (hunk === undefined) continue;
        const mark = line[0];
        if (mark === ' ' || mark === '-' || mark === '+') {
            hunk.lines.push({ t: mark, text: line.slice(1) });
        } else if (mark === '\\') {
            hunk.lines.push({ t: '\\', text: line.slice(1).trim() });
        }
        // Anything else inside a hunk (shouldn't happen) is ignored, not fatal.
    }
    finishFile();
    if (truncated && files.length > 0) files[files.length - 1].truncated = true;
    return files;
}

/** Strip the `a/` `b/` prefix git puts on diff paths (quoted names already unquoted by -z nowhere; keep literal). */
function stripPrefix(path) {
    if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
    return path;
}

/** Rough binary sniff: a NUL in the first 8 KiB of the buffer. */
export function looksBinary(buffer) {
    const probe = buffer.subarray(0, 8192);
    return probe.includes(0);
}

/**
 * Build the all-added diff of an untracked file from its bytes.
 * @param path - repo-relative path.
 * @param buffer - file content (already capped by the caller).
 * @param capped - whether the cap cut the file short.
 */
export function syntheticUntrackedDiff(path, buffer, capped) {
    const diff = new FileDiff(path);
    diff.untracked = true;
    if (looksBinary(buffer)) {
        diff.binary = true;
        return diff;
    }
    let text = buffer.toString('utf8');
    diff.truncated = capped;
    const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    // A trailing newline is a terminator, not an extra empty line.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    diff.hunks.push({
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        section: '',
        collapsed: false,
        lines: lines.map((line) => ({ t: '+', text: line }))
    });
    return diff;
}

/** Serialize a FileDiff back to unified text, for the copy button. */
export function toUnifiedText(diff) {
    const out = [`diff --git a/${diff.oldFile ?? diff.file} b/${diff.file}`];
    if (diff.oldFile !== undefined && diff.oldFile !== diff.file) out.push(`rename from ${diff.oldFile}`, `rename to ${diff.file}`);
    if (diff.binary) {
        out.push(`Binary files differ`);
        return out.join('\n');
    }
    for (const hunk of diff.hunks) {
        out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.section === '' ? '' : ` ${hunk.section}`}`);
        for (const line of hunk.lines) {
            out.push(line.t === '\\' ? `\\ ${line.text}` : `${line.t}${line.text}`);
        }
    }
    return out.join('\n');
}
