# dsh-agent-teams-approval

> **从社区安装** · `dsh plugin --profile <profile> add dsh-agent-teams-approval`
> 或从源码：`dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-agent-teams-approval`
> 下文里的 `node scripts/install.mjs` 是**源码检出**时的本地安装：把包 `link:` 进你自己的 profile。

给 DSH 加一个开关：**AgentTeams 建队是否需要人工审批**。

- 开关位置：Web GUI →「设置 → 通用设置」→「AgentTeams 免审批执行」。
- 开关**开**：队长创建团队后**立即执行**，不再需要点击计划卡片上的「确认并启动团队」。
- 开关**关**（默认）：保持原有流程 —— 先出可编辑的 staged 计划，点「确认并启动团队」后才创建成员、调度任务。

本插件不修改 DSH 本体（`app.asar`）和 `@nanmicoder/dsh-agent-teams` 包，只通过宿主公开扩展点生效：
用户设置命名空间（`ctx.settings`）、系统提示段（`ctx.systemPrompt.section`）、工具守卫（`ctx.tools.guard`）、
`agent/pre-step` 监听、客户端槽位（`settings.general.item`）与 `ctx.settingsScope`。

---

## 1. 安装

前提：DSH 已能用 `desktop` profile 启动过（`~/.dsh/profiles/desktop/package.json` 存在），`dsh` 与 `pnpm` 在 PATH 上。

```powershell
cd plugins/dsh-agent-teams-approval
node scripts/install.mjs --profile desktop
```

脚本做的事：

1. 把插件宿主半需要的两个宿主包（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`）软链到本目录的 `node_modules/`
   （`link:` 安装的插件位于 profile 之外，这一步保证它的 import 一定解析得到）；
2. 备份 profile 的 `package.json` 为 `package.json.bak-agent-teams-approval`（只备份一次）；
3. 执行 `dsh plugin --profile desktop add link:<本目录绝对路径>`；
4. 校验依赖与 `dsh.profile.bundles` 是否都写进去了；
5. 用 `dsh --profile desktop --dump-config` 确认插件行真的被 bundle patch 插进了组合树（无需启动服务）。

先看看会做什么（不落盘）：

```powershell
node scripts/install.mjs --profile desktop --dry-run
```

## 2. 启用与验证

1. **重启 DSH Desktop**（宿主半在启动时加载）。
2. **硬刷新网页**（Ctrl+Shift+R）加载客户端半。
3. 打开「设置 → 通用设置」，应出现一行「AgentTeams 免审批执行」（标题 + 说明 + 开关，默认关闭）。
4. 打开开关，确认 `~/.dsh/settings.yaml` 出现：

   ```yaml
   agent-teams-approval:
     skipApproval: true
   ```

5. 新开一个会话，用自然语言让 AgentTeams 干活（或 `/agent-teams <目标>`）：
   - 开关**开**：不出现「待确认」计划卡片，也不需要任何点击；工具历史里是
     `agent_teams_create({ approval: "automatic", ... })`。
   - 开关**关**：出现计划卡片与「确认并启动团队」按钮。

## 3. 工作原理

宿主半（`lib/index.js` + `lib/logic.js`）：

| 部分 | 作用 |
|---|---|
| `ctx.settings.register('agent-teams-approval', { skipApproval: boolean = false })` | 持久化开关（写入 `~/.dsh/settings.yaml`），`scope.watch` 实时同步内存标志 |
| `ctx.systemPrompt.section({ order: 118 })` | 开关打开时追加一段覆盖说明，要求队长用 `approval="automatic"` 建队；关闭时返回空串（该段被丢弃，提示与未装插件时逐字相同） |
| `ctx.tools.guard(...)` | 开关打开时**硬拒绝** `approval: "required"` 的 `agent_teams_create`，理由里直接给出重试方式；这是唯一会走到「需要点击」的路径 |
| `ctx.on('agent/pre-step', ..., { prepend: true })` | 开关打开时，在 `/agent-teams` 注入的「用 approval=required、停下等审阅」指令之后追加一条纠偏消息，避免一次多余的被拒调用 |

客户端半（`lib/client.js`，手写的 `window.__ModuleLoader__` bundle）：

| 部分 | 作用 |
|---|---|
| `ctx.settingsScope.bind({ namespace: 'agent-teams-approval' })` | 读写同一个命名空间（带 revision 防覆盖，非 loopback 页面自动置灰） |
| `ctx.slots.register({ name: 'settings.general.item', id, order: 12, locale, inject })` | 在「通用设置」里注册一行；`hooks: { approval: scope }` 由渲染器转成 `useApproval(selector)` |
| `@deepseek-ai/dsh-client-ui-primitives` 的 `Switch` | 开关控件（仅使用 shell 的静态基线模块，无需 `dsh.client.external`） |

## 4. 卸载

```powershell
node scripts/install.mjs --profile desktop --uninstall
```

然后重启 DSH、硬刷新页面。如需彻底清掉设置项，可删除 `~/.dsh/settings.yaml` 中的
`agent-teams-approval` 段。插件源码目录可以保留（不再被引用）；如果想重新安装，再跑一次安装命令即可。

## 5. 已知边界

- **开关打开时不存在计划审阅步骤**：这是需求语义。想先看计划再执行，请把开关关掉（队长会告诉你这一点，而不会硬造一个 staged 计划）。
- **已存在的 staged 计划不受影响**：开关只作用于**新建**团队；已在等待确认的团队仍需你点一次「确认并启动团队」（或放弃后重建）。
- **开关切换即时生效**：提示段每次装配重新求值，代价是提示前缀变化会让该轮 KV 缓存失效一次。
- **非 loopback 页面**（远程访问）设置不可写，开关自动置灰 —— 这是 DSH 设置子系统的既有约束。
- **需要重启宿主**：新增插件行在启动时装配；`patchReload: live` 有时能热加载，但按「重启一次」验收。
- **目录不能随意移动**：profile 里记的是 `link:` 绝对路径，移动后请重新运行安装脚本。
- **宿主版本兼容**：若某天 `ctx.tools.guard` 不存在，插件会告警并退化为「只有提示覆盖」；AgentTeams 侧只要仍以 `approval === 'required'` 判定 staged，本方案就继续有效。

## 6. 开发

```powershell
node --check lib/index.js; node --check lib/logic.js; node --check lib/client.js
node --test
```

- `test/host.test.mjs`：开关取值、提示段文本、守卫判定、`agent/pre-step` 纠偏、`install()` 装配（含 settings 缺失、注册失败、宿主无 `guard` 三种降级）。
- `test/client-bundle.test.mjs`：bundle 注册 id、槽位注册参数、`settingsScope` 写入路径、开关行渲染（ready / loading / unavailable）。

`lib/logic.js` 不 import 任何 `@deepseek-ai/*`：两个宿主模块通过 `install(ctx, config, deps)` 注入，
所以整套判定逻辑可以脱离 DSH 运行时测试。
