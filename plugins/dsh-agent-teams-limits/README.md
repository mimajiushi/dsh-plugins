# dsh-agent-teams-limits

> **从社区安装** · `dsh plugin --profile <profile> add dsh-agent-teams-limits`
> 或从源码：`dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-agent-teams-limits`
> 下文里的 `node scripts/install.mjs` 是**源码检出**时的本地安装：把包 `link:` 进你自己的 profile。

给 DSH 加一个设置卡片：**AgentTeams 的成员上限**（一个团队最多几个人）和**并发上限**（同一团队最多几个成员同时干活）。

- 位置：Web GUI →「设置 → 插件 → 插件配置」→ 展开「Agent Teams 限制」。
- 两项都**留空 = 保持原样**：成员上限用 AgentTeams 自己的默认（8），并发不限。装完不改设置等于没装。
- 改设置**立即生效**，不需要重启 DSH、不需要刷新页面。

## 为什么需要这个插件

`@nanmicoder/dsh-agent-teams@0.1.20` 里 `maxMembers` 只是一个**组合配置的默认值**：

```js
// lib/index.js:84   配置模式
maxMembers: z.natural().min(1).default(8),
// lib/index.js:154  取值（apply 时快照；补丁前是 :111）
maxMembers: config.maxMembers ?? 8,
```

它管两处：`lib/profiles.js:194`（内联/配置 profile 的花名册人数，超了就是
`profile "inline-plan" has 10 members but maxMembers is 8`）和 `lib/tools.js:971`
（`agent_teams_add_member` 的人头闸；补丁前是 :965）。这个插件**没有注册任何 settings 命名空间**，
所以设置页面里本来没有这一项——只能手改 profile 的 `cordis.patch.yml`。

并发上限则是**上游根本没有的功能**：`lib/scheduler.js` 会把每个就绪任务直接派给每个空闲成员，
没有任何节流点、也没有对应配置字段。

## 怎么做到的（都不改第三方源码的配置语义）

宿主半（`lib/index.js` + `lib/logic.js`）：

| 缝 | 作用 | 出处 |
|---|---|---|
| 全局 `internal/config` 瀑布（`{ global: true }`） | 每次 AgentTeams 行被加载（含重启）时，把两个值注入它的 config。只改目标行，其它键原样保留；没配值时返回 `next()`，一个字节都不动 | 与 `dsh-compact-model` 同一条缝，本机宿主日志有实证 |
| 活体桥 `__limits`（本地补丁提供） | 改设置时直接改写已挂载实例的 resolved config。两个值都是**取用时刻读取**——`maxMembers` 由 tools 直接读 `resolved`，`maxConcurrentMembers` 由 scheduler 通过补丁加进 `installTeamScheduler` 调用点的**活体 getter** 读回 `resolved`——所以立刻生效；桥找不到时只告警一次并说明「下一次启动才生效」 | 主路径走 fiber 的 `runtime.callback.__limits`，兜底走 `globalThis[Symbol.for('dsh.agent-teams.limits')]` |
| `ctx.settings.register('agent-teams-limits', …)` | 持久化到 `~/.dsh/settings.yaml`，`scope.watch` 实时同步 | dsh 0.1.5 的用户设置服务 |
| `ctx.systemPrompt.section({ order: 119 })` | 配了值才追加一行「本机限制」，让队长不去撞墙；没配值返回空串（该段被丢弃，提示与未装插件逐字相同） | 118 是审批覆盖、117 是队长协议 |
| 客户端 `settings.plugin.item` 座位 + `ctx.settingsScope` | 卡片本体（数字输入），0.1.7 线改挂插件管理器的 `plugins.bundle.config` 座位 | 与 `dsh-llm-retry-all` / `dsh-compact-model` 同一套 |

**并发上限需要配套补丁**（成员上限不需要）：

```powershell
node scripts/patch-agent-teams-limits.mjs --apply
node scripts/verify-agent-teams-limits.mjs
```

补丁做五件事（可用 `--revert` 整段还原，备份后缀 `.bak-agent-teams-limits`；**从第一代补丁升级要先 `--revert`**）：

1. `lib/index.js`：配置字段 `maxConcurrentMembers`（默认 `0` = 不限）、`resolved` 透传、`__limits` 活体桥；
2. `lib/tools.js`：把 `installTeamScheduler` 的实参从**拷贝字面量**改成对 `resolved` 的**活体 getter**——这是并发闸能不能生效的关键（第一代补丁漏了这一步，scheduler 拿到的 config 里根本没有这个字段，闸恒为「不限」；2026-09-27 独立复审发现，`verify-agent-teams-limits.mjs` 的「负控制」用例就是钉这条）；
3. `lib/scheduler.js`：`memberCap` / `occupantHoldsSlot` / `holdsClaim` / `idleEdgePark` / `memberOccupiesSlot` / `activeMemberCount` + **fresh 认领前**的上限判定（恢复已有 attempt 永不拦；两类 park 分开看，见下）+ 空闲边界改用 `kickTeam` 补位 + 邮箱投递被闸不再吞掉整个回合；
4. `lib/tools.js`：`dispatchMember` 里对 `steer` 唤醒同样受上限约束——到上限时返回 `false`，这是上游自己的「现在不行」语义：**消息留在邮箱**，空位出现后重投，不丢消息（可能等一整个成员回合）。**被闸的那一轮不再整轮白等**：scheduler 会把 release 后的流程落到认领分支（那里的 cap 判定同样拒新任务，但**不会**拦已有 attempt 的 recovery）；
5. `lib/types/index.d.ts`：声明同步。

