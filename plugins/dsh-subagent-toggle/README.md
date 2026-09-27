# dsh-subagent-toggle

> **从社区安装** · `dsh plugin --profile <profile> add dsh-subagent-toggle`
> 或从源码：`dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-subagent-toggle`
> 下文里的 `node scripts/install.mjs` 是**源码检出**时的本地安装：把包 `link:` 进你自己的 profile。

DeepSeek Harness 插件：在「设置 → 插件 → 插件配置」里提供一个 **Subagent 开关**。关闭后，模型再调用任何能创建或唤醒子 Agent 的工具，都会立即收到一条错误提示，引导它改用 **Agent Teams**。

## 行为

开关关闭时，以下工具调用被拦截（模型读到 `Error: <提示>`，不会创建或唤醒任何子 Agent）：

| 工具 | 为什么拦 |
|---|---|
| `subagent` / `subagent_fork` / `subagent_<provider>` | 直接创建子 Agent（委派家族） |
| `workflow` | 引擎内部按 `agent()` 逐个直调 `subagents.start` |
| `ralph` | 每轮 fresh agent |
| `list_subagent_models` | 只为委派服务的发现入口 |
| `send_message` | 能唤醒空闲/就绪的子 Agent 开新回合 |

明确**放行**：

| 工具/机制 | 为什么放行 |
|---|---|
| `agent_teams_*` 全部 | Agent Teams 就是提示文案推荐的替代品，必须可用 |
| `list_agents` | 只读查看遗留子 Agent |
| `interrupt_agent` | 叫停遗留子 Agent；关掉它等于让残留子 Agent 无法停止 |
| Mnemon 记忆内部委派（idle 整理、recall 回答、写回、归档） | 宿主基础设施，不是模型面向的 subagent 能力 |
| goal 轮次 | 同会话续跑，不创建子 Agent（已核实 `dsh-tool-goal` 不用 subagents 服务） |
| 任务看板 | Host 侧会话级执行，不用 subagents 服务（已核实） |

提示文案（模型可见）大意：「subagent 能力已被用户在设置中关闭……请改用 Agent Teams：`agent_teams_create`（`approval: "automatic"`）→ `agent_teams_add_member` → `agent_teams_create_task`……团队成员请用 `agent_teams_send_message` 联系队长；`interrupt_agent` 仍可停止遗留子 Agent。恢复：设置 → 插件 → 插件配置 → Subagent 开关。」

## 机制

- **唯一拦截层是 `ctx.tools.guard`**（`@deepseek-ai/dsh-tools` 的单调拒绝钩子，同步函数返回字符串即拒绝，注册表把拒绝文本包装为 `Error: ...` 的错误工具结果）。本机全量扫描确认：模型可达的 subagent 入口全部是注册表里的工具（含 PTC/`run_code` 模式——SDK 调用仍过同一注册表），因此工具层 guard 覆盖 100% 的模型入口。
- **刻意不包 `ctx.subagents.start` / `startContinuable`**：AgentTeams 经 `startContinuable` 派成员（label 前缀 `agent-teams:`），Mnemon 记忆系统的内部委派也走同一服务。在这一层拦会把替代品和记忆系统一起掐死。已用户确认不装兜底层。
- **设置即读即生效**：guard 每次调用现读 `settings.register` 返回 scope 的 `get()`（实时解析值），拨动开关后下一次工具调用就按新状态判定——不重启、不新建会话。
- **只有显式 `enabled: false` 才是关**：命名空间缺失、settings 服务缺席、section 畸形，一律视为开（惰性，绝不锁死可用部署）。
- **设置命名空间没有 `validate` 钩子**：宿主侧 validate 拒绝会被客户端 scope 控制器静默 recover（不抛错、不落盘、无日志），曾导致兄弟插件的写入无声消失。校验只交给 schema。`test/host.test.mjs` 有一条断言钉死 `validate === undefined`。
- **客户端写入回验**：`scope.set` 对拒绝永远 resolve，所以卡片写完从 `snapshot.user`（原始用户层）读回比对，不一致就在卡片上显示红色「写入失败」并 `console.error`。相等时不发写（no-op 写入在宿主侧彻底无痕，会表现得像控件坏了）。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/logic.js` | 零依赖纯逻辑：工具名匹配、策略解析、拒绝文案、config 校验 |
| `lib/index.js` | 宿主壳：注册设置命名空间 + 一个工具 guard |
| `lib/client.js` | 设置卡片（PluginCard 镀铬复刻 + primitives 的 `Switch`） |
| `cordis.patch.yml` | bundle 补丁；`config.extraBlockedTools` 可调整附加拦截清单 |
| `scripts/install.mjs` | 安装 / `--uninstall` / `--dry-run` / `--dump-config` 复核 |
| `test/` | logic 27 条、host 13 条、client 13 条 |

## 安装

```powershell
cd plugins/dsh-subagent-toggle
node scripts/install.mjs --profile desktop     # 装（link: 依赖 + dsh.profile.bundles，含 .bak 备份）
node scripts/install.mjs --profile desktop --uninstall
node --test test/*.test.mjs                    # 全部单测（不需要 DSH）
```

装完必须**完全退出并重启 DSH Desktop**（宿主半在启动时装载，客户端字节被宿主缓存，生产构建无 watcher），再硬刷新页面（Ctrl+Shift+R）。

## 验证

1. 设置 → 插件 → 插件配置 → 出现「Subagent 开关」卡片。
2. 关闭开关，`%USERPROFILE%\.dsh\settings.yaml` 出现 `dsh-subagent-toggle: { enabled: false }`。
3. 任意会话让模型「派一个 subagent 做 X」：调用失败，错误文本引导 Agent Teams；`workflow`、`send_message` 同样被拒。
4. `agent_teams_create` 正常建团队；`list_agents` 正常列出。
5. 重新打开开关，`subagent` 恢复可用（立即生效，无需重启）。

## 边界

- 与 `dsh-subagent-model-guard` 互不干扰：两者各注册各的 guard，任一拒绝即拦截。
- 开关是全局的（所有会话、所有 preset）；AgentTeams 成员调用被拦工具同样被拒（提示文案已指引成员用 `agent_teams_send_message`）。
- 被拦工具仍在 wire 上可见，只在调用时拒绝——这是设计目标（让模型收到指引），不是隐藏工具。
- 第三方插件若新增「不经过工具注册表」的创建路径，本插件不防（兜底层已被明确放弃）。
