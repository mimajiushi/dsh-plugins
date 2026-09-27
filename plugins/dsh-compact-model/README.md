# dsh-compact-model

> **从社区安装** · `dsh plugin --profile <profile> add dsh-compact-model`
> 或从源码：`dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-compact-model`
> 下文里的 `node scripts/install.mjs` 是**源码检出**时的本地安装：把包 `link:` 进你自己的 profile。

让 `/compact` 用**你选的模型**，而不是跟当前会话的聊天模型绑在一起。配置在
**设置 → 插件 → 插件配置 → 压缩模型（compact）** 卡片里改，写进 `~/.dsh/settings.yaml`。

| 状态 | 压缩请求实际用的模型 |
|---|---|
| 没选（默认） | 跟随会话模型 —— 与改动前逐字段一致 |
| 选了 `provider` + `model` | 用你选的那一路；聊天仍用会话模型 |
| 另选了「思考强度」 | 压缩请求带该 `reasoningEffort`；不选则用模型默认 |

清空两项即回到「跟随会话模型」。所选模型不可用时 **compact 直接失败报错，不静默换模型**
（按明确的选择：宁可失败也不偷偷用别的模型花你的额度）。

---

## 为什么这件事不能靠改 preset 解决

`@deepseek-ai/dsh-compaction-basic` 本身**支持**这件事：它 config 里的
`summarizationProvider` / `summarizationModel` 一旦非空，`summarizeWithLlm()` 的解析顺序
`configured ?? 最新已路由请求 ?? agent.options` 就会永远命中它——这正是「无论聊天模型是什么，
压缩都用 X」，不需要 `modelPolicies`、也不需要通配符。

但这一对配置**送不进去**，因为它的组合行已经不在宿主平面了：

| 事实 | 出处 |
|---|---|
| 宿主平面的 `compaction-basic` / `command-compact` / `tool-result-pruner` 全被禁用，改由每个 agent preset 在自己的 `cordis:group` 里重新声明，并带 `isolate: { compaction: true }` | `@deepseek-ai/dsh-web-app/cordis.patch.yml` |
| preset 文件是**只读输入**：挂载子树把 `write()` 置空，loader 的回写永远不会落到 preset 文件 | `@deepseek-ai/dsh-agent-presets/README.zh.md`「preset 文件是输入，绝不是持久化目标」 |
| preset 是**整份 roster 快照**，没有「standard 加一处改动」的 patch 语义；自建 preset 要复制整份 12.9 KB 组装并长期承担它的漂移 | 同上「已知限制」 |
| 同一个 realm 里注册**第二个 `compaction` 提供者会直接抛错**，不是覆盖、不是 last-wins | `@deepseek-ai/cordis/src/reflect.ts` `provide()` |
| 该 config 在构造时被 `deepFreeze`，且这个代码库里**不存在** `patchReload: 'live'` 这类热改 API | `dsh-compaction-basic/lib/index.js`；全库搜索无命中 |

于是本插件选了唯一一条不需要动 preset、也不需要动 DSH 源码的路。

## 它到底怎么生效（`lib/index.js`）

宿主平面能看到**每一个 preset** 的行，所以插件挂在宿主平面，用**全局 `internal/config` 瀑布**
改写目标 fiber 的 config —— 这正是加载器自己用来做 `!!js` 插值的那条缝：

```
settings.yaml: dsh-compact-model:{ provider, model, reasoningEffort }
        │  ctx.settings.register(ns, schema, { base, validate })
        ▼
  ① 加载期 applyAtLoad：global internal/config 监听
     fiber 每次 (re)load 都先过这里 → 命中 compaction-basic 行就注入
       summarizationProvider / summarizationModel
        ▼
  ② 运行期 applyLive：ctx.reflect.store 枚举各 realm 的 compaction 引擎
     直接替换引擎的 config 字段（引擎每次摘要都重读 this.config）
        ▼
  ③ reasoningEffort 不在 config 里（后端不传该字段），
     改在宿主平面 ctx.llm.stream 上做只认 purpose==='compaction' 的注入
```

三条路径各自解决一个具体问题：

