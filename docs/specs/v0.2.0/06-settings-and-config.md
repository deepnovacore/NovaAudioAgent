# 06. Settings and Config

> 摘要：桌面设置从 v3 升到 v4，纳入审批模式、澄清深度、规划回读、进度气泡、embedding 与能力注册表路径。环境变量契约同步扩展；设置面板新增「权限 / 意图理解 / 能力 / 知识库 / 通知」分区。能力注册表文件与 CLI 共用。`capabilities.json` 与设置文件的校验和写入进入**同一个**协调操作，并区分「已保存」与「已生效」；搜索 provider 只在注册表一处持久化。本卷是横切契约，随 01–05 增量落地。
>
> 修订（2026-09-03）：回应评审 P2-6（两文件提交顺序、busy / 重启失败导致三处状态不一致、search provider 三处来源）。

## Baseline (today)

- Desktop store: `SETTINGS_VERSION = 3`,
  [`desktop/ambient-orb/src/main/settings-store.mjs`](../../../desktop/ambient-orb/src/main/settings-store.mjs).
- Apply path: `applySettingsTransaction` writes, publishes, then restarts the
  backend ([`settings-apply.mjs`](../../../desktop/ambient-orb/src/main/settings-apply.mjs)).
- Backend env mapping:
  [`desktop/ambient-orb/src/main/backend.mjs`](../../../desktop/ambient-orb/src/main/backend.mjs).
- Runtime schema: [`runtime/src/config.ts`](../../../runtime/src/config.ts)
  `settingsSchema` +
  [`runtime/src/environment-contract.ts`](../../../runtime/src/environment-contract.ts).
- `novaaudio config` opens the same settings window; there is no separate CLI
  editor for most keys.
- No keys today for approval mode, clarification, planner, bubbles, MCP
  registry, or knowledge.

## Goals

1. Versioned migration 3 → 4 with safe defaults for new fields.
2. One env contract covering runtime + desktop-injected overrides.
3. Panel information architecture that matches the five features.
4. Shared `capabilities.json` for desktop and CLI/doctor.

## Non-goals

- Redesigning unrelated existing tabs (palette, pipeline providers) beyond
  necessary links.
- Live hot-reload of Codex / MCP without backend restart in v0.2.0 (keep
  transaction + restart).
- Storing MCP secrets inside `capabilities.json` plaintext; use `${ENV}` and
  desktop `safeStorage` secrets that populate env for the child.

## Settings v4 keys

New persisted fields (desktop `ambient-orb-settings.json`):

| Key | Type | Default | Feature |
|---|---|---|---|
| `codexApprovalMode` | `ask` \| `yolo` | `ask` | [01](01-codex-approvals.md) |
| `clarificationDepth` | `minimal` \| `balanced` \| `thorough` | `balanced` | [02](02-intake-and-planning.md) |
| `planReadback` | `summary` \| `confirm` \| `silent` | `summary` | 02 |
| `plannerModel` | string | `""` (means follow `fast_model`) | 02 |
| `progressBubbles` | `off` \| `milestones` \| `all` | `milestones` | [05](05-progress-bubbles.md) |
| `embeddingProvider` | `dashscope` \| `local` | `dashscope` | [04](04-knowledge-base.md) |
| `embeddingModel` | string | provider default | 04 |
| `capabilitiesConfigPath` | string | `""` → default `~/.nova-audio-agent/capabilities.json` | [03](03-capability-registry-and-mcp.md) |
| `knowledgePath` | string | `""` → default knowledge sqlite path | 04 |

