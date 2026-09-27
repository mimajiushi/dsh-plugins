#!/usr/bin/env node
/**
 * Gate for `scripts/patch-agent-teams-limits.mjs`.
 *
 * Three layers, all offline (no DSH runtime, no model calls):
 *
 * 1. **Static contract** — every patched anchor exists exactly once in the
 *    installed `@nanmicoder/dsh-agent-teams@0.1.20` files, and the pristine
 *    backups the patcher wrote are still there (so `--revert` stays possible).
 * 2. **Behaviour** — drives the REAL patched `scheduler.js` against a REAL team
 *    record in a temp workspace, with a recording `dispatch` hook standing in for
 *    the host. The scheduler config is built in the **production shape**
 *    (`tools.js`'s literal plus a live getter over the resolved config), because
 *    the first version of this gate passed `maxConcurrentMembers` directly — a
 *    shape production never produces — and therefore reported a green cap while
 *    the real chain was unlimited (2026-09-27 review round 1). Round 2 then found
 *    the mirror-image defect: the fake dispatch flipped the child's live status
 *    synchronously, so the gate only ever exercised OPTIMISTIC timing. Delivery
 *    really only QUEUES the turn (`deliverToMember` → FIFO `followup`), so both
 *    timings are covered here — `flipLive: false` is the realistic one and is what
 *    catches an occupancy rule that trusts the AgentHandle alone.
 * 3. **`--prove-gate`** — imports the *unpatched* backup scheduler and shows the
 *    same scenario blows the cap, proving layer 2 is a real gate and not a
 *    tautology.
 *
 * Usage:
 *   node scripts/verify-agent-teams-limits.mjs                 # static + behaviour
 *   node scripts/verify-agent-teams-limits.mjs --prove-gate    # + unpatched-baseline proof
 *
 * @module scripts/verify-agent-teams-limits
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const proveGate = argv.includes('--prove-gate');

const PACKAGE_DIR = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@nanmicoder', 'dsh-agent-teams');
const LIB = join(PACKAGE_DIR, 'lib');
const FILES = {
    index: join(LIB, 'index.js'),
    scheduler: join(LIB, 'scheduler.js'),
    tools: join(LIB, 'tools.js'),
    types: join(LIB, 'types', 'index.d.ts')
};
const BACKUP_SUFFIX = '.bak-agent-teams-limits';

let failures = 0;

/**
 * Record one check.
 * @param ok - whether the check passed.
 * @param label - the check's name.
 * @param detail - optional extra evidence.
 */
function check(ok, label, detail = '') {
    if (!ok) failures += 1;
    console.log(`${ok ? '✔' : '✘'} ${label}${detail === '' ? '' : ` —— ${detail}`}`);
}

/**
 * Read one file, or answer undefined.
 * @param file - absolute path.
 * @returns file text.
 */
