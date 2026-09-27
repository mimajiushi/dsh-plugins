#!/usr/bin/env node
/**
 * Local patch: give `@nanmicoder/dsh-agent-teams` a **live limits bridge** and a
 * **per-team concurrency cap**.
 *
 * Why a patch at all (2026-09-27): `maxMembers` is a plain composition-config
 * default (`z.natural().min(1).default(8)`), so a settings page can only change
 * it if the value reaches the plugin's resolved config — that part needs no
 * source change (the `dsh-agent-teams-limits` plugin injects it through the
 * global `internal/config` waterfall, the same seam `dsh-compact-model` uses).
 * **Concurrency has no knob at all**: `scheduler.js` hands every ready task to
 * every idle member, so a hard cap needs five small edits.
 *
 * Patch points
 * ------------
 * 1. `lib/index.js` — config field `maxConcurrentMembers` (default `0` = no cap),
 *    the `resolved` passthrough, and the module-level `__limits` bridge
 *    (`apply`/`read`) published on `globalThis[Symbol.for('dsh.agent-teams.limits')]`.
 *    Both limits are read at USE time (`config.maxMembers` in tools.js,
 *    `config.maxConcurrentMembers` through the live view below), so a bridge
 *    `apply` mutates each mounted instance's `resolved` object and takes effect
 *    immediately.
 * 2. `lib/tools.js` — the scheduler's config: `installTeamScheduler` used to get
 *    a **copied literal** (`{ stateDir, executionPrompt, dispatch }`), which is
 *    NOT the `resolved` object the bridge rewrites and carries no
 *    `maxConcurrentMembers` at all. A copied literal froze the cap at `0`, so the
 *    whole gate below never fired in production (found by the 2026-09-27
 *    independent review; the first version of this patch only touched
 *    `resolved`). The row now passes a **live getter** over `resolved` instead.
 * 3. `lib/scheduler.js` — `memberCap` / `occupantHoldsSlot` / `activeMemberCount`,
 *    the cap check in the fresh-claim branch of `kickMember` (recovery of an
 *    already-open attempt is never gated: that would strand work), and the idle
 *    edge kicks the whole team so freed capacity is refilled.
 * 4. `lib/tools.js` — `dispatchMember` returns `false` for a `steer` wake-up at
 *    cap. That is upstream's own "not now" contract: the message stays in the
 *    durable mailbox and is re-delivered on a later kick (never lost, possibly
 *    delayed for a whole member turn).
 * 5. `lib/types/index.d.ts` — the declared config gains the new field.
 *
 * "Occupying a slot" is deliberately NOT the bare `status === 'working'` flag: a
 * `working` member whose live handle is gone or explicitly `idle` is stale state
 * (a missed idle edge, a restart), and counting it would pin small caps shut
 * forever. The rule reuses upstream's own availability model — an absent handle
 * means "the scheduler may dispatch to it", so it does not hold a slot — while a
 * member that was marked working but has not been spawned yet (`id === ''`) does.
 *
 * Usage (default is a dry run):
 *   node scripts/patch-agent-teams-limits.mjs             # show what would change
 *   node scripts/patch-agent-teams-limits.mjs --apply     # patch + back up
 *   node scripts/patch-agent-teams-limits.mjs --revert    # restore the backups
 *   node scripts/verify-agent-teams-limits.mjs            # the gate that proves it
 *
 * The anchors are pinned to **0.1.20** (the version the community profile runs).
 * The official desktop's copy is 0.1.21 and is deliberately NOT patched: its
 * files differ, so every anchor reports a non-unique count and the script refuses
 * to touch it. ⚠️ A plugin update overwrites these files (backups stay), so
 * re-run `--apply` + the verifier after updating @nanmicoder/dsh-agent-teams.
 * ⚠️ Upgrading from the first generation of this patch needs `--revert` first
 * (its rewritten anchors no longer match the pristine originals).
 *
 * @module scripts/patch-agent-teams-limits
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const revert = argv.includes('--revert');

/** The community profile's installed copy of the plugin (the one DSH Desktop loads). */
const PACKAGE_DIR = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@nanmicoder', 'dsh-agent-teams');
const INDEX_JS = join(PACKAGE_DIR, 'lib', 'index.js');
const SCHEDULER_JS = join(PACKAGE_DIR, 'lib', 'scheduler.js');
const TOOLS_JS = join(PACKAGE_DIR, 'lib', 'tools.js');
const TYPES_D_TS = join(PACKAGE_DIR, 'lib', 'types', 'index.d.ts');

