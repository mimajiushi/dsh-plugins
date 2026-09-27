---
description: "DSH 宿主插件：让 web_fetch 不再把 Clash/mihomo 的 fake-ip 占位地址（IPv4 `198.18.0.0/15` + IPv6 `2001:2::/48`）当成内网地址拦掉，同时保持环回/私网/链路本地/IP 字面量照旧被拒。"
---

# dsh-web-fetch-fakeip-allow

> **从社区安装** · `dsh plugin --profile <profile> add dsh-web-fetch-fakeip-allow`
> 或从源码：`dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-web-fetch-fakeip-allow`
> 下文里的 `node scripts/install.mjs` 是**源码检出**时的本地安装：把包 `link:` 进你自己的 profile。

> 本机开着 Clash Verge(mihomo) 的 **TUN + fake-ip**，被代理域名在系统 DNS 里只回 `198.18.x.x` 这类占位地址（实测 `docs.godotengine.org → 198.18.0.133`、`github.com → 198.18.0.62`），真正的解析与连接由 mihomo 完成。浏览器照常打开，但 DSH 的 `web_fetch` 会在建连前做地址预检，判定"非公网地址"直接拒绝，报 `URL hostname "…" resolves to a non-public IP address`（`WEB_BLOCKED_URL`）——请求根本没发出去。本插件只放宽这一处：**整组解析结果都落在显式配置的 fake-ip 段内时放行**，其余一律保持原样。

## 它做什么

- 保留宿主 provider 的**全部**行为：同源重定向策略、字节/字符上限、charset 解码、超时、错误码映射，一个字都没改。
- 只替换 provider 的 `resolveAddresses`：**先问原解析器**，只有它因地址策略拒绝、且重新解析得到的**每一条**答案都在配置的段内时，才接受这次解析。
- 公网域名、环回（`127.0.0.1`）、RFC 1918、链路本地、CGNAT、URL 里的 IP 字面量：**全部保持原判**，抛出的还是 provider 自己那个错误对象。
- **两族占位地址都要有对应的段**：解析器同时回 A 和 AAAA 占位地址时（本机 mihomo 开了 `dns.ipv6`，`fake-ip-range6: 2001:2::0/64`），只要有一条落在段外就整组拒绝——所以默认 `allow` 同时给出 `198.18.0.0/15` 和 `2001:2::/48`。
- 不注册新 provider、不动 `web_search`、不碰 DSH 安装目录或 `app.asar`、没有客户端 UI（不需要刷新页面）。

## 为什么是这个做法

`@deepseek-ai/dsh-web-fetch-http` 里，拦截发生在 `resolvePublicAddresses()`：

```js
if (!isPublicIpAddress(entry.address)) throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, "WEB_BLOCKED_URL");
```

同一个 `requestOnce()` 里还有一条产品自带的豁免：URL 走代理分支时（`proxyRouteFor(url).proxied`）**跳过**地址检查，因为"代理自己会解析域名"。也就是说宿主本来就承认"解析结果不代表最终目的地"这件事——只是它没把 fake-ip 这种本地代理占位地址考虑进去。

被否决的两个备选：

- **自己注册一个 fetch provider**：组合树里 `web` 行的 config 已写死 `fetchProvider: http`，新 provider 不会被选中；要生效就得改那行 config（替换 config 必须重述 `searchProvider` 等字段，脆弱），而且等于把整套传输逻辑重写或偷出来——收益远小于风险。
- **harness home `.env` 里写 `HTTPS_PROXY`**：确实能让 provider 走代理分支从而跳过检查，但会把**整个宿主的出网**（含模型 API）一起塞进 Clash。作为备选记在文末，不作为默认。

## 安装

```powershell
cd plugins/dsh-web-fetch-fakeip-allow
node --test test/logic.test.mjs test/host.test.mjs      # 单测（不需要 DSH）
node scripts/install.mjs --profile desktop              # 安装 + 组合复核
```

脚本会：把 `@deepseek-ai/schemastery` 链接进本包的 `node_modules` → 备份一次 profile manifest → `dsh plugin --profile desktop add link:<本目录>` → 校验 `dependency / bundles / composed` 三行（`composed` 用 `dsh --profile desktop --dump-config` 复现宿主启动时的组合，并打印本插件的行与 config）。

