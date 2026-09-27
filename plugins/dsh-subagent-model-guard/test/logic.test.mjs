/**
 * Pure-logic tests: every rule the guard applies, with no DSH runtime. The
 * module under test imports nothing, so these tests are the complete
 * specification of what the plugin decides.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NAME,
    SETTINGS_NS,
    TEAM_ADD_MEMBER_TOOL,
    TEAM_CREATE_TOOL,
    TEAM_EDIT_PLAN_TOOL,
    decideDelegation,
    delegationErrorText,
    effectiveChildRoute,
    formatAllowedRoutes,
    formatRoute,
    guardDecision,
    guardTeamToolDecision,
    isDelegationToolName,
    modelRouteKey,
    parseAllowedModels,
    resolveGuardConfig,
    resolveParentRoute,
} from '../lib/logic.js';

const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash' };
const KIMI_256K = { provider: 'kimi-coding', model: 'k3-256k' };
const KIMI = { provider: 'kimi-coding', model: 'k3' };

/** An active whitelist over the given routes. */
function policy(routes) {
    return parseAllowedModels({ enabled: true, allowedModels: routes });
}

/** A live-looking parent Agent whose request header owns the route. */
function parentAgent({ header, options } = {}) {
    return {
        options: options ?? DEEPSEEK,
        session: { requestHeader: () => (header === undefined ? undefined : { config: header }) },
    };
}

test('parseAllowedModels stays inert for anything that is not an enabled list', () => {
    for (const section of [
        undefined,
        null,
        'nope',
        42,
        [],
        {},
        { enabled: false, allowedModels: [DEEPSEEK] },
        { enabled: 'true', allowedModels: [DEEPSEEK] },
        { enabled: true },
        { enabled: true, allowedModels: 'nope' },
        { enabled: true, allowedModels: [] },
    ]) {
        assert.deepEqual(parseAllowedModels(section), { enabled: false, routes: [] }, JSON.stringify(section));
    }
});

test('parseAllowedModels drops unusable entries and de-duplicates', () => {
    const parsed = parseAllowedModels({
        enabled: true,
        allowedModels: [
            DEEPSEEK,
            { provider: '', model: 'x' },
            { provider: 'kimi-coding', model: '' },
            { provider: 'kimi-coding' },
            { model: 'k3' },
            null,
            'kimi-coding/k3',
            [DEEPSEEK],
            DEEPSEEK,
            KIMI_256K,
        ],
    });
    assert.equal(parsed.enabled, true);
    assert.deepEqual(parsed.routes, [DEEPSEEK, KIMI_256K]);
});

test('parseAllowedModels tolerates extra settings fields (effort, hints)', () => {
    const parsed = parseAllowedModels({
        enabled: true,
        allowReasoningEffortOverride: true,
        allowedModels: [{ ...DEEPSEEK, reasoningEffort: 'max' }, KIMI_256K],
    });
    assert.deepEqual(parsed.routes, [DEEPSEEK, KIMI_256K]);
});

test('modelRouteKey separates routes that differ in either half', () => {
    assert.equal(modelRouteKey(DEEPSEEK), modelRouteKey({ ...DEEPSEEK }));
    assert.notEqual(modelRouteKey(DEEPSEEK), modelRouteKey({ provider: 'deepseek-official', model: 'deepseek-pro' }));
    assert.notEqual(modelRouteKey(DEEPSEEK), modelRouteKey({ provider: 'kimi-coding', model: 'deepseek-flash' }));
});

test('resolveParentRoute prefers the live request header and falls back to creation options', () => {
    assert.deepEqual(resolveParentRoute(parentAgent({ header: KIMI })), KIMI);
    assert.deepEqual(resolveParentRoute(parentAgent({ header: undefined, options: KIMI_256K })), KIMI_256K);
    assert.deepEqual(
        resolveParentRoute(parentAgent({ header: KIMI, options: DEEPSEEK })),
        KIMI,
        'the header owns the route after request-time selection',
    );
    assert.equal(
        resolveParentRoute(parentAgent({ header: {}, options: DEEPSEEK })),
        undefined,
        'an incomplete header is not patched from creation options — that route never ran',
    );
});