function read(file) {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/** Layer 1: anchors + backups. */
function staticContract() {
    console.log('\n== 静态契约 ==');
    const index = read(FILES.index);
    const scheduler = read(FILES.scheduler);
    const tools = read(FILES.tools);
    const types = read(FILES.types);
    for (const [name, text] of Object.entries({ 'index.js': index, 'scheduler.js': scheduler, 'tools.js': tools, 'index.d.ts': types })) {
        check(text !== undefined, `${name} 存在`, text === undefined ? '文件缺失' : `${text.length} B`);
    }
    if (index === undefined || scheduler === undefined || tools === undefined || types === undefined) return;

    const indexAnchors = [
        ['配置字段 maxConcurrentMembers', '    maxConcurrentMembers: z.natural().default(0),'],
        ['resolved 透传', '        maxConcurrentMembers: config.maxConcurrentMembers ?? 0,'],
        ['__limits 导出', 'export const __limits = {'],
        ['桥注册自身', '    mountedLimits.add(resolved);'],
        ['桥的 globalThis 发布', 'globalThis[LIMITS_SYMBOL] = __limits;'],
        ['进程稳定符号', "Symbol.for('dsh.agent-teams.limits')"],
        ['桥的 apply 读回时刻生效', '    apply(next) {']
    ];
    for (const [label, anchor] of indexAnchors) {
        const count = index.split(anchor).length - 1;
        check(count === 1, `index.js: ${label}`, `${count} 处`);
    }

    const schedulerAnchors = [
        ['memberCap 导出', 'export function memberCap(config) {'],
        ['occupantHoldsSlot 导出', 'export function occupantHoldsSlot(ctx, member) {'],
        ['holdsClaim 导出', 'export function holdsClaim(tasks, memberName) {'],
        ['idleEdgePark 导出', 'export function idleEdgePark(member, tasks, parkedAttempts) {'],
        ['memberOccupiesSlot 导出', 'export function memberOccupiesSlot(ctx, tasks, member, parkedAttempts) {'],
        ['activeMemberCount 导出', 'export function activeMemberCount(team, excludeName, holdsSlot) {'],
        ['fresh 认领前的上限判定', 'const cap = memberCap(config);'],
        ['上限只在 fresh 分支生效', '? (cap === 0 || activeMemberCount(fresh, currentMember.name, (member) => memberOccupiesSlot(ctx, fresh.tasks, member, parkedAttempts)) < cap'],
        ['邮箱被闸不吞整个回合', 'so the cap cannot be exceeded by falling through'],
        ['空闲边界补位整队', `        // PATCH (agent-teams-limits): one slot just freed, so let the team refill it
        // (kickTeam includes this member and wakes whoever was waiting on capacity).
        if (status === 'idle')
            await runtime.kickTeam(workspace, located.id, agent);`]
    ];
    for (const [label, anchor] of schedulerAnchors) {
        const count = scheduler.split(anchor).length - 1;
        check(count === 1, `scheduler.js: ${label}`, `${count} 处`);
    }
    check(!scheduler.includes('await runtime.kickMember(workspace, located.id, member.name);'),
        'scheduler.js: 旧的「只补自己」的 kick 已不存在');

    const toolsAnchors = [
        ['导入三个 helper', 'import { activeMemberCount, collectCompletedDependencyOutputs, formatDependencyOutputs, installTeamScheduler, memberCap, memberOccupiesSlot } from "./scheduler.js";'],
        ['scheduler 拿到活体视图（而不是字面量拷贝）', '        get maxConcurrentMembers() {'],
        ['活体视图读的是 resolved', `        get maxConcurrentMembers() {
            return config.maxConcurrentMembers;
        },`],
        ['steer 唤醒受上限约束', "if (mode === 'steer' && cap > 0 && member.status !== 'working'"],
        ['steer 闸用同一个谓词（只少 park 账本）', '&& activeMemberCount(team, member.name, (candidate) => memberOccupiesSlot(ctx, team.tasks, candidate, undefined)) >= cap)']
    ];
    for (const [label, anchor] of toolsAnchors) {
        const count = tools.split(anchor).length - 1;
        check(count === 1, `tools.js: ${label}`, `${count} 处`);
    }
    const callIndex = tools.indexOf('const scheduler = installTeamScheduler(ctx, {');
    const getterIndex = tools.indexOf('get maxConcurrentMembers()');
    const gateIndex = tools.indexOf("if (mode === 'steer' && cap > 0");
    const deliverIndex = tools.indexOf('if (member.id !== \'\')');
    check(callIndex !== -1 && getterIndex > callIndex, 'tools.js: 活体 getter 在 installTeamScheduler 调用内');
    check(gateIndex !== -1 && deliverIndex !== -1 && gateIndex < deliverIndex, 'tools.js: 闸门在投递/生成成员之前');

    check(types.includes('    maxConcurrentMembers?: number;'), 'index.d.ts: 声明同步');

    for (const key of ['index', 'scheduler', 'tools', 'types']) {
        check(existsSync(`${FILES[key]}${BACKUP_SUFFIX}`), `备份可回滚: ${key}`, `${BACKUP_SUFFIX}`);
    }
}

/**
 * Build a temp workspace with a real team record and a recording scheduler.
 *
 * The scheduler config is built the way `tools.js` builds it — a literal plus a
 * live getter over the resolved config — unless `resolvedLink === false`, which
 * reproduces the OLD (broken) shape for the negative control.
 *
 * @param options - `{ cap, resolvedLink, flipLive, members, workingNames, ownedAttempt }`.
 * @returns the scenario handle.
 */
async function scenario(options) {
    const { cap, resolvedLink = true, flipLive = true, members = 3, workingNames = [], ownedAttempt = [] } = options;
    const state = await import(pathToFileURL(join(LIB, 'state.js')).href);
    const schedulerModule = await import(pathToFileURL(join(LIB, 'scheduler.js')).href);
    const { installTeamScheduler } = schedulerModule;

    const workspace = mkdtempSync(join(tmpdir(), 'agent-teams-limits-'));
    const stateRoot = join(workspace, '.agent-teams');
    const teamId = 'probe-team';
    const captainId = 'captain-session';
    const now = Date.now();
    const record = {
        name: 'limits probe',
        id: teamId,
        description: 'probe',
        captainSessionId: captainId,
        createdAt: now,
        members: [],
        tasks: [],
        taskSeq: 0
    };
    for (let index = 1; index <= members; index += 1) {
        const name = `m${index}`;
        const id = `member-${index}`;
        record.members.push({ id, name, provider: 'spawn', model: 'probe', joinedAt: now, status: workingNames.includes(name) ? 'working' : 'idle' });
        const owned = ownedAttempt.includes(name);
        record.tasks.push({
            id: `t${index}`,
            subject: `task ${index}`,
            description: '',
            status: owned ? 'in_progress' : 'pending',
            assignee: name,
            dependencies: [],
            attempt: owned ? 1 : 0,
            ...owned ? { attemptId: `attempt-${name}` } : {},
            createdAt: now,
            updatedAt: now
        });
    }
    record.taskSeq = members;
    await state.createTeamDir(stateRoot, record);

    const liveAgents = new Map();
    liveAgents.set(captainId, { id: captainId, status: 'running', session: { header: { cwd: workspace } } });
    for (const member of record.members) {
        liveAgents.set(member.id, { id: member.id, status: 'idle', session: { header: { cwd: workspace } } });
    }

    const dispatches = [];
    const listeners = new Map();
    const ctx = {
        on(event, listener) {
            listeners.set(event, listener);
            return () => listeners.delete(event);
        },
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        agents: { get: (id) => liveAgents.get(id) }
    };
    /** Stands in for the plugin's `resolved` config — what the live bridge mutates. */
    const resolved = { maxConcurrentMembers: cap };
    const schedulerConfig = {
        stateDir: '.agent-teams',
        executionPrompt: undefined,
        dispatch: async (_captain, team, memberName, _text, _signal, mode, attemptId) => {
            dispatches.push({ memberName, mode, attemptId });
            const fresh = await state.readTeam(stateRoot, team);
            const member = fresh?.members.find((candidate) => candidate.name === memberName);
            const agent = member === undefined ? undefined : liveAgents.get(member.id);
            // flipLive: the OPTIMISTIC timing — the child starts before the dispatch
            // call returns. Real hosts only queue the turn (`followup` returns a
            // MessageId), which is the `flipLive: false` case below.
            if (agent !== undefined && flipLive) agent.status = 'running';
            return true;
        }
    };
    if (resolvedLink) {
        // A REAL getter, defined on the config object — spreading a getter into a
        // literal would evaluate it once and freeze the value, which is precisely
        // the shape defect this layer exists to catch.
        Object.defineProperty(schedulerConfig, 'maxConcurrentMembers', {
            enumerable: true,
            configurable: true,
            get: () => resolved.maxConcurrentMembers
        });
    }
    const runtime = installTeamScheduler(ctx, schedulerConfig);
    return {
        workspace, stateRoot, teamId, captainId, dispatches, liveAgents, listeners, runtime, state, record, resolved,
        /** Reproduce what the live bridge does: mutate the resolved config in place. */
        setCap(value) {
            resolved.maxConcurrentMembers = value;
        }
    };
}

/**
 * Wait until a condition holds or the deadline passes.
 * @param predicate - sync check.
 * @param timeoutMs - budget.
 * @returns whether it became true.
 */
async function waitFor(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    return predicate();
}

/**
 * Simulate one member finishing its turn: complete its open task, mark its agent
 * idle, then fire the scheduler's own `agent/status` edge.
 * @param scene - the scenario handle.
 * @param memberIndex - 1-based member number.
 */
async function finishMember(scene, memberIndex) {
    const name = `m${memberIndex}`;
    const fresh = await scene.state.readTeam(scene.stateRoot, scene.teamId);
    const task = fresh.tasks.find((candidate) => candidate.assignee === name && candidate.status !== 'completed');
    if (task !== undefined) {
        task.status = 'completed';
        task.output = `${name} done`;
        task.attemptId = undefined;
        await scene.state.writeTeam(scene.stateRoot, fresh);
    }
    const agent = scene.liveAgents.get(`member-${memberIndex}`);
    agent.status = 'idle';
    scene.listeners.get('agent/status')({ agent, status: 'idle' });
}

/** Layer 2: the live scheduler honours the cap, refills, and reads the live view. */
async function behaviour() {
    console.log('\n== 行为（真 scheduler.js + 真 team.json + 假 ctx，生产形状）==');

    const schedulerModule = await import(pathToFileURL(join(LIB, 'scheduler.js')).href);
    const { memberCap, activeMemberCount, occupantHoldsSlot, holdsClaim, idleEdgePark, memberOccupiesSlot } = schedulerModule;
    check(memberCap({ maxConcurrentMembers: 2 }) === 2, 'memberCap(2) = 2');
    check(memberCap({}) === 0, 'memberCap(未设) = 0（不限）');
    check(memberCap({ maxConcurrentMembers: 0 }) === 0, 'memberCap(0) = 0（不限）');
    check(memberCap({ maxConcurrentMembers: -3 }) === 0, 'memberCap(-3) = 0（不限）');
    check(memberCap({ maxConcurrentMembers: 2.7 }) === 2, 'memberCap(2.7) = 2');

    const team = (members) => ({ members });
    const fakeCtx = (agents) => ({ agents: { get: (id) => agents[id] } });
    check(activeMemberCount(team([{ name: 'a', status: 'working' }, { name: 'b', status: 'idle' }]), 'b') === 1,
        'activeMemberCount 无谓词时退化为「只数 working」');
    check(occupantHoldsSlot(fakeCtx({}), { id: '', name: 'a', status: 'working' }) === true,
        'occupantHoldsSlot：已标记 working 但还没 spawn 的成员 → true（保守）');
    check(occupantHoldsSlot(fakeCtx({}), { id: '', name: 'a', status: 'idle' }) === false,
        'occupantHoldsSlot：没 spawn 且不是 working → false');
    check(occupantHoldsSlot(fakeCtx({ s1: { status: 'running' } }), { id: 's1', name: 'a', status: 'working' }) === true,
        'occupantHoldsSlot：live 句柄在跑 → true');
    check(occupantHoldsSlot(fakeCtx({ s1: { status: 'idle' } }), { id: 's1', name: 'a', status: 'working' }) === false,
        'occupantHoldsSlot：live 句柄明确 idle → 句柄本身不算（要靠 open claim 补）');
    check(occupantHoldsSlot(fakeCtx({}), { id: 's1', name: 'a', status: 'working' }) === false,
        'occupantHoldsSlot：句柄已消失（重启残留）→ 不算，与上游 isMemberAvailable 同一模型');
    check(activeMemberCount(
        team([{ name: 'a', status: 'working' }, { name: 'b', status: 'working' }, { name: 'c', status: 'idle' }]),
        'c',
        (member) => member.name === 'a',
    ) === 1, 'activeMemberCount 接受占位判定回调');

    const tasksOf = (status, attemptId) => [{ assignee: 'm1', status, ...attemptId === undefined ? {} : { attemptId } }];
    check(holdsClaim(tasksOf('claimed', 'a1'), 'm1') === true, 'holdsClaim：claimed 算握有 claim');
    check(holdsClaim(tasksOf('in_progress', 'a1'), 'm1') === true, 'holdsClaim：in_progress 算握有 claim');
    check(holdsClaim(tasksOf('pending'), 'm1') === false, 'holdsClaim：pending 不算');
    check(holdsClaim(tasksOf('completed', 'a1'), 'm1') === false, 'holdsClaim：completed 不算');

    // The two parks: an idle-edge park ends the turn (excluded); a recovery park is
    // about to run (counted). The durable status is what tells them apart.
    const parkedMap = new Map([['s1', 'a1']]);
    check(idleEdgePark({ name: 'm1', id: 's1', status: 'idle' }, tasksOf('in_progress', 'a1'), parkedMap) === true,
        'idleEdgePark：idle 边界 park（状态已翻 idle）→ true（不算占位）');
    check(idleEdgePark({ name: 'm1', id: 's1', status: 'working' }, tasksOf('in_progress', 'a1'), parkedMap) === false,
        'idleEdgePark：recovery park（成员仍 working）→ false（仍要占位）');
    check(idleEdgePark({ name: 'm1', id: 's1', status: 'idle' }, tasksOf('in_progress', 'a1'), new Map()) === false,
        'idleEdgePark：没有 park 记录（重启残留）→ false（按占位算，与上游 recovery 行为一致）');
    check(idleEdgePark({ name: 'm1', id: 's1', status: 'idle' }, tasksOf('in_progress'), parkedMap) === false,
        'idleEdgePark：没有 attemptId 的 claim → false（保守占位）');

    const shape = (options) => memberOccupiesSlot(
        fakeCtx(options.agents ?? {}),
        options.tasks ?? [],
        { name: 'm1', id: 's1', status: options.status ?? 'working' },
        options.parked ?? new Map(),
    );
    check(shape({ agents: { s1: { status: 'running' } } }) === true, 'memberOccupiesSlot：句柄在跑 → 占位');
    check(shape({}) === false, 'memberOccupiesSlot：句柄不在、无 claim → 不占位（残留不卡死）');
    check(shape({ tasks: tasksOf('claimed', 'a1') }) === true,
        'memberOccupiesSlot：刚认领、句柄还没起跑 → 占位（fan-out 不会被放过）');
    check(shape({ tasks: tasksOf('in_progress', 'a1') }) === true, 'memberOccupiesSlot：in_progress 认领 → 占位');
    check(shape({ tasks: tasksOf('in_progress', 'a1'), parked: parkedMap, status: 'working' }) === true,
        'memberOccupiesSlot：recovery park（仍 working）→ 占位（否则每恢复一个就多放一个）');
    check(shape({ tasks: tasksOf('in_progress', 'a1'), parked: parkedMap, status: 'idle' }) === false,
        'memberOccupiesSlot：idle 边界 park（状态 idle）→ 不占位（小 cap 不被卡死）');
    check(shape({ tasks: tasksOf('in_progress', 'a1'), parked: new Map(), status: 'idle' }) === true,
        'memberOccupiesSlot：状态 idle 但握着 claim 且无 park 记录（重启残留）→ 占位（上游会 recovery 它，会跑）');
    check(shape({ tasks: tasksOf('claimed'), status: 'idle' }) === true,
        'memberOccupiesSlot：无 attemptId 的 claim → 占位（保守）');
    check(memberOccupiesSlot(
        fakeCtx({}),
        tasksOf('in_progress', 'a1'),
        { name: 'm1', id: 's1', status: 'working', stopping: true },
        new Map(),
    ) === false, 'memberOccupiesSlot：stopping → 不占位');

    // Production shape + cap = 1: exactly one member runs, and the idle edge refills one.
    const serial = await scenario({ cap: 1 });
    try {
        await serial.runtime.kickTeam(serial.workspace, serial.teamId, serial.liveAgents.get(serial.captainId));
        check(serial.dispatches.length === 1, '生产形状 cap=1：一次 kickTeam 只派 1 个成员',
            `实际 ${serial.dispatches.length}：${serial.dispatches.map((item) => item.memberName).join(',') || '无'}`);
        check(serial.dispatches[0]?.mode === 'queue', '生产形状 cap=1：派发走 queue 模式');
        const mid = serial.state.readTeamSync(serial.stateRoot, serial.teamId);
        check(mid.members.filter((member) => member.status === 'working').length === 1,
            '生产形状 cap=1：团队状态里只有 1 个 working');

        await finishMember(serial, 1);
        const refilled = await waitFor(() => serial.dispatches.length >= 2);
        check(refilled && serial.dispatches.length === 2, '空闲边界补位：第 2 个成员被派发',
            `实际 ${serial.dispatches.length}：${serial.dispatches.map((item) => item.memberName).join(',')}`);
        await finishMember(serial, 2);
        const third = await waitFor(() => serial.dispatches.length >= 3);
        check(third && serial.dispatches.length === 3, '空闲边界补位：第 3 个成员被派发',
            `实际 ${serial.dispatches.length}：${serial.dispatches.map((item) => item.memberName).join(',')}`);
        check(serial.dispatches.every((item) => item.attemptId !== undefined), '每次派发都带 attempt_id 能力');
    } finally {
        rmSync(serial.workspace, { recursive: true, force: true });
    }

    // REALISTIC timing (the child is only queued at dispatch time): the just-claimed
    // member's handle still reads idle, so the handle alone must not decide occupancy.
    // This is the case that caught the round-2 regression.
    const queued = await scenario({ cap: 1, flipLive: false });
    try {
        await queued.runtime.kickTeam(queued.workspace, queued.teamId, queued.liveAgents.get(queued.captainId));
        check(queued.dispatches.length === 1, '真实时序（投递只排队）cap=1：一次 kickTeam 仍只派 1 个',
            `实际 ${queued.dispatches.length}：${queued.dispatches.map((item) => item.memberName).join(',') || '无'}`);
        await finishMember(queued, 1);
        const refilled = await waitFor(() => queued.dispatches.length >= 2);
        check(refilled && queued.dispatches.length === 2, '真实时序下空闲边界仍然补位（第 2 个被派发）',
            `实际 ${queued.dispatches.length}`);
    } finally {
        rmSync(queued.workspace, { recursive: true, force: true });
    }

    // A PARKED attempt (the turn ended with the task still open) must not pin the only
    // slot: only a captain reassignment may rotate it, and the rest of the team has to
    // keep working meanwhile.
    const parked = await scenario({ cap: 1, flipLive: false });
    try {
        await parked.runtime.kickTeam(parked.workspace, parked.teamId, parked.liveAgents.get(parked.captainId));
        const firstRound = parked.dispatches.length;
        // The turn ends WITHOUT completing t1: the idle edge parks the attempt.
        parked.liveAgents.get('member-1').status = 'idle';
        parked.listeners.get('agent/status')({ agent: parked.liveAgents.get('member-1'), status: 'idle' });
        const advanced = await waitFor(() => parked.dispatches.length >= firstRound + 1);
        check(advanced && parked.dispatches.length === 2, '被 park 的成员不占位：m2 仍能拿到唯一的位子',
            `实际 ${parked.dispatches.length}：${parked.dispatches.map((item) => item.memberName).join(',') || '无'}`);
        check(parked.dispatches.filter((item) => item.memberName === 'm1').length === 1,
            '被 park 的 attempt 不会被重复派发');
        check(parked.dispatches.at(-1)?.memberName === 'm2', '补位的是另一个成员（m2）');
    } finally {
        rmSync(parked.workspace, { recursive: true, force: true });
    }

    // cap = 0: stock behaviour, everyone goes at once.
    const unlimited = await scenario({ cap: 0 });
    try {
        await unlimited.runtime.kickTeam(unlimited.workspace, unlimited.teamId, unlimited.liveAgents.get(unlimited.captainId));
        check(unlimited.dispatches.length === 3, 'cap=0：不限并发（3 个成员一次全派）',
            `实际 ${unlimited.dispatches.length}`);
    } finally {
        rmSync(unlimited.workspace, { recursive: true, force: true });
    }

    // Live view: mutating the resolved config (what __limits.apply does) must
    // change the very next decision, with no reload.
    const live = await scenario({ cap: 1 });
    try {
        await live.runtime.kickTeam(live.workspace, live.teamId, live.liveAgents.get(live.captainId));
        const afterFirst = live.dispatches.length;
        live.setCap(0);
        await live.runtime.kickTeam(live.workspace, live.teamId, live.liveAgents.get(live.captainId));
        check(afterFirst === 1 && live.dispatches.length === 3,
            '活体视图：改 resolved 后下一次 kickTeam 立刻按新值放行（无需重载）',
            `首次 ${afterFirst} 个 → 放开后 ${live.dispatches.length} 个`);
    } finally {
        rmSync(live.workspace, { recursive: true, force: true });
    }

    // Negative control: the OLD shape (a copied literal, no live view) is inert —
    // this is the exact defect the 2026-09-27 review found, and this case fails
    // loudly if anyone reintroduces it.
    const oldShape = await scenario({ cap: 1, resolvedLink: false });
    try {
        oldShape.setCap(1);
        await oldShape.runtime.kickTeam(oldShape.workspace, oldShape.teamId, oldShape.liveAgents.get(oldShape.captainId));
        check(oldShape.dispatches.length === 3,
            '负控制：旧形状（拷贝字面量、没有活体视图）确实无视 cap —— 证明上面那条不是同义反复',
            `实际 ${oldShape.dispatches.length}`);
    } finally {
        rmSync(oldShape.workspace, { recursive: true, force: true });
    }

    // A 'working' member whose handle is explicitly idle must not pin the cap shut.
    const stale = await scenario({ cap: 1, workingNames: ['m2'] });
    try {
        await stale.runtime.kickTeam(stale.workspace, stale.teamId, stale.liveAgents.get(stale.captainId));
        check(stale.dispatches.length === 1 && stale.dispatches[0]?.memberName === 'm1',
            '陈旧 working（句柄 idle）不占位：m1 照常被派发，不被残留卡死',
            `${stale.dispatches.map((item) => item.memberName).join(',') || '无'}`);
    } finally {
        rmSync(stale.workspace, { recursive: true, force: true });
    }

    // cap already spent by a genuinely running member, but this member owns an open
    // attempt: recovery must still be delivered (never gate an already-held slot).
    const recovery = await scenario({ cap: 1, workingNames: ['m2'], ownedAttempt: ['m1'] });
    try {
        recovery.liveAgents.get('member-2').status = 'running';
        await recovery.runtime.kickTeam(recovery.workspace, recovery.teamId, recovery.liveAgents.get(recovery.captainId));
        const recovered = recovery.dispatches.filter((item) => item.memberName === 'm1');
        const fresh = recovery.dispatches.filter((item) => item.memberName === 'm3');
        check(recovered.length === 1, '已达上限时仍恢复已有 attempt（m1）', `m1 派发 ${recovered.length} 次`);
        check(fresh.length === 0, '已达上限时不派新任务（m3 保持 pending）', `m3 派发 ${fresh.length} 次`);
    } finally {
        rmSync(recovery.workspace, { recursive: true, force: true });
    }

    // A member recovered in THIS pass still occupies its slot while its queued turn
    // has not started: the recovery park must not be mistaken for an ended turn
    // (round-3 review: cap 2 with one running + one recovered admitted a third).
    const recovering = await scenario({
        cap: 2,
        flipLive: false,
        workingNames: ['m1', 'm2'],
        ownedAttempt: ['m1', 'm2'],
    });
    try {
        recovering.liveAgents.get('member-1').status = 'running';
        recovering.liveAgents.get('member-2').status = 'idle';
        await recovering.runtime.kickTeam(recovering.workspace, recovering.teamId, recovering.liveAgents.get(recovering.captainId));
        const names = recovering.dispatches.map((item) => item.memberName);
        check(names.length === 1 && names[0] === 'm2',
            'recovery 也占位：cap=2 时只恢复 m2，不再多放 m3',
            `实派 ${names.join(',') || '无'}（并发 = m1 + m2 = 2）`);
        check(!names.includes('m3'), 'recovery 占位：m3 的 fresh 任务被拒');
    } finally {
        rmSync(recovering.workspace, { recursive: true, force: true });
    }
}

/** Layer 3: the same scenario on the unpatched backup must blow the cap. */
async function gateProof() {
    console.log('\n== 闸门自证（未修补的备份会漏）==');
    const backup = `${FILES.scheduler}${BACKUP_SUFFIX}`;
    if (!existsSync(backup)) {
        check(false, '备份不存在，无法自证', backup);
        return;
    }
    const probe = join(LIB, '.gate-probe-scheduler.js');
    copyFileSync(backup, probe);
    try {
        const state = await import(pathToFileURL(join(LIB, 'state.js')).href);
        const plain = await import(pathToFileURL(probe).href);
        check(typeof plain.memberCap !== 'function', '未修补的备份没有 memberCap（锚点确实不存在）');
        const workspace = mkdtempSync(join(tmpdir(), 'agent-teams-gate-'));
        const stateRoot = join(workspace, '.agent-teams');
        const now = Date.now();
        const record = {
            name: 'gate probe', id: 'gate-team', description: 'probe', captainSessionId: 'captain-session',
            createdAt: now, members: [], tasks: [], taskSeq: 0
        };
        for (let index = 1; index <= 3; index += 1) {
            record.members.push({ id: `member-${index}`, name: `m${index}`, provider: 'spawn', model: 'probe', joinedAt: now, status: 'idle' });
            record.tasks.push({ id: `t${index}`, subject: `task ${index}`, description: '', status: 'pending', assignee: `m${index}`, dependencies: [], attempt: 0, createdAt: now, updatedAt: now });
        }
        await state.createTeamDir(stateRoot, record);
        const liveAgents = new Map([['captain-session', { id: 'captain-session', status: 'running', session: { header: { cwd: workspace } } }]]);
        for (const member of record.members) liveAgents.set(member.id, { id: member.id, status: 'idle', session: { header: { cwd: workspace } } });
        const dispatches = [];
        const ctx = {
            on: () => () => {},
            logger: { warn: () => {}, info: () => {}, error: () => {} },
            agents: { get: (id) => liveAgents.get(id) }
        };
        const runtime = plain.installTeamScheduler(ctx, {
            stateDir: '.agent-teams',
            executionPrompt: undefined,
            maxConcurrentMembers: 1,
            dispatch: async (_captain, _team, memberName) => {
                dispatches.push(memberName);
                return true;
            }
        });
        await runtime.kickTeam(workspace, 'gate-team', liveAgents.get('captain-session'));
        check(dispatches.length === 3, '未修补版本：cap=1 被无视（3 个成员全派）—— 闸门确实会咬',
            `实际 ${dispatches.length}：${dispatches.join(',')}`);
        rmSync(workspace, { recursive: true, force: true });
    } finally {
        try { unlinkSync(probe); } catch { /* best effort */ }
    }
}

staticContract();
await behaviour();
if (proveGate) await gateProof();

console.log('');
if (failures > 0) {
    console.log(`\n${failures} 项未通过。若刚跑过 --revert，这就是预期结果；重跑 --apply 后再验一次。`);
    process.exitCode = 1;
} else {
    console.log(proveGate
        ? '\n全部通过（含未修补基线的自证）：补丁在位，上限在生产形状下真的会咬。'
        : '\n全部通过：补丁在位、上限在真 scheduler 的生产形状上生效。');
}