然后**重启 DSH Desktop**（宿主插件在启动时装载；当前会话会保留）。

## 验证

1. 正例：`web_fetch https://docs.godotengine.org/en/stable/tutorials/scripting/nodes_and_scene_instances.html` → 返回正文（安装前稳定报 `resolves to a non-public IP address`）。
2. 反例（必须仍被拒，错误文本不变）：`web_fetch http://127.0.0.1:43120/`、`web_fetch http://192.168.199.1/`。
3. 日志说明：插件的 INFO 行**不会**落进 `%APPDATA%\DSH Desktop\logs`（实测该文件只记生命周期标记与错误，info 级 0 行），所以判定**以行为为准**——正例返回正文 + 反例仍被拒，就同时证明"补丁已生效"和"放宽范围没有扩大"。`accepted fake-ip answer for <域名> -> 198.18.0.133` 这条 INFO 在宿主的 logger 通道上，是否可见取决于宿主的日志级别/输出端。

实测结果（重启 DSH Desktop 后，2026-09）：

| 检查 | 结果 |
|---|---|
| `web_fetch https://docs.godotengine.org/en/stable/tutorials/scripting/nodes_and_scene_instances.html` | HTTP 200，返回页面正文 ✅（安装前：`resolves to a non-public IP address`） |
| `web_fetch http://127.0.0.1:43120/` | 仍 `WEB_BLOCKED_URL` ✅ |
| `web_fetch http://192.168.199.1/` | 仍 `WEB_BLOCKED_URL` ✅ |

## 复发记录：双栈 fake-ip（2026-09-25）

同一条错误又回来了，而且**所有域名**都失败（`api.github.com`、`www.baidu.com`、`example.com` 一个不落）——因为 mihomo 侧开了 IPv6 假地址，旧版插件只认 IPv4：

| 证据 | 值 |
|---|---|
| mihomo 运行时 dns 段 | `enhanced-mode: fake-ip`、`fake-ip-range: 198.18.0.1/16`、`ipv6: true`、`fake-ip-range6: 2001:2::0/64` |
| `dns.lookup('api.github.com', {all:true})` | `198.18.0.38` (A) **+** `2001:2::24` (AAAA) |
| 宿主判定 | 逐条 `isPublicIpAddress`；`2001:2::/48` 在 ipaddr.js 里是 reserved → 整组拒绝 |
| 本插件（0.1.x） | 只认 `family === 4`，见到 AAAA 直接放弃 → 原错误重抛 |

修复（0.2.0）：`allow` 同时接受 IPv6 CIDR，`acceptFakeIpAnswerSet` 按族逐条判定，整组仍在段内才放行。

**排查这类问题的三步**（下次直接照做）：`Resolve-DnsName <域名>` 看是不是 `198.18.x.x` / `2001:2::x`；`node -e "require('dns').lookup('<域名>',{all:true,order:'verbatim'},console.log)"` 看有没有 AAAA；拿这个答案集跑 `acceptFakeIpAnswerSet`（见 `test/logic.test.mjs` 里的双栈用例）确认是策略还是装载问题。

**不重启也能自证**：`scripts/probe-provider.cjs` 直接把 App 里那份 `@deepseek-ai/dsh-web-fetch-http` 从 `app.asar` 里 require 出来，先看裸 provider 拒绝，再挂上本插件的补丁看它被救回——全程走宿主自己的代码，没有 mock：

```powershell
cd plugins/dsh-web-fetch-fakeip-allow
$env:ELECTRON_RUN_AS_NODE=1
& "D:\software\dsh_desktop\DSH Desktop\DSH Desktop.exe" scripts\probe-provider.cjs api.github.com
```

2026-09-25 实测（本机 mihomo 双栈 fake-ip）：

```
api.github.com  (want: rescue)
  bare provider : refused [WEB_BLOCKED_URL] URL hostname "api.github.com" resolves to a non-public IP address
  with patch    : 198.18.0.38 (family 4), 2001:2::24 (family 6)
localhost / 192.168.199.1 : 挂补丁后仍 refused [WEB_BLOCKED_URL] ✅
```