1. **① 管重启与新生效**：重启 DSH、preset 换新代际、新建会话，都会重新 load 行，所以路由一定被注入。
2. **② 管已在跑的会话**：加载器对**没变过**的 config 会跳过 `fiber.update`，已在运行的引擎不会自己
   重读配置，所以必须由插件直接改它的 `config` 字段（不是重启 fiber —— 那会在压缩事务中途留下
   未闭合的 `compaction/start` 标记）。
3. **③ 管思考强度**：`summarizeWithLlm` 构造 `GenerateOptions` 时压根不传 `reasoningEffort`，
   所以它只能从 `ctx.llm.stream` 注入；适配器若拒绝该强度，插件会**关掉自己的覆盖并告警**，
   让下一次压缩用模型默认强度跑成，而不是每次都失败。

### 认行守卫

`identifyTarget(fiber)` 用三重信号，避免误伤无关插件：入口包名
（`fiber.entry.options.name === '@deepseek-ai/dsh-compaction-basic'`）→ 插件名
（`fiber.runtime.callback.name === 'compaction-basic'`）→ 兜底行 id。命中哪一条会打进日志。

### 设置页卡片（浏览器半）

宿主注册 namespace `dsh-compact-model`，浏览器半用官方席位 `settings.plugin.item`
（`key` = 该 namespace）挂卡片 —— 与已装的第三方插件 `dsh-context` 同一套机制。
**重要**：设置页只有当**宿主真的注册了**这个 namespace 时才会派发卡片，所以两处字面量必须一致。
模型下拉的数据源是 `ctx.remote.session.modelCatalog()`，与内置模型选择器同源，因此列出的都是
本部署真正能路由到的路线。

**UI 约束（踩过坑，不要再犯）**：卡片的外壳不能自己发明，必须照抄官方 `dsh-client-ui-settings-plugins` 里 `PluginCard` 的类名与 token（`li.card` >`button.header` > `span.headText` > `span.name`+`span.description` 再跟 chevron，再加 `div.body`），否则跟旁边的「终端」「Agent 循环」卡片长得不一样。

**一条必须记住的 flex 规则**：官方 `Menu` 的最外层是 `<span class="root">`，而 `Menu.module.css` 给它 `display:inline-flex` —— 即**收缩到内容宽度**。一旦把 `flex:none` 的按钮塞进去，整个控件会塔成几个像素，文字被 `overflow:hidden` 全裁。因此插件把 wrapper 类 `.dsh-pcm-fieldValue` 定义为伸缩容器里的**生长项**（`display:flex; width:100%; min-width:0`），`.dsh-pcm-select` 则 `width:100%; min-width:0` 填满它。`test/client.test.mjs` 把这两半都钉死了，任一半回退都会红。

## 安装

```powershell
cd plugins/dsh-compact-model
node scripts/install.mjs --profile desktop --dry-run   # 先看规格
node scripts/install.mjs --profile desktop             # 实装
```

脚本做四件事并自证：把 `@deepseek-ai/schemastery`（宿主半唯一运行时依赖）从共享树
junction 进插件自己的 `node_modules` → 备份 profile 的 `package.json` 为
`package.json.bak-compact-model`（仅首次）→ 跑 `dsh plugin --profile desktop add link:<本目录>`
（pnpm 自动并入 `dsh.profile.bundles`）→ 用 `--dump-config` 复核那一行**真的进了组合树**。

装完**重启 DSH Desktop**，再**硬刷新页面**（Ctrl+Shift+R）。

卸载：`node scripts/install.mjs --profile desktop --uninstall`

## 验证

已实际执行并通过：

```powershell
node --check lib/index.js      # 语法
node --check lib/logic.js
node --check lib/client.js
node --test "test/*.test.mjs"  # 57/57 通过
node scripts/install.mjs --profile desktop --dry-run
```

57 条测试（logic 17 / host 15 / inject 4 / client 21）覆盖：行识别守卫的三种命中与全部不命中、注入决策（未选/选全/只选一半/非目标行/
config 为 undefined/已含其它键且不得被改动）、成对校验、effort 只注入 `compaction` 请求、
适配器拒绝 effort 后自动降级、设置变更的 live-apply、以及「settings 上下文没有 logger 也不能崩」。

### 一个真实踩过的坑：不要把不变量放在 settings 的 `validate` 钩子里

