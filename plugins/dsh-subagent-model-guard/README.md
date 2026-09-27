# dsh-subagent-model-guard

> **从社区安装** · `dsh plugin --profile <profile> add dsh-subagent-model-guard`
> 或从源码：`dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-subagent-model-guard`
> 下文里的 `node scripts/install.mjs` 是**源码检出**时的本地安装：把包 `link:` 进你自己的 profile。

DSH Host 侧插件：让 **subagent**、**Agent Teams**，以及任何其它子 Agent 的创建，都只能使用
`subagent-model-selection` 白名单里的模型。

## 它修的是什么

`settings.yaml` 里的白名单：

```yaml
subagent-model-selection:
  enabled: true
  allowedModels:
    - provider: deepseek-official
      model: deepseek-flash
```

在官方 Harness 里只有**一处**会校验它——`@deepseek-ai/dsh-tool-subagent` 内部的
`assertAllowedModelSelection()`。于是有两条绕过路径：

1. **Agent Teams 不过这个工具。** `@nanmicoder/dsh-agent-teams` 的 `spawnMember()` 直接调用
   `ctx.subagents.startContinuable()`，并把算好的 `agentOptions: { provider, model, reasoningEffort }`
   放进请求。成员模型可以来自 `agent_teams_*` 的 `provider`/`model`/`reasoningEffort`、
   roster profile，或"继承队长当前路由"——全程不经过 `subagent` 工具，因此不校验。
2. **纯继承不触发校验。** 官方守卫的第一行就是 `if (policy === void 0 || !hasDelegationModelRequest(request)) return;`。
   只要调用方不显式写 `provider`/`model`，子 Agent 直接继承父 Agent 的路由——即使那条路由不在白名单里。

本插件把白名单校验挪到**唯一创建子 Agent 的操作**上：`ctx.subagents.start` /
`ctx.subagents.startContinuable`。所有创建路径（`subagent`、`subagent_fork`、
`agent_teams_*`、`workflow`、`ralph`）都经过这两个方法，因此没有旁路。

## 行为

白名单启用时（`enabled: true` 且至少一条可用 route），以下所有情况都会被**拒绝并返回错误**：

- 显式指定了不在白名单里的 `provider`/`model`（来自工具参数、roster profile 或 profile 默认值）；
- 只显式给了一半字段，合并队长路由后得到的最终路由不在白名单里；
- 什么都不指定、直接继承队长路由，而队长的当前路由不在白名单里。

拒绝时：

- **不创建任何子 Agent**（校验发生在创建的调用之前，是硬保证）；
- 错误文本包含被拒路由、**全部可用模型**、`list_subagent_models` 提示，以及应该去哪个设置页改白名单：

  ```
  subagent 模型白名单拦截：subagent 工具（provider "spawn"） 被拒绝，未创建任何子 Agent。
  原因：路由 "kimi-coding/k3" 不在白名单内。
  当前允许的模型（1 个）：
    - deepseek-official/deepseek-flash
  请把 `provider` 与 `model` 改成上面之一（用 `list_subagent_models` 可查看每个模型的 reasoning effort），
  或在「设置 → 插件 → subagent-model-selection」里加入该模型。
  ```

白名单未启用（`enabled: false`、列表为空、或该设置命名空间根本没注册）时，插件**完全惰性**，
行为与不装插件时一致。

### 两层拦截

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 1（权威） | `ctx.subagents.start` / `startContinuable` | 覆盖所有创建路径，是唯一真正的闸门 |
| 2（早反馈） | `ctx.tools.guard` | 对 `subagent` / `subagent_fork` / `subagent_codex` / `subagent_claude_code` 的显式越界请求在调用前就报错；对 `agent_teams_create` / `agent_teams_add_member` / `agent_teams_edit_plan` 在**写团队记录之前**按成员最终路由（显式值缺省回退队长当前路由）判定，越界即整单拒绝并列出完整白名单 |

第 2 层只校验 `provider`/`model`，**不校验 `reasoning_effort`**：effort id 属于具体模型的能力，
官方由 LLM runtime 校验，本插件不在工具层重复实现。

### AgentTeams 创建时拦截（2026-09-24 起）

AgentTeams 的成员路由在**创建时**就被快照进团队记录（`resolveMemberLlmSelection`：显式
provider/model ?? 队长当前路由），而创建本身不产生子 Agent——所以仅靠第 1 层时，越界 roster
要等首个任务派发才 `start failed`，团队直接卡死。第 2 层因此在三个写成员路由的工具上提前拦截：

- `agent_teams_create`：逐个判定 `plan.members[]` 的最终路由，任一越界整单拒绝；
- `agent_teams_add_member`：判定本次的 provider/model（缺省即继承队长路由）；
- `agent_teams_edit_plan`：判定 `update_member` 中**完整**的 provider+model 替换。

两个有意的近似（仍由第 1 层 spawn 闸门兜底，不会漏放）：

- `agent_teams_create` 用 `profile`（无内联 plan）时，roster 在工具内部从 profile 文件展开，
  守卫看不到，创建时不拦，成员 spawn 时由第 1 层拒绝；
- `update_member` 只改路由的**一半**时，另一半合并的是成员已存路由（守卫不读团队状态文件），
  此类半更新不在工具层判定，spawn 时由第 1 层拒绝。

另外：本部署未配置 agent-teams 的 `memberModel` 默认值，"成员缺省 model = 队长当前 model"的
继承解析与实际完全一致；若未来配置了 `memberModel`，缺省 model 的成员在工具层按队长 model
判定，可能与实际不符——届时以第 1 层为准。

