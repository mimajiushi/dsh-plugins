---
name: dsh-workspace-changes
description: 右侧栏「变更」面板：像 IDE 一样查看当前工程的 git 变更（分组变更树 + 完整 diff 视图 + 复制 diff + 在 IDE 打开）。对仓库只读。
---

# dsh-workspace-changes

> **从社区安装** · `dsh plugin --profile <profile> add dsh-workspace-changes`
> 或从源码：`dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-workspace-changes`
> 下文里的 `node scripts/install.mjs` 是**源码检出**时的本地安装：把包 `link:` 进你自己的 profile。

在 DSH 右侧栏提供一个 IDE（JetBrains Commit 工具窗）风格的「变更」tab：

- **分组变更树**：`冲突` / `更改`（tracked，相对 HEAD 的暂存+未暂存合并视图）/ `未跟踪文件`，组内按目录再分组，组头带文件计数；
- **diff 视图**：统一 ⇄ 双栏对照切换、双列行号、hunk 折叠、`‹ 3/14 ›` 文件导航、复制 diff、在 IDE 打开（可定位到点击行）；
- **窄栏下钻、全屏分栏**：侧栏正常宽度时列表 ⇄ diff 下钻；面板全屏（框架自带切换）时左树右 diff；
- **即时刷新**：agent 写文件（fs/observed）即刻推送 + 30s 轮询兜底 + 手动刷新 + 切回标签页时刷新。

## 安全边界（只读契约）

- 宿主只执行 `git status` / `git diff` / `git rev-parse` 只读命令与一次分离的编辑器启动；**没有**暂存、丢弃、提交或任何写操作；
- 路由仅 loopback；工作区门禁要求请求路径 realpath 后精确等于某个已注册工作区；
- 未跟踪文件的内容读取先经 `git status` 范围探针复核，防止借路由读任意宿主文件；
- 「在 IDE 打开」的文件路径被限制在工作区之内。

## 配置（cordis.patch.yml）

```yaml
config:
  editor: auto        # auto（检测到 VS Code 则用 code -g，否则系统默认关联）| system | 自定义 id
  editors:            # 自定义编辑器命令模板；{file} 与 {line} 会被替换
    - id: idea
      label: IntelliJ IDEA
      command: '"C:\\Tools\\idea64.exe" {file}'
  maxDiffBytes: 1048576      # 单文件 diff 输出上限
  maxUntrackedBytes: 262144  # 未跟踪文件内容读取上限
  pollIntervalMs: 30000      # SSE 存活期间的轮询间隔（下限 10s）
```

## 安装 / 卸载

```powershell
node scripts/install.mjs --profile desktop
node scripts/install.mjs --profile desktop --uninstall
```

装完**重启 DSH Desktop**（宿主路由随启动装载）并硬刷新页面（Ctrl+Shift+R）。

## 文件结构

- `lib/index.js` — 宿主入口（inject / Config / apply）
- `lib/host/git.js` — git runner（subprocess 服务，win32 直启 git.exe，输出帽与 deadline）
- `lib/host/status.js` — porcelain v2 + numstat 解析 → 分组模型
- `lib/host/diff.js` — unified diff 结构化解析 + 未跟踪文件全增 diff 合成
- `lib/host/editors.js` — IDE 检测与打开命令构建
- `lib/host/routes.js` — /changes/* 路由（门禁、信封、SSE）
- `lib/client.js` — 全部 UI（手写 bundle，仅 require 渲染端种子模块）
- `test/` — 解析器、路由围栏、客户端注册形状与纯函数（node --test，含真实 git 集成）

## 验证

```powershell
node --test test/status-parse.test.mjs test/diff-parse.test.mjs test/routes.test.mjs test/client.test.mjs
```
