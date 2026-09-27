---
description: "DSH Web 插件：让「计划待审」(plan review) 卡片可以在右侧栏显示，操作按钮跟着走，并支持在主对话与侧边栏之间来回切换。"
---

# dsh-plan-card-sidebar

> **从社区安装** · `dsh plugin --profile <profile> add dsh-plan-card-sidebar`
> 或从源码：`dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-plan-card-sidebar`
> 下文里的 `node scripts/install.mjs` 是**源码检出**时的本地安装：把包 `link:` 进你自己的 profile。

> 计划卡片（`计划待审`）现在有两个家：主对话（默认，原样）和右侧栏（新）。卡片条带上多一个「侧边栏」按钮，点一下卡片连同三个操作按钮一起搬进右侧栏；侧边栏里的卡片则显示「切回主对话」，点一下搬回来。

## 它做什么

- **默认行为不变。** 计划卡片的默认位置仍然是主对话 composer 区，尺寸与样式与原来一致（同一套 `gtAFBG_*` 类名、同样的 `--dsh-composer-side-clearance` 边距与最大宽度）。
- **多一个切换按钮。** 主对话里的卡片条带右侧新增一个描边小胶囊按钮「侧边栏」（`IconPanelLeftOutline16` + 文案），点击后：
  - 卡片作为「计划待审」tab 出现在右侧栏（与文件/浏览器等 tab 并列，支持浮动窗、分栏、拖动）；
  - 主对话原位置换成一条窄状态条：计划标题 + 「计划卡片已在右侧栏打开，按钮也在那边」 + 「切回主对话」按钮。
- **三个操作按钮全部在侧边栏。** 「去聊天里说」「拒绝」「确认执行」都在侧边栏卡片底部，点击行为与主对话完全一致（同一个 pending-question 载体：`pending.answer({answers:[...]})` / `pending.cancel()`）。点「去聊天里说」还会把焦点交还 composer 输入框。
- **切回来。** 侧边栏卡片条带上的「切回主对话」把卡片收回主对话，并关掉那个 tab（仅当该 tab 正显示且侧边栏展开时；否则只解除绑定，避免把整列侧边栏拍掉）。
- **手关 tab 也自愈。** 直接点 tab 上的 × 关掉侧边栏卡片时，卡片会自动回到主对话显示（靠 tab 正文卸载检测，不依赖被隐藏/分栏影响的可疑状态）。
- **处理完不拍掉侧边栏。** 在侧边栏点「确认执行 / 拒绝 / 去聊天里说」后，主对话立即恢复为正常输入框，而侧边栏 tab 保留并显示「这张计划卡片已经处理完毕。」——点击关于计划，不该顺手关掉你的布局。
- **只碰计划卡片。** 别的提问卡片、别的 composer 接管（审批、其它 question 流）完全不受影响。

## 实现要点（为什么不用改 DSH 源码）

| 机制 | 说明 |
|---|---|
| `conversation.composer` 是 **chain** slot | chain 按 priority **升序**取第一个 `select()` 非 null 的条目；core 的 `ui-user-questions` 在默认 priority `0`。本插件注册在 `-1`，因此先被询问，且只认领 `kind === 'plan-review'` 的请求；其它一律返回 `null`，原样交回 core。**没有禁用任何插件，没有 patch 任何文件。** |
| 侧边栏走官方扩展席位 | `ctx.sidebarRightTabs.register({id, kind, priority:'extension', title, guide})` 注册 tab 类型，`ctx.slots.register({name:'sidebar.right.pane.tab', key})` 注册正文，导航用 `ctx.sidebarRight.openTab/close/active/isExpanded/toggleExpanded`。tab 打开时把 render key 写进 `options.params.reviewKey`；正文按 **`params.reviewKey` → 唯一 dock 记录** 两级解析——从侧边栏「+」指南打开的 tab 不带 params，回退到唯一 dock 记录（core 的 guide 打开路径无 params，改不了，兜底是必须的）。⚠️ **guide 条目的 `title`/`description` 必须是函数**（`() => string`）：core 引导页（「开始」默认页）的 `EntryBox` 直接 `entry.title()` / `entry.description?.()` 调用它们，传字符串会抛 `entry.title is not a function` 并让整个引导页正文空白（2026-09-25 修过一次，回归断言已钉在测试里）。 |
| 两边同一个决策载体 | 按钮直接调用 pending 载体的 `answer`/`cancel`，所以无论卡片画在哪里，语义与结果都一致。 |
| 状态只在内存 | 「卡片在侧边栏」按 pending 载体的 render key 记在模块级 Map 里，不落盘、不写 host。刷新页面回到主对话显示——与侧边栏自身状态（同样只在内存）一致。 |