/** Backup suffix; the pristine original is kept here across re-applies. */
const BACKUP_SUFFIX = '.bak-agent-teams-limits';
const backupOf = (file) => `${file}${BACKUP_SUFFIX}`;

/**
 * Replace one literal exactly once.
 * @param source - file text.
 * @param before - literal to replace.
 * @param after - replacement.
 * @returns `{ text }` on success, `{ error }` when the anchor is not unique.
 */
function replaceOnce(source, before, after) {
    const count = source.split(before).length - 1;
    if (count !== 1) return { error: `期望 1 处锚点，实际 ${count} 处 —— 上游可能已改版，需人工核对` };
    return { text: source.replace(before, after) };
}

/**
 * Chain several `replaceOnce` steps, failing on the first bad anchor.
 * @param source - file text.
 * @param pairs - `{ before, after }` literals, applied in order.
 * @returns `{ text }` or `{ error }`.
 */
function rewriteChain(source, pairs) {
    let text = source;
    for (const pair of pairs) {
        const next = replaceOnce(text, pair.before, pair.after);
        if (next.error !== undefined) return { error: `${firstLine(pair.before)}: ${next.error}` };
        text = next.text;
    }
    return { text };
}

/**
 * First line of an anchor, for a readable error message.
 * @param literal - an anchor.
 * @returns the first line, trimmed to 60 characters.
 */