test('resolveParentRoute refuses an incomplete or absent route', () => {
    assert.equal(resolveParentRoute(parentAgent({ header: { provider: 'kimi-coding' } })), undefined);
    assert.equal(resolveParentRoute(parentAgent({ header: undefined, options: {} })), undefined);
    assert.equal(resolveParentRoute(parentAgent({ header: { provider: '', model: 'k3' } })), undefined);
    assert.equal(resolveParentRoute(undefined), undefined, 'a missing parent is resolved, not thrown on');
});

test('effectiveChildRoute merges requested fields over the parent route', () => {
    const parent = parentAgent({ header: DEEPSEEK });
    assert.deepEqual(effectiveChildRoute(parent, undefined), DEEPSEEK);
    assert.deepEqual(effectiveChildRoute(parent, {}), DEEPSEEK);
    assert.deepEqual(
        effectiveChildRoute(parent, { model: 'k3-256k' }),
        { provider: 'deepseek-official', model: 'k3-256k' },
        'a lone model keeps the parent provider',
    );
    assert.deepEqual(
        effectiveChildRoute(parent, { provider: 'kimi-coding' }),
        { provider: 'kimi-coding', model: 'deepseek-flash' },
        'a lone provider keeps the parent model — the hybrid route is exactly what the child runs on',
    );
    assert.deepEqual(effectiveChildRoute(parent, KIMI), KIMI);
});

test('effectiveChildRoute is unresolvable when neither half exists anywhere', () => {
    assert.equal(
        effectiveChildRoute(parentAgent({ header: undefined, options: {} }), { model: 'k3' }),
        undefined,
        'no provider source at all',
    );
    assert.equal(
        effectiveChildRoute(parentAgent({ header: { model: 'k3' } }), {}),
        undefined,
        'a header without a provider cannot complete the route',
    );
    assert.equal(
        effectiveChildRoute(parentAgent({ header: undefined, options: { provider: 'kimi-coding' } }), undefined),
        undefined,
    );
});

test('decideDelegation allows everything while the whitelist is off', () => {
    for (const kind of [policy([]), parseAllowedModels(undefined), parseAllowedModels({ enabled: false })]) {
        const verdict = decideDelegation({ policy: kind, parentAgent: parentAgent({ header: KIMI }), agentOptions: KIMI });
        assert.equal(verdict.allowed, true);
    }
});