注意：这里证明的是**策略与补丁**已经正确；补丁要在**跑着的宿主**里生效仍需重启 DSH Desktop（宿主插件在启动时装载）。

## 配置

行内 config 在 `cordis.patch.yml`（随包安装，改完需要重新组合/重启）：

```yaml
config:
  enabled: true              # false = 插件完全惰性（不用卸载）
  allow:                     # 允许放行的 CIDR —— 这就是全部放宽范围（IPv4/IPv6 都收）
    - 198.18.0.0/15          # mihomo/clash 的 fake-ip-range（IPv4 池）
    - 2001:2::/48            # mihomo/clash 的 fake-ip-range6（IPv6 池；本机 pin 的是 2001:2::0/64，落在其中）
  log: true                  # 每次放行打一行日志
```

profile 是 `patchReload: live`，所以**不用重启**也能用用户 patch 层按 id 覆写这行 config：
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（或 harness home 的 `~/.dsh/cordis.patch.yml`）里加

```yaml
- id: web-fetch-fakeip-allow
  config:
    allow:
      - 198.18.0.0/15
      - 10.0.0.0/8      # 举例：只有你确认要走代理的段才加
```

## 回滚

```powershell
node scripts/install.mjs --profile desktop --uninstall   # 然后重启 DSH Desktop
```

或把 `cordis.patch.yml` 里的 `enabled` 改成 `false` 再重新组合。

## 风险与边界（明知故犯的部分）

- 本插件**有意放宽**了一道 SSRF 预检。放宽范围被限制为"整组解析结果都落在显式配置的段内"，且默认只给 `198.18.0.0/15`（RFC 2544 保留段，Clash/mihomo、sing-box、Surge 的 fake-ip 池）。被放行的地址在 Clash 运行时由 TUN 持有、绑定到某个域名，并不通向任意内网服务；环回/私网/链路本地/CGNAT 依旧全拦。
- **混合答案集不放行**：只要有一条答案落在段外（例如 `198.18.0.133` + `127.0.0.1`），整组拒绝，抛原错误。这一条在双栈下意味着：**某个族没有配段，该族就是"段外"**。
- **IPv6 只在配了 IPv6 段时放行**：默认带 `2001:2::/48`（RFC 5180 benchmarking，无真实目的地）。把 v6 段从 `allow` 删掉，带 AAAA 的答案集就会整组被拒——这正是 2026-09-25 的故障形态。
- **URL 里的 IP 字面量**走的是 provider 的另一条检查（`isNonPublicIpLiteral`），本插件不碰它——所以反例 2 依旧被拒。
- **宿主升级风险**：若未来版本改了 provider 的字段名，本插件只打一条 warn（`skipped (no replaceable resolver)`），行为退回"照旧拦截"，不会影响启动。

## 备选方案（零代码）

在 harness home 的 `.env`（`%USERPROFILE%\.dsh\.env`）写 `HTTPS_PROXY=http://127.0.0.1:<Clash 混合端口>`：provider 会走"代理分支"从而跳过地址检查。代价是**宿主所有出网**（含模型 API）都改走 Clash，且必须保持 Clash 常开。

## 文件结构

```
package.json          包清单（dsh.bundle.patch 指向 cordis.patch.yml；无客户端半）
cordis.patch.yml      bundle 补丁：插入 web-fetch-fakeip-allow 行并携带 config
lib/logic.js          无第三方依赖的策略核心：IPv4/IPv6 CIDR 解析 / 答案集判定 / provider 与 registry 打补丁与还原
lib/index.js          宿主插件壳：name / inject / Config(schemastery) / apply
test/logic.test.mjs   策略核心单测（含双栈 fake-ip 用例，网络与 DNS 全部注入）
test/host.test.mjs    装配单测 + loader 契约（schemastery 链接后才跑，否则 skip）
scripts/install.mjs   安装 / 卸载 / dry-run / 组合复核
scripts/probe-provider.cjs  真实 provider 探针（Electron as-node 读 app.asar，不重启宿主即可自证）
```