## 安装

```powershell
cd plugins/dsh-agent-teams-limits
node scripts/install.mjs --profile desktop --dry-run   # 先看规格
node scripts/install.mjs --profile desktop             # 实装
```

脚本把宿主半唯一运行时依赖 `@deepseek-ai/schemastery` junction 进本目录 `node_modules` →
备份 profile 的 `package.json` 为 `package.json.bak-agent-teams-limits`（仅首次）→
跑 `dsh plugin --profile desktop add link:<本目录>` → 复核 `dsh.profile.bundles` 与 `--dump-config` 里真有这一行。

装完**重启 DSH Desktop**（宿主半在启动时装配；补丁也是那时被 import 的）→ 硬刷新页面（Ctrl+Shift+R）。
卸载：`node scripts/install.mjs --profile desktop --uninstall`（`settings.yaml` 里的值保留但不再生效）。

## 验证

```powershell
node --test                                                # 33 项：纯逻辑 / 宿主装配 / 客户端卡片
node scripts/verify-agent-teams-limits.mjs --prove-gate  # 补丁闸门（含未修补基线的自证）
```

真机验收（重启后）：

1. 展开卡片，成员上限填 `16`、并发上限填 `2` → `~/.dsh/settings.yaml` 出现
   `agent-teams-limits: { maxMembers: 16, maxConcurrentMembers: 2 }`；
2. 宿主日志 `%APPDATA%\DSH Desktop\logs\host\dsh-<date>.log` 出现
   `recognised the AgentTeams row via entry-name` / `injected … at load time` / `live-applied … to N mounted AgentTeams instance(s)`；
3. 新会话让队长建一个 12 人的内联计划（`tasks: []`，不会真起 12 个子 Agent）→ 被接受；把上限调回 6 再试 → 被拒，错误里的数字变成 6；
4. 并发上限=1 + 3 成员 3 任务 → 一次 kick 只派 1 个（`agent_teams_status` 里同一时刻只有 1 个 `working`，其余 pending；前一个空闲后自动补位）。注意真机上子回合是**排队启动**的，所以「同一时刻」以任务/回合为准，日志里可能看到极短的重叠窗口。

## 边界

- **补丁会被插件升级覆盖**：升级 `@nanmicoder/dsh-agent-teams` 后重跑 `--apply` + 复核；没打补丁时，插件会在**重试窗口用尽后**告警一次「并发上限 inert」，成员上限仍会在下一次启动生效，不静默。启动早期（agent-teams 那一行还没挂载）**重试路径**不会误报；此时若你正好编辑设置，`scope.watch` 那条路径仍会立刻报一次「桥不存在」——那是真实状态（那一刻确实没有桥可用），不是 bug。
- **官方端（0.1.7 + agent-teams 0.1.21）本次不动**：patcher 只认 0.1.20 的锚点，版本不符直接拒绝，不猜改。
- 上限调小**不撤销已经在跑的成员**，下一次派发才按新值。
- **「占用一个并发位」的定义**：一个成员占位，当且仅当满足**任一**（`stopping` / `removed` 一律不计）：
  1. live AgentHandle 存在且不是 `idle`（真的在跑）；
  2. **握着 open claim**（该成员名下有 `claimed` / `in_progress` 的任务）**且这个 claim 不是「idle 边界 park」**——刚认领的成员投递只是排队，句柄那时还是 `idle`；少了这条信号整个 fan-out 会被一次放过（第二轮复审抓到），少了 park 的区分又会每恢复一个就多放一个（第三轮复审抓到）。`attemptId === undefined` 的 claim 保守计入。

  两类 park 必须分开看，靠 durable 状态区分（idle 边界会**同一步**把成员置成 `idle`）：
  - **idle 边界 park**（`syncMemberStatus`：回合结束、attempt 仍开）→ **不占位**，否则小上限会被卡死；
  - **recovery park**（`kickMember` 给换代 attempt 记账、成员仍是 `working`）→ **占位**，那一轮它确实要被投递。

  另外：句柄明确 `idle` **且**没有 open claim 的 `working`（漏了 idle 事件、重启残留）**不占位**；而「状态是 `idle` 但握着 claim 且没有 park 记录」（重启残留的任务）**占位**——上游下一次 kick 会 recovery 它，它真的会跑。对已在跑成员的 steer 不重复计数；正在停止（`stopping`）的成员不占位，所以上限可能被瞬时超过 1（它马上要退出）。
- **到上限时给空闲成员的消息会延后**：`steer` 唤醒同样吃并发位，被闸时消息 release 回邮箱、下一次 kick 重投（不会丢，但可能等一整个成员回合）；**满位时**该成员那一轮不会认领新任务，但会继续走认领分支（`fall-through`），所以它自己已开的 attempt 仍能被 recovery；一旦有空位，它就可能先认领任务、邮件稍后再投。
- **两条闸的细微差别（有意）**：任务认领闸用 `memberOccupiesSlot(..., parkedAttempts)`（带 park 账本）；`steer` 闸在 `tools.js` 里没有那份账本，因此把「已 park」也算占位——方向是**保守**（只会让某条消息多等一会儿，不会超发，也不会丢消息）。
- 提示段只在配了值时出现，改值会让该轮 prompt 前缀缓存失效一次（与同族插件相同代价）。
- 非 loopback 页面设置只读，卡片自动置灰——DSH 设置子系统的既有约束。
