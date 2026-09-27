# dsh-llm-retry-all

> **从社区安装** · `dsh plugin --profile <profile> add dsh-llm-retry-all`
> 或从源码：`dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-llm-retry-all`
> 下文里的 `node scripts/install.mjs` 是**源码检出**时的本地安装：把包 `link:` 进你自己的 profile。

DSH 宿主插件：**模型网关的所有错误统一重试**。

- 内置 `@deepseek-ai/dsh-llm-retry` 只重试 5 种瞬时错误码（429/5xx/超时/断网/空响应）且每提供方最多 5 次；没额度（QUOTA）、鉴权失败（AUTH）等直接失败。compact 的摘要调用直连 `ctx.llm.stream()`、完全不经重试链，一出错 compact 失败、任务停止。本插件补齐这两块。
- 重试策略：第 n 次重试等待 `min(n × 5s, 300s)`（线性 +5s 累加，封顶 5 分钟）；provider 的 Retry-After 若更长则取它，但仍硬顶 5 分钟。
- 上限默认 **10000** 次，在 设置 → 插件 → 插件配置 →「模型重试（网关全错误）」调节；**0 = 关闭本插件**（内置默认 5 次重试保留）。
- 永不重试的两类：`ABORTED`（用户主动取消）与 `CONTEXT_WINDOW_EXCEEDED`（上下文溢出交给 compaction-basic 做压缩恢复，盲重试无意义）。
- compact（三条触发路径，`purpose: "compaction"`）、session-title（`purpose: "session-title"`）等直连 `ctx.llm.stream()` 的辅助调用：整段缓冲、失败即整段重开（重进完整 `llm/stream` waterfall），成功才一次性放出——因此摘要/标题只在完成时呈现，与现状一致。**直连调用按 `purpose` 标签识别**（agent-loop 请求从不携带 purpose），而不是 `@deepseek-ai/dsh-llm` 的 `isAgentLoopRequest`：那是进程内 WeakSet 身份检查，宿主从 app.asar 加载 dsh-llm、link 安装的插件解析自己的物理副本，两个模块实例导致该检查在生产环境恒为 false（2026-09-24 用应用自带 Electron 探针实测确认），会把主对话流也整段缓冲。因此本插件不 import dsh-llm。
- 主对话请求的重试通过 prepend 的 `agent/request-error` 监听器实现，写入与内置插件同构的 `llm/retry` / `llm/retry-started` 会话事件，聊天界面的重试卡片照常显示进度。

## 安装 / 卸载

```sh
node scripts/install.mjs --profile desktop     # 安装
node scripts/install.mjs --profile desktop --uninstall
```

装/卸后**必须完全重启 DSH Desktop**（宿主在 compose 时缓存插件字节），并硬刷新页面（Ctrl+Shift+R）。

## 测试

```sh
node --test test/*.test.mjs
```

## 范围外

web_search / web_fetch 工具自身的网络错误（不走模型网关）、MCP、插件中间件抛出的程序性错误（保持抛出）。