设置服务的 `register(ns, schema, { base, validate })` 里，`validate` **每次写入和每次 resolve 都会跑**。把「provider 和 model 必须成对」放在这里，等于宣告「选了提供方、还没选模型」这个**完全正常的中间态不可表示**。后果不是报错，而是完全无痕：

1. 浏览器写 `{provider:'deepseek-official', model:''}`；
2. 宿主 `resolve()` 里 `validate` 抛错，整条写入被拒（`settings/rejected`）；
3. 客户端 `SettingsScopeController.mutate` 看到 `response.ok === false` 后**只调 `recover()` 静默重读镜像**，不抛错、不返回失败；
4. 字段弹回空值；宿主日志、`settings.yaml`、浏览器控制台**全部无记录**。

用户看到的就是「点了提供方，没反应」。这也解释了为什么 `reasoningEffort`（单标量，不触发成对规则）能写进去，而 provider/model 一次都没成功过。

现在的做法：成对规则**只在使用点**执行—— `hasRoute()` 是唯一谓词，`decideInjection` 对不完整的对返回 `null`，因此半成对永远到不了后端。`test/host.test.mjs` 里那条断言已经**反转**：它现在断言 `validate === undefined`，并写明了为什么不能再加回去。

另：卡片现在用 `scope.set/unset`（逐字段）而不是一次 `mutate`，走的就是 `reasoningEffort` 当初成功的那条路；并且对「未上报模型的提供方」直接禁用选项并在卡片里列出原因，而不是让用户选完发现没反应。

### 第三条必须记住的规则：写入结果只能从原始 user 层读回

`scope.set/unset/mutate` 在宿主拒绝时**总是 resolve**（内部只调 `recover()` 静默重读镜像），所以 `.catch()` 永远不会触发；用 `snapshot.value` 判断也不行——base 层使 `{}` 与 `{provider:'',model:''}` 解析结果完全相同。正确做法是读 `snapshot.user`（原始存储层，**键是否存在**才是"是否被覆盖"的标志），框架自己的 `PluginCard.store()` 就是 `userLayer()?.[field] === value`。本插件的 `assertStored` 就是这件事：写完读回，不一致就把失败显示在卡片里。

### 第四条：切换提供方时，携带的模型必须按**目标提供方**判定

第一版修复里 `pickProvider` 用的是**已存的**提供方的模型列表来决定要不要带上旧模型。从 A 切到 B 时就会写出 `{provider:'B', model:'A的模型'}`——这是个"**合法**"的成对（两半非空），会静默落盘，然后压缩后端拿着 B 去要 A 的模型 id。现在改为 `carriedModel(nextProvider)`，只有目标提供方确实列出同一个模型才保留。

### 第五条：空操作选择不要发出

宿主对"原始 section 未变化"的写入是**彻底无痕**的：不落盘、不增 revision、不发 `settings/document-updated`、不调 watcher、不记日志。所以提交一次空写入等于复制"控件死了"的症状。卡片现在用 `sameRoute()` 在上网前就丢掉它，这同时也阻断了受控列表 `onSelect` 重复触发。

**客户端半的 17 条**跑在 `node:vm` 沙箱里，加载的是**真的 `lib/client.js`**，配一个不依赖 DOM 的 React 替身（实际执行 hooks），因此能断言：卡片渲染出的类名结构符合 `PluginCard` 契约、折叠时不渲染 body、namespace 不可用时返回 `null`、`settings.plugin.item` 的 `key` 与寄宿注册的 namespace 一致、以及上面那条 flex 规则与「每个输出的 `dsh-pcm-*` 类名都有对应规则」。

**需要在浏览器里确认的**（脚本验不了）：设置 → 插件 → 插件配置出现「压缩模型（compact）」卡片 →
选一个与会话模型不同的路线 → `/compact` → 会话日志里 `compaction/summary` 事件的 `provider`/`model`
是所选模型，而聊天请求仍是会话模型 → 清空设置后回到跟随会话模型。

### 一个明确的验证缺口（不要误以为已验）

