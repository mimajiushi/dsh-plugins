# dsh-plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Every plugin here is a normal DSH bundle: it declares a `dsh.bundle` manifest in its
`package.json` and installs with `dsh plugin add`. They were written for, and are
verified against, `dsh` **0.1.5-rc.1** on Windows; each one is a host-plane plugin
unless its README says otherwise.

## Plugins

| Plugin | What it does |
| --- | --- |
| [dsh-agent-teams-approval](plugins/dsh-agent-teams-approval) | A **Settings → General** switch that lets AgentTeams create and start teams immediately, without the Web plan-approval click. |
| [dsh-agent-teams-limits](plugins/dsh-agent-teams-limits) | A settings card for the AgentTeams **roster cap** and a **per-team concurrency cap**. The roster cap works by config injection alone; the concurrency cap additionally needs the patch shipped in `plugins/dsh-agent-teams-limits/scripts/` for `@nanmicoder/dsh-agent-teams` 0.1.20. |
| [dsh-compact-model](plugins/dsh-compact-model) | Lets `/compact` run on a provider/model you choose in Settings instead of the session's chat model. |
| [dsh-llm-retry-all](plugins/dsh-llm-retry-all) | Retries **every** model-gateway error (429, quota, auth, network, empty response) with a linear 5s-step backoff capped at 5 minutes — for agent-loop requests and for direct `ctx.llm.stream()` calls such as compaction and session titles. |
| [dsh-plan-card-sidebar](plugins/dsh-plan-card-sidebar) | Gives the plan-review card a second home in the right sidebar, with a per-card switch that moves the same card and its decision buttons between the sidebar and the main conversation. |
| [dsh-subagent-model-guard](plugins/dsh-subagent-model-guard) | Enforces the `subagent-model-selection` whitelist at every child-Agent creation, so `subagent`, AgentTeams and workflow children can only run on an allowed provider/model. |
| [dsh-subagent-toggle](plugins/dsh-subagent-toggle) | A settings switch that denies every tool call able to create or wake a subagent (`subagent`, `subagent_fork`, `workflow`, `ralph`) and tells the model to use Agent Teams instead. |
| [dsh-web-fetch-fakeip-allow](plugins/dsh-web-fetch-fakeip-allow) | Lets `web_fetch` accept the placeholder addresses a local TUN + fake-ip proxy (Clash/mihomo, sing-box, Surge) returns for ordinary public domains, while every other non-public address stays blocked. |
| [dsh-workspace-changes](plugins/dsh-workspace-changes) | An IDE-style Changes panel in the right sidebar: grouped working-tree changes, a unified/side-by-side diff viewer with line numbers and file navigation, copy-diff and open-in-IDE — read-only against the repository. |

## Install

From npm:

```sh
dsh plugin --profile <profile> add dsh-compact-model
```

From this repository (no npm package needed):

```sh
dsh plugin --profile <profile> add github:mimajiushi/dsh-plugins#path:/plugins/dsh-compact-model
```

`<profile>` is the profile you run (`web` for `dsh web`, `desktop` for DSH Desktop).
Restart DSH afterwards — the loader resolves the new bundle at composition time.

Each plugin's README documents what it changes, how to verify it, how to roll it
back, and the boundaries it deliberately keeps. Most of them surface their own
settings card under **Settings → Plugins → Plugin configuration**.

## Layout

```
plugins/<name>/          one installable package per plugin
  package.json           `dsh.bundle` manifest (+ `dsh.client` for browser halves)
  cordis.patch.yml       the bundle patch layer that mounts the plugin row
  lib/                   host half (exports ".") and, where present, browser half (exports "./client")
  scripts/install.mjs    local install into a profile from a source checkout
  test/                  node:test suites (`npm test` inside the directory)
```

## Development

```sh
cd plugins/dsh-compact-model
npm test                       # the plugin's own suites, no DSH needed
node scripts/install.mjs --profile desktop --dry-run
```

The suites are offline by design: they drive the host and browser halves against
stand-ins for the harness services, and assert the bundle contracts (declared
client injects, module exports, patch anchors) that a broken plugin would fail at
boot rather than at test time.

## License

MIT — see [LICENSE](LICENSE).