想在建成员前确认模型是否被允许，可用 `list_subagent_models` 查看可用组合。

## 严格模式的连带效果（重要）

`enforce: strict` 意味着**最终路由**必须在白名单里，因此：

- **队长自身的模型也必须白名单内**。Agent Teams 成员总是带着解析后的 `agentOptions`
  （等价于"显式选择"），所以队长跑在 `kimi-coding/k3` 而白名单只有 `deepseek-flash` 时，
  `agent_teams_create` / `agent_teams_add_member` 会在创建时直接被第 2 层拒绝（错误文本列出
  完整白名单）；即便绕过了工具层，成员 spawn 时也会被第 1 层拦下。
- 想同时用多个模型，就都加进 `allowedModels`（可以在「设置 → 插件 → subagent-model-selection」里改，
  也可以直接编辑 `~/.dsh/settings.yaml`）。
- 白名单是**实时读取**的：改动立即影响下一步决策，包括 AgentTeams 成员的冷恢复。若在成员存在期间
  收紧白名单，成员恢复会报错而不是静默换模型——这是有意的。

## 安装

先安装到当前活动 profile（本机是 `desktop`），再做两处改动。

### 1. 登记到 profile

编辑 `~/.dsh/profiles/<profile>/package.json`（Windows：`C:\Users\<你>\.dsh\profiles\desktop\package.json`）：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // …已有的 bundle…
        "dsh-subagent-model-guard"   // ← 追加
      ],
      "patchReload": "live"
    }
  },
  "dependencies": {
    // …已有的依赖…
    "dsh-subagent-model-guard": "link:C:/Users/<你>/Desktop/dsh-plugins/dsh-subagent-model-guard"  // ← 追加
  }
}
```

### 2. 建 node_modules 联接

在 `<profile>/node_modules/` 下建一个指向本目录的目录联接（等价于 pnpm 的 `link:`）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-subagent-model-guard" `
  -Target "$PWD"
```

`scripts/install.mjs` 会打印这两处改动并检查联接是否存在（只读，不直接改 profile）：

```powershell
node scripts/install.mjs --profile desktop
```

### 3. 重启 DSH

插件是纯 Host 插件（没有 `dsh.client`），因此不涉及浏览器 bundle，只有 Host 需要重启。
本插件**不修改任何 Harness 内置包**，也不需要动 `app.asar`。

### 回滚

还原 profile 的 `package.json`（安装时会留下 `package.json.bak-subagent-model-guard`），
删掉 node_modules 里的联接，重启即可。或者在 `cordis.patch.yml` 里把 `config.enabled` 设为 `false`。

## 配置

`cordis.patch.yml` 的行配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时插件完全不安装（不包裹 runtime、不注册 tool guard） |
| `enforce` | `"strict"` | 目前唯一支持的模式；写成别的值会**启动即报错**，而不是静默降级 |

白名单本身**不在这里配置**——它是唯一真源，由 `subagent-model-selection` 设置段（属于
`@deepseek-ai/dsh-tool-subagent`）拥有，Web UI 和 `settings.yaml` 都能改。

## 测试

```powershell
cd plugins/dsh-subagent-model-guard
node --test
```

`test/logic.test.mjs` 覆盖全部纯决策规则；`test/host.test.mjs` 用假的 `SubagentRuntime`
和假 ctx 验证包裹、透传、拒绝（原方法未被调用）、还原、幂等与容错。
两套都不需要 DSH 运行时。

## 已知边界

- 不会、也不能修改 `app.asar` 里的内置守卫；本插件与它叠加：内置守卫先拦显式越界，
  本插件再兜住 Agent Teams 与纯继承。
- `tools.guard` 只在注册了工具的会话/作用域生效；权威拦截始终是 runtime 那一层。
- 冷恢复已有成员时会重新过闸门；若届时白名单收紧，恢复会失败并报错。
- AgentTeams 成员路由在创建/加人/改计划时由第 2 层提前拦截；profile 展开的 roster 与
  `update_member` 半更新是两个有意的例外，仍由第 1 层在 spawn 时兜底（见上文时机说明）。

## 实测验收记录（2026-09-19，本机 desktop profile）

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 插件挂载 | 宿主日志出现 `[subagent-model-guard] … refused to create a child … route kimi-coding/k3 is not in the "subagent-model-selection" whitelist (not-whitelisted)`，证明已加载并登记 |
| 2 | `subagent` 白名单内（`deepseek-official/deepseek-flash`） | 放行，返回 `GATE-ALLOW-OK` |
| 3 | `subagent` 越界（`kimi-coding/k3`） | 被第 2 层拦下，返回完整白名单报错，未创建子 Agent |
| 4 | Agent Teams 白名单内成员 | 建团 + 加成员成功，成员实际运行在 `deepseek-official/deepseek-flash` |
| 5 | Agent Teams 越界成员（`kimi-coding/k3`） | 加成员先返回成功（惰性 spawn），首个任务派发时被第 1 层拦下：成员行显示 `start failed: Error: subagent 模型白名单拦截：continuable 子 Agent（provider "spawn"）…`，堆栈指向本插件 `gateDelegation`，成员保持 `unspawned`，零子会话 |
| 6 | Agent Teams 创建时拦截（2026-09-24 起） | `agent_teams_create` / `agent_teams_add_member` / `agent_teams_edit_plan` 的越界 roster 在写团队记录前被第 2 层整单拒绝，错误文本列出完整白名单；旧团队（白名单收紧前已建）不受影响，仍由第 1 层在 spawn 时把关 |