### 已知耦合（维护者注意）

主对话里的卡片是按 core `PlanReviewPanel` 的**结构**复刻的，并复用它的编译后类名（`.gtAFBG_strip/_body/_footer/_actions/_discuss/_feedback`，由 `dsh-client-ui-user-questions` 注入到页面）。好处是外观逐像素一致、无需重建；代价是 core 若大改卡片 DOM 结构，需要同步 `PlanReviewCard`（`lib/client.js` 里只有一处定义，侧边栏与主对话共用）。

## 安装

```powershell
# 1) 先干跑看一眼要动什么
node scripts/install.mjs --profile desktop --dry-run

# 2) 真装（会 pnpm add link:...，并把包名并入 dsh.profile.bundles）
node scripts/install.mjs --profile desktop
```

脚本会：

1. 把 `@deepseek-ai/dsh-client-ui-sidebar-right`、`@deepseek-ai/dsh-client-ui-primitives` 链接进本插件的 `node_modules`（`link:` 安装的包在 profile 树之外，宿主需要从这里解析）；
2. 备份 `~/.dsh/profiles/desktop/package.json` 为 `package.json.bak-plan-card-sidebar`（只备份一次）；
3. 执行 `dsh plugin --profile desktop add link:<本目录>`；
4. 校验 `dependencies` 与 `dsh.profile.bundles` 都包含本插件，并用 `dsh --profile desktop --dump-config` 复核组合树里真的有这一行；
5. 打印重启与验证步骤。

**重启 DSH Desktop 后，硬刷新页面（Ctrl+Shift+R）** 才会加载浏览器半侧。

### 卸载

```powershell
node scripts/install.mjs --profile desktop --uninstall
```

## 验证

**已经做过的（无需重启）**

```powershell
node --check lib/client.js            # 语法
node --test "test/*.test.mjs"         # 13 项：模块图、chain 优先级、只认领 plan-review、切换/回切语义、正文两级解析
node scripts/install.mjs --profile desktop --dry-run
dsh --profile desktop --dump-config | Select-String ui-user-questions, ui-sidebar-right
```

最后一条确认了本插件依赖的两个席位提供方（`ui-user-questions` 的 `conversation.composer` chain、`ui-sidebar-right` 的侧边栏服务）确实在组合树里。

**还要你在重启后手工确认的**（浏览器里的事，脚本验不了）：`/plan` 进入计划模式 → 让 agent 用 `exit_plan_mode` 提交计划 → 卡片条带上出现「侧边栏」→ 点击后右侧栏出现「计划待审」tab、主对话变成窄状态条 → 在侧边栏点「确认执行」→ 计划模式退出、侧边栏 tab 变成「这张计划卡片已经处理完毕。」

## 目录

| 路径 | 作用 |
|---|---|
| `lib/client.js` | 浏览器半侧（手写 bundle，走 `window.__ModuleLoader__.load`）：侧边栏 tab 类型、两个席位、composer 席位、切换逻辑 |
| `lib/index.js` | 宿主半侧：空 `apply`，只为让插件出现在宿主 Loader 名册里 |
| `cordis.patch.yml` | bundle patch：向 profile 名册 `insert` 一行 `plan-card-sidebar` |
| `scripts/install.mjs` | 安装/卸载/干跑 |
| `test/` | Node 原生测试 + 加载 bundle 的测试夹具 |

## 限制

- **一次只有一张卡片在侧边栏。** 侧边栏 tab 是单例（按 kind 去重），同一时刻只展示一张待审计划；同时存在多个待审计划时，先切换的那张占位，其余留在主对话。
- **只在当前会话生效。** 如果卡片属于屏幕外的会话，切换会被拒绝并提示，不会把侧边栏切到别的会话。
- **刷新后回到主对话。** 侧边栏自身的 tab 状态本来就不持久化（官方限制），本插件与之保持一致，不额外落盘。
- **文案目前只有中文**，与 core 的 `question` 命名空间文案对齐（`计划待审`/`确认执行`/`拒绝`/`去聊天里说`）。