function firstLine(literal) {
    const line = literal.split('\n')[0].trim();
    return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** `lib/index.js`: the new config field (0 = unlimited, the stock behaviour). */
const SCHEMA_FIELD = '    maxMembers: z.natural().min(1).default(8),\n';
const SCHEMA_FIELD_AFTER = `${SCHEMA_FIELD}    maxConcurrentMembers: z.natural().default(0),\n`;

/** `lib/index.js`: the resolved-config passthrough. */
const RESOLVED_FIELD = '        maxMembers: config.maxMembers ?? 8,\n';
const RESOLVED_FIELD_AFTER = `${RESOLVED_FIELD}        maxConcurrentMembers: config.maxConcurrentMembers ?? 0,\n`;

/** `lib/index.js`: the live bridge, inserted right before `apply`. */
const APPLY_SIGNATURE = 'export function apply(ctx, config) {';
const BRIDGE = `/**
 * Live limits bridge (local patch: agent-teams-limits).
 *
 * The two limits are read at USE time — \`config.maxMembers\` in the tool bodies,
 * \`config.maxConcurrentMembers\` through the scheduler's live view — so mutating a
 * mounted instance's resolved config is enough to apply a settings change
 * immediately, with no restart and no fiber reload. \`dsh-agent-teams-limits\`
 * calls {@link __limits.apply} on every settings edit and reads its own work back
 * with {@link __limits.read}; the same object is published on a process-stable
 * symbol so the plugin can find it even without a fiber handle.
 */
const mountedLimits = new Set();
/** Process-stable symbol carrying {@link __limits} to the limits plugin. */
const LIMITS_SYMBOL = Symbol.for('dsh.agent-teams.limits');
export const __limits = {
    /**
     * Apply live limit overrides to every mounted instance.
     * @param next - \`{ maxMembers?, maxConcurrentMembers? }\`; non-integers are ignored.
     * @returns how many mounted instances were updated.
     */
    apply(next) {
        let updated = 0;
        for (const resolved of mountedLimits) {
            if (Number.isInteger(next?.maxMembers))
                resolved.maxMembers = next.maxMembers;
            if (Number.isInteger(next?.maxConcurrentMembers))
                resolved.maxConcurrentMembers = next.maxConcurrentMembers;
            updated += 1;
        }
        return updated;
    },
    /**
     * Read the live limits of every mounted instance.
     * @returns \`{ maxMembers, maxConcurrentMembers }\` per instance.
     */
    read() {
        return [...mountedLimits].map(resolved => ({
            maxMembers: resolved.maxMembers,
            maxConcurrentMembers: resolved.maxConcurrentMembers,
        }));
    },
};
${APPLY_SIGNATURE}`;

/** `lib/index.js`: publish this instance to the bridge from inside `apply`. */
const RESOLVED_TAIL = '        profiles: config.profiles ?? {},\n    };\n';
const RESOLVED_TAIL_AFTER = `${RESOLVED_TAIL}    // PATCH (agent-teams-limits): publish this instance's live limits, and the
    // bridge itself, so a settings edit takes effect without a restart.
    mountedLimits.add(resolved);
    globalThis[LIMITS_SYMBOL] = __limits;
    ctx.effect(() => () => {
        mountedLimits.delete(resolved);
        if (mountedLimits.size === 0 && globalThis[LIMITS_SYMBOL] === __limits)
            delete globalThis[LIMITS_SYMBOL];
    }, 'agent-teams: limits bridge');
`;

/** `lib/scheduler.js`: the helpers, inserted before `assignmentPrompt`. */
const ASSIGNMENT_PROMPT = 'export function assignmentPrompt(ticket, stateDir, teamId) {';
const HELPERS = `/**
 * Per-team member concurrency cap (local patch: agent-teams-limits).
 * @param config - the scheduler's resolved plugin config (a live view, see
 *   \`installTeamScheduler\`'s call site in tools.js).
 * @returns the cap, or \`0\` for "no cap" (absent, non-numeric, or < 1).
 */
export function memberCap(config) {
    const value = config?.maxConcurrentMembers;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1)
        return 0;
    return Math.floor(value);
}
/**
 * Whether one \`working\` member really occupies a concurrency slot.
 *
 * A bare \`status === 'working'\` is NOT enough: state left behind by a missed idle
 * edge or by a restart would hold a slot forever and pin small caps shut. The
 * rule therefore follows upstream's own availability model — an absent AgentHandle
 * means "the scheduler may dispatch to it", so it does not hold a slot — while a
 * member marked working whose child is not spawned yet (\`id === ''\`) does.
 * @param ctx - the plugin context (injects \`agents\`).
 * @param member - one team member record.
 * @returns true when the member should count against the cap.
 */
export function occupantHoldsSlot(ctx, member) {
    if (member.stopping === true)
        return false;
    if (member.id === '')
        return member.status === 'working';
    const live = liveMember(ctx, member);
    if (live === undefined)
        return false;
    return live.status !== 'idle';
}
/**
 * Whether a member's durable task claim still occupies a concurrency slot.
 *
 * Claiming happens BEFORE the child turn starts, and delivery only QUEUES that
 * turn (\`deliverToMember\` → FIFO \`followup\`, which returns a MessageId), so the
 * freshly claimed member's AgentHandle still reads \`idle\` while \`kickTeam\`
 * evaluates the next member. Without this second, handle-independent signal the
 * whole initial fan-out would be admitted at once — the cap would silently not
 * exist exactly where it matters most.
 * @param tasks - fresh team task list.
 * @param memberName - the member's name.
 * @returns the member's open (\`claimed\`/\`in_progress\`) task, or undefined.
 */
function openClaimOf(tasks, memberName) {
    return tasks.find(task => task.assignee === memberName
        && (task.status === 'claimed' || task.status === 'in_progress'));
}
/**
 * Whether a member holds an open claim at all.
 * @param tasks - fresh team task list.
 * @param memberName - the member's name.
 * @returns true when the member owns a \`claimed\`/\`in_progress\` task.
 */
export function holdsClaim(tasks, memberName) {
    return openClaimOf(tasks, memberName) !== undefined;
}
/**
 * Whether a member's claim was parked by an IDLE EDGE, i.e. its turn already ended.
 *
 * The scheduler parks in two very different situations, and only one of them means
 * "not running":
 *   * the idle edge (\`syncMemberStatus\`) parks the open attempt AND flips the member
 *     to \`idle\` in the same step — that turn is over, it must not hold a slot;
 *   * the recovery branch of \`kickMember\` parks the NEW generation right after
 *     \`beginTaskAttempt\`, while the member is still \`working\` and the delivery is
 *     about to hand it a turn — that one runs, so it DOES hold a slot (treating it as
 *     parked let one extra member through per recovery).
 * The durable status is what tells them apart, because the idle edge writes it.
 * @param member - one team member record.
 * @param tasks - fresh team task list.
 * @param parkedAttempts - the scheduler's member-id → parked attempt id map.
 * @returns true when this claim is an ended turn, not a live slot.
 */
export function idleEdgePark(member, tasks, parkedAttempts) {
    const owned = openClaimOf(tasks, member.name);
    if (owned === undefined || owned.attemptId === undefined)
        return false;
    if (parkedAttempts?.get(member.id) !== owned.attemptId)
        return false;
    return member.status !== 'working';
}
/**
 * Whether one member occupies a concurrency slot right now.
 *
 * "Running" is not just the AgentHandle: a claim that was handed a turn but whose
 * child has not started yet (fan-out, recovery) occupies too. A claim with no
 * \`attemptId\` counts (conservative). The only excluded claim is the ended turn
 * described by {@link idleEdgePark}.
 * @param ctx - the plugin context (injects \`agents\`).
 * @param tasks - fresh team task list.
 * @param member - one team member record.
 * @param parkedAttempts - the scheduler's park ledger; omit it where none exists
 *   (the wake-up gate in tools.js), which makes an idle-edge-parked member count
 *   — conservative for that path, never a lost message.
 * @returns true when the member should count against the cap.
 */
export function memberOccupiesSlot(ctx, tasks, member, parkedAttempts) {
    if (member.stopping === true)
        return false;
    if (occupantHoldsSlot(ctx, member))
        return true;
    if (!holdsClaim(tasks, member.name))
        return false;
    return !idleEdgePark(member, tasks, parkedAttempts);
}
/**
 * Members currently occupying a concurrency slot.
 * @param team - fresh team state.
 * @param excludeName - the asking member's name (it is either still idle or
 *   resuming an attempt it already owns, so it never counts itself).
 * @param holdsSlot - predicate for one member. Without it only members marked
 *   \`working\` count.
 * @returns the number of other members holding a slot.
 */
export function activeMemberCount(team, excludeName, holdsSlot) {
    let count = 0;
    for (const member of team.members) {
        if (member.status === 'removed' || member.stopping === true || member.name === excludeName)
            continue;
        const holds = typeof holdsSlot === 'function'
            ? holdsSlot(member) === true
            : member.status === 'working';
        if (!holds)
            continue;
        count += 1;
    }
    return count;
}
${ASSIGNMENT_PROMPT}`;

/** `lib/scheduler.js`: gate the fresh claim only (never a recovery). */
const CLAIM_BEFORE = `                    const task = recoverOwned ? owned : owned === undefined
                        ? nextReadyTask(fresh.tasks, currentMember.name)
                        : undefined;`;
const CLAIM_AFTER = `                    // PATCH (agent-teams-limits): a fresh claim consumes one slot;
                    // recovering an attempt that already holds one is never gated. The
                    // occupancy test needs BOTH signals — the live handle (a running turn)
                    // and the open claim (a member whose queued turn has not started yet,
                    // which includes a just-recovered generation) — see memberOccupiesSlot.
                    const cap = memberCap(config);
                    const task = recoverOwned ? owned : owned === undefined
                        ? (cap === 0 || activeMemberCount(fresh, currentMember.name, (member) => memberOccupiesSlot(ctx, fresh.tasks, member, parkedAttempts)) < cap
                            ? nextReadyTask(fresh.tasks, currentMember.name)
                            : undefined)
                        : undefined;`;

/** `lib/scheduler.js`: the idle edge refills freed capacity for the whole team. */
const IDLE_KICK_BEFORE = `        if (status === 'idle')
            await runtime.kickMember(workspace, located.id, member.name);`;
const IDLE_KICK_AFTER = `        // PATCH (agent-teams-limits): one slot just freed, so let the team refill it
        // (kickTeam includes this member and wakes whoever was waiting on capacity).
        if (status === 'idle')
            await runtime.kickTeam(workspace, located.id, agent);`;

/** `lib/scheduler.js`: a refused mailbox wake-up must not swallow the whole pass. */
const MAILBOX_BEFORE = `                    if (accepted) {
                        await withTeamLock(teamLockKey(stateRoot, team.id), () => (markMailboxDelivered(stateRoot, team.id, member.name, unread.map(message => message.id))));
                    }
                    else {
                        await withTeamLock(teamLockKey(stateRoot, team.id), () => (releaseMailboxDelivery(stateRoot, team.id, member.name, unread.map(message => message.id))));
                    }
                    return;`;
const MAILBOX_AFTER = `                    if (accepted) {
                        await withTeamLock(teamLockKey(stateRoot, team.id), () => (markMailboxDelivered(stateRoot, team.id, member.name, unread.map(message => message.id))));
                        return;
                    }
                    // PATCH (agent-teams-limits): a wake-up refused by the concurrency cap
                    // is upstream's "not now" (the message is released back to the durable
                    // mailbox and re-delivered on a later kick). Do NOT return here: falling
                    // through to the claim branch keeps this member's own open attempt
                    // recoverable, while that branch's own cap check still refuses fresh work
                    // at capacity (so the cap cannot be exceeded by falling through).
                    await withTeamLock(teamLockKey(stateRoot, team.id), () => (releaseMailboxDelivery(stateRoot, team.id, member.name, unread.map(message => message.id))));`;

/** `lib/tools.js`: import the helpers next to `installTeamScheduler`. */
const TOOLS_IMPORT = 'import { collectCompletedDependencyOutputs, formatDependencyOutputs, installTeamScheduler } from "./scheduler.js";';
const TOOLS_IMPORT_AFTER = 'import { activeMemberCount, collectCompletedDependencyOutputs, formatDependencyOutputs, installTeamScheduler, memberCap, memberOccupiesSlot } from "./scheduler.js";';

/** `lib/tools.js`: the scheduler must read the LIVE resolved config, not a copy. */
const SCHEDULER_CALL = '    const scheduler = installTeamScheduler(ctx, { stateDir: config.stateDir, executionPrompt: config.executionPrompt, dispatch: dispatchMember });';
const SCHEDULER_CALL_AFTER = `    // PATCH (agent-teams-limits): the scheduler reads \`maxConcurrentMembers\` at
    // every claim, so it needs a LIVE view of the resolved config. A copied literal
    // (the stock shape) carries no such field and never sees a bridge update, which
    // silently disabled the whole concurrency cap.
    const scheduler = installTeamScheduler(ctx, {
        stateDir: config.stateDir,
        executionPrompt: config.executionPrompt,
        dispatch: dispatchMember,
        get maxConcurrentMembers() {
            return config.maxConcurrentMembers;
        },
    });`;

/** `lib/tools.js`: a steer wake-up at cap stays in the durable mailbox. */
const DISPATCH_GUARD = `                if (member === undefined || member.stopping === true || team.tasks.some(task => task.reassigning === true && task.assignee === memberName))
                    return false;`;
const DISPATCH_GUARD_AFTER = `${DISPATCH_GUARD}
                // PATCH (agent-teams-limits): waking an idle member is new capacity.
                // Returning false is upstream's "not now": the caller keeps the message
                // in the mailbox (delivered: 'mailbox') and a later kick re-delivers it
                // once a slot frees (it can therefore wait a whole member turn). The
                // occupancy test needs the open claim too — a just-woken member's turn is
                // only queued at this point, so its handle still reads idle.
                const cap = memberCap(config);
                if (mode === 'steer' && cap > 0 && member.status !== 'working'
                    && activeMemberCount(team, member.name, (candidate) => memberOccupiesSlot(ctx, team.tasks, candidate, undefined)) >= cap)
                    return false;`;

/** `lib/types/index.d.ts`: keep the declared config in sync. */
const TYPES_FIELD = '    /** Team size cap in members (default `8`). */\n    maxMembers?: number;\n';
const TYPES_FIELD_AFTER = `${TYPES_FIELD}    /**
     * Members of ONE team allowed to work at the same time (default \`0\` = no cap).
     * Enforced by the scheduler at fresh task claims and at member wake-ups.
     */
    maxConcurrentMembers?: number;\n`;

/** The edits, each independently detectable and applicable. */
const EDITS = [
    {
        id: 'config-field',
        title: 'lib/index.js: maxConcurrentMembers 字段 + resolved 透传',
        file: INDEX_JS,
        applied: (source) => source.includes(SCHEMA_FIELD_AFTER) && source.includes(RESOLVED_FIELD_AFTER),
        rewrite: (source) => rewriteChain(source, [
            { before: SCHEMA_FIELD, after: SCHEMA_FIELD_AFTER },
            { before: RESOLVED_FIELD, after: RESOLVED_FIELD_AFTER }
        ])
    },
    {
        id: 'limits-bridge',
        title: 'lib/index.js: __limits 活体桥 + globalThis 发布',
        file: INDEX_JS,
        applied: (source) => source.includes('export const __limits = {') && source.includes('mountedLimits.add(resolved);'),
        rewrite: (source) => rewriteChain(source, [
            { before: APPLY_SIGNATURE, after: BRIDGE },
            { before: RESOLVED_TAIL, after: RESOLVED_TAIL_AFTER }
        ])
    },
    {
        id: 'scheduler-cap',
        title: 'lib/scheduler.js: 单团队并发闸 + 空闲补位 + 占位判定 + 邮箱被闸不吞回合',
        file: SCHEDULER_JS,
        applied: (source) => source.includes('export function memberCap(config) {')
            && source.includes('export function occupantHoldsSlot(ctx, member) {')
            && source.includes('export function memberOccupiesSlot(ctx, tasks, member, parkedAttempts) {')
            && source.includes('await runtime.kickTeam(workspace, located.id, agent);')
            && source.includes('so the cap cannot be exceeded by falling through'),
        rewrite: (source) => rewriteChain(source, [
            { before: ASSIGNMENT_PROMPT, after: HELPERS },
            { before: CLAIM_BEFORE, after: CLAIM_AFTER },
            { before: IDLE_KICK_BEFORE, after: IDLE_KICK_AFTER },
            { before: MAILBOX_BEFORE, after: MAILBOX_AFTER }
        ])
    },
    {
        id: 'scheduler-live-config',
        title: 'lib/tools.js: 把 real resolved 的活体视图交给 scheduler（否则并发闸恒为 0）',
        file: TOOLS_JS,
        applied: (source) => source.includes(SCHEDULER_CALL_AFTER),
        rewrite: (source) => rewriteChain(source, [{ before: SCHEDULER_CALL, after: SCHEDULER_CALL_AFTER }])
    },
    {
        id: 'tools-steer-gate',
        title: 'lib/tools.js: 唤醒路径纳入上限（消息留在邮箱）',
        file: TOOLS_JS,
        applied: (source) => source.includes(TOOLS_IMPORT_AFTER)
            && source.includes("if (mode === 'steer' && cap > 0 && member.status !== 'working'"),
        rewrite: (source) => rewriteChain(source, [
            { before: TOOLS_IMPORT, after: TOOLS_IMPORT_AFTER },
            { before: DISPATCH_GUARD, after: DISPATCH_GUARD_AFTER }
        ])
    },
    {
        id: 'types-field',
        title: 'lib/types/index.d.ts: 声明同步',
        file: TYPES_D_TS,
        applied: (source) => source.includes(TYPES_FIELD_AFTER),
        rewrite: (source) => rewriteChain(source, [{ before: TYPES_FIELD, after: TYPES_FIELD_AFTER }])
    }
];

/**
 * Parse one JS file with this Node's own parser before it is written, so a bad
 * rewrite can never brick the next boot.
 * @param file - target path (its extension picks the module kind).
 * @param text - candidate content.
 * @returns undefined when it parses, else the checker's message.
 */
function syntaxError(file, text) {
    if (!file.endsWith('.js')) return undefined;
    const probe = `${file}.limitscheck.js`;
    writeFileSync(probe, text, 'utf8');
    try {
        const result = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
        if (result.status === 0) return undefined;
        return (result.stderr || result.stdout || 'node --check failed').trim().split('\n').slice(0, 4).join(' ');
    } finally {
        try { unlinkSync(probe); } catch { /* the probe is best-effort */ }
    }
}

/** Same-directory-agnostic label for logs. */
const labelOf = (file) => file.slice(PACKAGE_DIR.length + 1).replaceAll('\\', '/');

let failures = 0;

for (const edit of EDITS) {
    const file = edit.file;
    const label = labelOf(file);

    if (revert) {
        const backup = backupOf(file);
        if (!existsSync(backup)) {
            console.log(`! [${edit.id}] ${label}: 没有备份，跳过`);
            failures += 1;
            continue;
        }
        writeFileSync(file, readFileSync(backup, 'utf8'), 'utf8');
        console.log(`✔ [${edit.id}] ${label}: 已还原自 …${BACKUP_SUFFIX}`);
        continue;
    }

    if (!existsSync(file)) {
        console.log(`! [${edit.id}] ${label}: 文件不存在（装了这个插件吗？）`);
        failures += 1;
        continue;
    }
    const source = readFileSync(file, 'utf8');
    if (edit.applied(source)) {
        console.log(`· [${edit.id}] ${label}: 已是修补后的版本`);
        continue;
    }
    const patched = edit.rewrite(source);
    if (patched.error !== undefined) {
        console.log(`! [${edit.id}] ${label}: ${patched.error}`);
        failures += 1;
        continue;
    }
    if (patched.text === source) {
        console.log(`! [${edit.id}] ${label}: 替换后内容未变化`);
        failures += 1;
        continue;
    }
    const broken = syntaxError(file, patched.text);
    if (broken !== undefined) {
        console.log(`! [${edit.id}] ${label}: 改写后语法不通过 —— ${broken}`);
        failures += 1;
        continue;
    }
    if (!apply) {
        console.log(`· [${edit.id}] ${label}: 待改（dry-run）—— ${edit.title}`);
        continue;
    }
    const backup = backupOf(file);
    if (!existsSync(backup)) writeFileSync(backup, source, 'utf8');
    writeFileSync(file, patched.text, 'utf8');
    console.log(`✔ [${edit.id}] ${label}: 已修补（备份 …${BACKUP_SUFFIX}）`);
}

if (failures > 0) {
    console.log(`\n有 ${failures} 项未处理；上游改版时请人工核对再用（不要硬改锚点）。`);
    console.log('提示：如果文件里是第一代补丁（只有 __limits、没有 scheduler 的活体视图），先跑 --revert 还原成原版再 --apply。');
    process.exitCode = 1;
} else if (!apply && !revert) {
    console.log(`\n以上为 dry-run；确认无误后加 --apply 写入（每个文件先留 ${BACKUP_SUFFIX} 备份）。`);
}