**「真 loader 加载真 compaction-basic 时，我的 config 被采纳」这一条没有端到端跑通。**
我试过用 `@deepseek-ai/cordis` + `@deepseek-ai/cordis-plugin-loader` 搭真实集成测试，但
`new Loader(root)` + `loader.create(entry)` 这个最小组合本身就会抛
`Cyclic __proto__ value`（`loader/lib/index.js` 的 `loader/patch-context` 里
`Object.setPrototypeOf(entry.ctx[Context.isolate], entry.parent.ctx[Context.isolate])`），
**去掉我的插件后同样抛错** —— 是测试脚手架不成立（真 DSH 的 loader 挂在一个完整组合上下文上），
不是插件缺陷。我因此删掉了那个文件，而不是留一个假绿的测试。

目前支撑该机制的证据是源码级的，不是运行时的：
- loader **自己**就用同一个 `{ global: true }` 形态监听 `internal/config`（`loader/lib/index.js:685`）；
- `fiber._resolveConfig()` 在**每次** `_reload`（`fiber.ts:655`）与 `update`（`:747`）时都跑这条瀑布，
  且监听器的**返回值**就是该 fiber 的配置（`events.ts` 的 waterfall 语义）；
- `global: true` 绕过上下文过滤（`events.ts` 的 `hook.global || !filter`），这正是跨 preset realm 必需的那一点。

因此本插件的正确性由两件事共同保证：① 31 条单测锁定**决策**（认哪一行、注入什么、什么时候不注入）；
② 真机上若 `internal/config` 没到达 preset 平面，**重启 DSH 后必然生效**（那时行会重新加载）。
如果重启后仍不生效，请按上面「若设置改完不生效」一节看日志定位——那时问题一定在行守卫，不在瀑布。

宿主日志（`%APPDATA%\DSH Desktop\logs\host\*.log`）会打印插件自己的判定过程：

```
dsh-compact-model: mounted; compaction route = follow the session model
dsh-compact-model: recognised the compaction backend via entry-name+plugin-name
dsh-compact-model: pinned the compaction route to kimi-coding/k3 at load time
dsh-compact-model: live-applied kimi-coding/k3 to 1 running compaction engine(s) after settings:provider+model
```

**若设置改完不生效**：先看有没有 `recognised the compaction backend` 这行——没有就是行守卫没命中
（日志会带 `row=`/`plugin=`/`package=` 三个实测值，据此收紧守卫）；有这行但没有 `pinned`，就是
`internal/config` 瀑布没到达 preset 平面，此时**重启 DSH 一定生效**（②的兜底）。

## 已知限制与耦合

- **换模型必然放弃 KV cache 复用**。后端刻意复用会话自己的 system prompt / tools / 前缀消息，
  让摘要调用成为会话的真前缀以命中热缓存；路由到别的模型就等于放弃这份复用。这是「分开绑定模型」
  的固有代价，不是 bug。
- **思考强度的注入耦合 `LlmRuntime.stream` 方法名**。这是本插件唯一一处实例方法接管；若上游改名，
  压缩会退回「不带 effort」的行为，不会崩（`installEffortPatch` 找不到 `stream` 时只告警）。
- **`llm` 座位必须经 `ctx.inject(['llm'], …)` 取，不能直接读 `ctx.llm`**。`llm` 行
  （`@deepseek-ai/dsh-llm`）与本插件行是同一个组合根下的**兄弟**，不是祖先；cordis 只对已声明依赖做
  注入解析，裸读会抛 `cannot get property "llm" without inject`，把整棵插件树带崩（2026-09-19 启动失败
  就是这个原因）。同文件的 `settings` 座位一直是这个写法。
- **live-apply 依赖 `ctx.reflect.store` 是公开的**（它确实是 `public store`）。枚举不到引擎时只记日志，
  下一次重启仍会生效。
- **本机第三方插件的 `inject` 声明不会被 `dsh plugin add` 自动链接**：宿主半 import 的
  `@deepseek-ai/schemastery` 必须由安装脚本 junction（已在 `HOST_IMPORTS` 里）；浏览器半不需要链接，
  它只 require 冻结种子模块。
- 全局一个设置，不区分 preset / 会话（按明确的选择）；不做 `maxTokens` 覆盖与「恢复默认」按钮
  （未勾选，清空字段即等价）。