There is deliberately **no** `searchProvider` key in the desktop store. The
provider lives only in `capabilities.json` (`modules.search.provider`); the
panel reads and writes the registry directly. See precedence in
[03](03-capability-registry-and-mcp.md#precedence).

Migration rules:

- `version < 4` → set all new keys to defaults above; bump to 4.
- Unknown keys stripped as today.
- Secrets map unchanged; optional future secret slots for MCP tokens go through
  `safeStorage` and are exported as env names referenced by `${VAR}` in
  capabilities.json.

## Env contract additions

Regenerate `.env.example` via `npm run check:env-contract` after
`environment-contract.ts` updates.

| Env | Maps from / meaning |
|---|---|
| `NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE` | `ask` \| `yolo` |
| `NOVA_AUDIO_AGENT_CLARIFICATION_DEPTH` | `minimal` \| `balanced` \| `thorough` |
| `NOVA_AUDIO_AGENT_PLAN_READBACK` | `summary` \| `confirm` \| `silent` |
| `NOVA_AUDIO_AGENT_PLANNER_MODEL` | optional model id |
| `NOVA_AUDIO_AGENT_PROGRESS_BUBBLES` | `off` \| `milestones` \| `all` |
| `NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG` | path to capabilities.json |
| `NOVA_AUDIO_AGENT_SEARCH_PROVIDER` | `mcp` \| `tavily` — CLI / CI **override** of the registry value; logged when it takes effect; the desktop never sets it |
| `NOVA_AUDIO_AGENT_SEARCH_MCP_URL` | Web search MCP endpoint |
| `NOVA_AUDIO_AGENT_SEARCH_MCP_TOOL` | default `web_search` |
| `NOVA_AUDIO_AGENT_KNOWLEDGE_PATH` | knowledge sqlite path |
| `NOVA_AUDIO_AGENT_EMBEDDING_PROVIDER` | `dashscope` \| `local` |
| `NOVA_AUDIO_AGENT_EMBEDDING_MODEL` | embedding model id |

`TAVILY_API_KEY` remains but is optional when search is disabled or provider is
`mcp`. `DASHSCOPE_API_KEY` serves realtime, opt-in MCP search, and default
embeddings.

`backendLaunchSpec` must map every desktop v4 field that affects the child
into the corresponding env var (omit empties so parent `.env` can still win,
matching current secret behaviour).

## Capabilities file vs settings

| Concern | Where |
|---|---|
| Module enable, MCP server definitions, search provider | `capabilities.json` only |
| User preference enums (approval, depth, bubbles, embedding) | desktop settings + env |

Doctor / CLI validate both layers.

## Coordinated commit

Today `applySettingsTransaction`
([`settings-apply.mjs`](../../../desktop/ambient-orb/src/main/settings-apply.mjs))
runs one `coordinator.run('settings_save')` that writes the settings file,
publishes it, prepares and commits the backend configuration, and restarts the
backend. It can return `busy` (nothing written), `failed` after the write
(saved, not applied), or `restart_failed` (saved, committed, backend down). The
earlier draft of this volume said “write `capabilities.json`, then run the
transaction”, which would let the registry change land on disk while the
settings step returned `busy`. That ordering is withdrawn.

Rules:

1. **One coordinated operation.** A panel save produces a single
   `SettingsCommit = {settingsPatch?, capabilitiesDocument?}` and runs it through
   one `coordinator.run('settings_save')`. `busy` means neither file changed.
2. **Validate before any write.** Inside the operation: validate the settings
   patch (existing rules) **and** the full capabilities document (schema,
   `${VAR}` presence, per-server rules from 03). Any validation failure returns
   `{saved:false, operationStatus:'invalid', problems:[…]}` with nothing
   written; problems carry bounded, secret-free text for the panel.
3. **Write both atomically enough.** Write each file to a temp sibling and
   rename; write `capabilities.json` first, then the settings file. If the
   second write fails, restore the previous `capabilities.json` from the
   in-memory snapshot taken at step start, then report `failed` with
   `saved:false`.
4. **Saved vs applied.** After both writes succeed the result is at least
   `saved:true`. `operationStatus` then follows the existing lattice:
   `applied` (backend restarted on the new files), `failed` (prepare/commit
   failed; disk changed, running backend still on old config),
   `restart_failed` (committed but backend down). The panel must render the
   three states differently: 已保存·未生效 for `failed`, 已保存·后端未启动 for
   `restart_failed`, 已生效 for `applied`. It must never show 已生效 unless the
   backend restarted with the new configuration.
5. **Effective view.** `publishCommitted` carries both documents so the panel’s
   displayed state is the on-disk state, and the backend status view says which
   configuration generation the running child was started with. Three
   generations may legitimately differ (panel draft, disk, running); the UI
   labels which one it shows.
6. **Codex rescan and knowledge jobs** keep their own coordinator keys; a save
   while they run returns `busy`, unchanged.

Doctor reads the same validator, so `novaaudio doctor` and the panel disagree
only if the file changed between runs.

## Panel IA

Suggested tabs / sections (Chinese UI labels):

| Tab | Contents |
|---|---|
| 权限 | `codexApprovalMode` + YOLO warning copy |
| 意图理解 | `clarificationDepth`, `planReadback`, `plannerModel` |
| 能力 | module toggles, search provider, MCP editor / probe |
| 知识库 | enable (link to module), paths, embedding provider, ingest UI entry |
| 通知 | `progressBubbles` |
| (existing) | appearance, proactivity, pipeline, Codex binary/workspace, API keys |

Exact layout may reuse a single scroll page with headings if tabs are costly;
acceptance is that each feature’s controls are reachable without editing JSON
by hand on desktop.

## Implementation order

Land schema + migration stubs early; wire controls as each feature merges:

1. Skeleton v4 migration + env contract (with this branch’s first feature PR).
2. 权限 with [01](01-codex-approvals.md).
3. 通知 with [05](05-progress-bubbles.md).
4. 能力 with [03](03-capability-registry-and-mcp.md) phases.
5. 意图理解 with [02](02-intake-and-planning.md).
6. 知识库 with [04](04-knowledge-base.md).

## Verification checklist

- [ ] Store migrate 3 → 4 idempotent; defaults applied once.
- [ ] `check:env-contract` green after new rows.
- [ ] Each new desktop key round-trips: panel → disk → `backendLaunchSpec` →
      `loadSettings`.
- [ ] YOLO warning visible only when mode is yolo (or always visible beside the
      control with stronger emphasis when selected).
- [ ] Invalid enum values fail closed to defaults without crashing startup.
- [ ] capabilities.json validation errors surface in doctor and settings save
      with identical problem codes.
- [ ] Coordinated commit: `busy` leaves both files byte-identical; invalid
      capabilities document leaves both files untouched; simulated failure on
      the second write restores the first file; `failed` / `restart_failed` /
      `applied` render as three distinct panel states.
- [ ] Search provider persisted only in the registry; desktop store schema has
      no `searchProvider`; env override is logged.

## Decision-record delta

No new architecture decision beyond those in 01–05. This volume is the
configuration surface for those decisions.