test('decideDelegation allows an on-list explicit route', () => {
    const verdict = decideDelegation({
        policy: policy([DEEPSEEK, KIMI_256K]),
        parentAgent: parentAgent({ header: DEEPSEEK }),
        agentOptions: KIMI_256K,
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.explicit, true);
});

test('decideDelegation refuses an off-list explicit route', () => {
    const verdict = decideDelegation({
        policy: policy([DEEPSEEK]),
        parentAgent: parentAgent({ header: DEEPSEEK }),
        agentOptions: KIMI,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'not-whitelisted');
    assert.deepEqual(verdict.route, KIMI);
});

test('decideDelegation refuses a half-specified route that resolves off-list', () => {
    const verdict = decideDelegation({
        policy: policy([DEEPSEEK]),
        parentAgent: parentAgent({ header: DEEPSEEK }),
        agentOptions: { model: 'k3' },
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'not-whitelisted');
    assert.deepEqual(verdict.route, { provider: 'deepseek-official', model: 'k3' });

    const hybrid = decideDelegation({
        policy: policy([DEEPSEEK]),
        parentAgent: parentAgent({ header: DEEPSEEK }),
        agentOptions: { provider: 'kimi-coding' },
    });
    assert.equal(hybrid.allowed, false);
    assert.equal(hybrid.reason, 'not-whitelisted');
    assert.deepEqual(hybrid.route, { provider: 'kimi-coding', model: 'deepseek-flash' });
});

test('decideDelegation refuses pure inheritance of an off-list parent route', () => {
    const verdict = decideDelegation({
        policy: policy([DEEPSEEK, KIMI_256K]),
        parentAgent: parentAgent({ header: KIMI }),
        agentOptions: undefined,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'parent-route-not-whitelisted');
    assert.deepEqual(verdict.route, KIMI);
    assert.equal(verdict.explicit, false);
});

test('decideDelegation allows pure inheritance of an on-list parent route', () => {
    const verdict = decideDelegation({
        policy: policy([DEEPSEEK]),
        parentAgent: parentAgent({ header: DEEPSEEK }),
        agentOptions: { reasoningEffort: 'max' },
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.explicit, false);
});

test('decideDelegation reports an unresolvable route instead of guessing', () => {
    const verdict = decideDelegation({
        policy: policy([DEEPSEEK]),
        parentAgent: parentAgent({ header: undefined, options: {} }),
        agentOptions: {},
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'unresolvable');
    assert.equal(verdict.route, undefined);
});

test('delegationErrorText names the route, every allowed route, and the fix', () => {
    const routes = [DEEPSEEK, KIMI_256K];
    const text = delegationErrorText({
        reason: 'not-whitelisted',
        route: KIMI,
        routes,
        source: '工具调用 `subagent`',
    });
    assert.match(text, /白名单拦截/);
    assert.match(text, /工具调用 `subagent`/);
    assert.match(text, /kimi-coding\/k3/);
    assert.match(text, /deepseek-official\/deepseek-flash/);
    assert.match(text, /kimi-coding\/k3-256k/);
    assert.match(text, /list_subagent_models/);
    assert.match(text, /subagent-model-selection/);
    assert.match(text, /未创建任何子 Agent/);
});

test('delegationErrorText explains an inherited off-list route differently', () => {
    const text = delegationErrorText({
        reason: 'parent-route-not-whitelisted',
        route: KIMI,
        routes: [DEEPSEEK],
        source: 'continuable 子 Agent（provider "spawn"）',
    });
    assert.match(text, /没有显式选择模型/);
    assert.match(text, /继承队长的路由 "kimi-coding\/k3"/);
    assert.match(text, /把队长的模型切到上面的某个模型/);
});

test('delegationErrorText covers an unresolvable route', () => {
    const text = delegationErrorText({ reason: 'unresolvable', route: undefined, routes: [DEEPSEEK] });
    assert.match(text, /无法从队长路由或本次参数解析/);
    assert.match(text, /list_subagent_models/);
});

test('delegationErrorText survives an empty whitelist and a missing source', () => {
    const text = delegationErrorText({ reason: 'not-whitelisted', route: KIMI, routes: [] });
    assert.match(text, /当前允许的模型（0 个）/);
    assert.match(text, /（无）/);
    assert.match(text, /未知来源/);
});

test('formatAllowedRoutes and formatRoute render the placeholders the copy relies on', () => {
    assert.equal(formatAllowedRoutes([]), '  - （无）');
    assert.equal(formatAllowedRoutes([DEEPSEEK, KIMI_256K]), `  - deepseek-official/deepseek-flash\n  - kimi-coding/k3-256k`);
    assert.equal(formatRoute(undefined), '(unresolved)');
    assert.equal(formatRoute(KIMI), 'kimi-coding/k3');
});

test('isDelegationToolName covers the family and excludes control tools', () => {
    for (const name of ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code']) {
        assert.equal(isDelegationToolName(name), true, name);
    }
    for (const name of ['subagent_report', 'subagent_report_x', 'workflow', 'ralph', 'agent_teams_add_member', 'send_message', '', 'subagentx']) {
        assert.equal(isDelegationToolName(name), false, name);
    }
    assert.equal(isDelegationToolName(undefined), false);
});

test('guardDecision refuses only an explicit off-list model request', () => {
    const active = policy([DEEPSEEK]);
    assert.match(
        guardDecision({ name: 'subagent', arguments: { provider: 'kimi-coding', model: 'k3' } }, active),
        /白名单拦截/,
    );
    assert.match(
        guardDecision({ name: 'subagent_fork', arguments: { provider: 'kimi-coding', model: 'k3' } }, active),
        /白名单拦截/,
    );
    assert.equal(
        guardDecision({ name: 'subagent', arguments: { provider: 'deepseek-official', model: 'deepseek-flash' } }, active),
        undefined,
    );
});

test('guardDecision leaves everything else alone', () => {
    const active = policy([DEEPSEEK]);
    const offList = { provider: 'kimi-coding', model: 'k3' };
    assert.equal(guardDecision({ name: 'subagent', arguments: { prompt: 'p' } }, active), undefined);
    assert.equal(guardDecision({ name: 'subagent', arguments: { provider: 'kimi-coding' } }, active), undefined);
    assert.equal(guardDecision({ name: 'subagent', arguments: { model: 'k3' } }, active), undefined);
    assert.equal(guardDecision({ name: 'subagent', arguments: { provider: '', model: '' } }, active), undefined);
    assert.equal(guardDecision({ name: 'workflow', arguments: offList }, active), undefined);
    assert.equal(guardDecision({ name: 'subagent_report', arguments: offList }, active), undefined);
    assert.equal(guardDecision({ name: 'subagent', arguments: offList }, policy([])), undefined, 'inert while off');
    assert.equal(guardDecision({ name: 'subagent', arguments: undefined }, active), undefined);
    assert.equal(guardDecision({ name: 'subagent' }, active), undefined);
    assert.equal(guardDecision({ name: 'subagent', arguments: ['nope'] }, active), undefined);
    assert.equal(guardDecision(undefined, active), undefined);
});

/** A tool execution carrying the calling captain agent, as dsh-tools passes it. */
function teamExecution(name, args, captainRoute = DEEPSEEK) {
    return { name, arguments: args, agent: parentAgent({ header: captainRoute }) };
}

test('guardTeamToolDecision refuses an off-list explicit member at create time', () => {
    const active = policy([DEEPSEEK, KIMI_256K]);
    const denial = guardTeamToolDecision(teamExecution(TEAM_CREATE_TOOL, {
        name: 'team-x',
        plan: {
            members: [
                { name: 'ok', ...DEEPSEEK },
                { name: 'bad', ...KIMI },
            ],
            tasks: [],
        },
    }), active);
    assert.match(denial, /白名单拦截/);
    assert.match(denial, /agent_teams_create/);
    assert.match(denial, /成员 "bad"/);
    assert.match(denial, /kimi-coding\/k3"/);
    assert.match(denial, /deepseek-official\/deepseek-flash/);
    assert.match(denial, /kimi-coding\/k3-256k/);
});

test('guardTeamToolDecision refuses inherited captain route at create time', () => {
    const active = policy([DEEPSEEK, KIMI_256K]);
    const denial = guardTeamToolDecision(teamExecution(TEAM_CREATE_TOOL, {
        name: 'team-x',
        plan: { members: [{ name: 'inherits' }], tasks: [] },
    }, KIMI), active);
    assert.match(denial, /继承队长的路由 "kimi-coding\/k3"/);
});

test('guardTeamToolDecision allows an all-whitelist roster and a model-only member', () => {
    const active = policy([DEEPSEEK, KIMI_256K]);
    assert.equal(guardTeamToolDecision(teamExecution(TEAM_CREATE_TOOL, {
        name: 'team-x',
        plan: {
            members: [
                { name: 'a', ...DEEPSEEK },
                { name: 'b', provider: 'kimi-coding', model: 'k3-256k', reasoning_effort: 'high' },
                { name: 'c' },
                { name: 'd', model: 'deepseek-flash' },
            ],
            tasks: [],
        },
    }), active), undefined);
});

test('guardTeamToolDecision skips a profile create and a provider-only member', () => {
    const active = policy([DEEPSEEK]);
    assert.equal(
        guardTeamToolDecision(teamExecution(TEAM_CREATE_TOOL, { name: 'team-x', profile: 'seed' }, KIMI), active),
        undefined,
        'a profile roster is expanded inside the tool; the spawn gate owns it',
    );
    assert.equal(
        guardTeamToolDecision(teamExecution(TEAM_CREATE_TOOL, {
            name: 'team-x',
            plan: { members: [{ name: 'half', provider: 'kimi-coding' }], tasks: [] },
        }), active),
        undefined,
        'agent-teams itself rejects an explicit provider without a model',
    );
});

test('guardTeamToolDecision covers add_member, including blank-string fields', () => {
    const active = policy([DEEPSEEK]);
    assert.match(
        guardTeamToolDecision(teamExecution(TEAM_ADD_MEMBER_TOOL, { name: 'm', ...KIMI }), active),
        /agent_teams_add_member/,
    );
    assert.equal(
        guardTeamToolDecision(teamExecution(TEAM_ADD_MEMBER_TOOL, { name: 'm', ...DEEPSEEK }), active),
        undefined,
    );
    assert.match(
        guardTeamToolDecision(teamExecution(TEAM_ADD_MEMBER_TOOL, { name: 'm', provider: '  ', model: ' ' }, KIMI), active),
        /继承队长的路由 "kimi-coding\/k3"/,
        'blank fields behave exactly like omitted ones',
    );
});

test('guardTeamToolDecision judges only complete route replacements in edit_plan', () => {
    const active = policy([DEEPSEEK]);
    assert.match(
        guardTeamToolDecision(teamExecution(TEAM_EDIT_PLAN_TOOL, {
            operations: [{ action: 'update_member', member_name: 'm', ...KIMI }],
        }), active),
        /agent_teams_edit_plan/,
    );
    assert.equal(
        guardTeamToolDecision(teamExecution(TEAM_EDIT_PLAN_TOOL, {
            operations: [
                { action: 'update_member', member_name: 'm', model: 'k3' },
                { action: 'update_task', task_id: 't1', subject: 's' },
                { action: 'remove_member', member_name: 'm' },
            ],
        }), active),
        undefined,
        'half updates merge with the stored route, which the spawn gate re-checks',
    );
});

test('guardTeamToolDecision judges explicit routes without a calling agent and skips the rest', () => {
    const active = policy([DEEPSEEK]);
    const withoutAgent = (name, args) => ({ name, arguments: args });
    assert.match(
        guardTeamToolDecision(withoutAgent(TEAM_ADD_MEMBER_TOOL, { name: 'm', ...KIMI }), active),
        /白名单拦截/,
    );
    assert.equal(
        guardTeamToolDecision(withoutAgent(TEAM_ADD_MEMBER_TOOL, { name: 'm' }), active),
        undefined,
        'inheritance with no agent to resolve from is the spawn gate\'s call',
    );
});

test('guardTeamToolDecision stays inert while the whitelist is off or the call is foreign', () => {
    const off = policy([]);
    assert.equal(guardTeamToolDecision(teamExecution(TEAM_CREATE_TOOL, {
        name: 't', plan: { members: [{ name: 'm', ...KIMI }], tasks: [] },
    }), off), undefined);
    const active = policy([DEEPSEEK]);
    assert.equal(guardTeamToolDecision(teamExecution('subagent', { ...KIMI }), active), undefined);
    assert.equal(guardTeamToolDecision(teamExecution('agent_teams_status', {}), active), undefined);
    assert.equal(guardTeamToolDecision({ name: TEAM_CREATE_TOOL, arguments: undefined }, active), undefined);
    assert.equal(guardTeamToolDecision(undefined, active), undefined);
});

test('resolveGuardConfig accepts its documented values and fails loud on a typo', () => {    assert.deepEqual(resolveGuardConfig(undefined), { enabled: true, enforce: 'strict' });
    assert.deepEqual(resolveGuardConfig({}), { enabled: true, enforce: 'strict' });
    assert.deepEqual(resolveGuardConfig({ enabled: true, enforce: 'strict' }), { enabled: true, enforce: 'strict' });
    assert.deepEqual(resolveGuardConfig({ enabled: false }), { enabled: false, enforce: 'strict' });
    assert.throws(() => resolveGuardConfig({ enabled: 'yes' }), /`enabled` must be a boolean/);
    assert.throws(() => resolveGuardConfig({ enforce: 'warn' }), /`enforce` must be "strict"/);
});

test('the plugin exports the names the bundle patch and settings owner rely on', () => {
    assert.equal(NAME, 'subagent-model-guard');
    assert.equal(SETTINGS_NS, 'subagent-model-selection');
});
