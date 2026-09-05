# 03. Capability Registry and MCP

> 摘要：用 `capabilities.json` + 设置「能力」页统一管理内置模块（search / camera / coding / knowledge）与外部 MCP。内置 search / coding 仍是原生 executor；Camera 和 Knowledge 经内置 MCP 暴露直接工具（Knowledge 默认关闭，见 04）。搜索新增 MCP Provider（百炼 / DashScope WebSearch 预设）；**默认值在真实接入验证通过之前保持 Tavily**。外部 MCP 的工具白名单是唯一真相：前台按白名单装配，Codex 侧通过私有 `CODEX_HOME` 的 `enabled_tools` 投射同一份白名单，并在线程启动后用 `mcpServerStatus/list` 核对实际可见工具。MCP manifest 通过一层显式的适配规则进入现有工具编译器：不伪造只读属性，不兼容的服务器单独失效。
>
> 修订（2026-09-03）：回应评审 P1-4（白名单未在 Codex 侧闭环）、P2-5（manifest 规则与编译器不兼容）及产品建议「先验证再切默认」；再修订回应 P2（别名在 32 字符 server 下可达 66 → 按 server 长度动态预算）。

## Baseline (today)

- Executor names are arbitrary manifest keys and host routing is by declared
  roles; this spec has no fixed executor-name enum. A configured coding role is
  selected by `roles: ['coding']`, while direct native/MCP tools retain their
  exact manifest channel names.
- Search is Tavily-only
  ([`runtime/src/executors/search.ts`](../../../runtime/src/executors/search.ts));
  `TAVILY_API_KEY` is required for production assembly.
- Codex spawn forces `mcp_servers={}` and `validateEffectiveCodexConfig`
  requires an empty `mcp_servers` map
  ([`runtime/src/codex-app-server-schema.ts`](../../../runtime/src/codex-app-server-schema.ts)).
- `compileToolSchema` ([`runtime/src/tool-schema.ts`](../../../runtime/src/tool-schema.ts)):
  every manifest needs ≥1 `readonly` op (the probe entry for `unknown`
  outcomes, see `sims.ts` contract 2 and `context-view.ts` `compileProbes`);
  wire names are `<manifest>__<op>` ≤ 64 code points with a restricted charset;
  `origin_ref` is a reserved delegate parameter injected by the host.
- Codex 0.152 config supports per-server `enabled_tools` / `disabled_tools`
  (allowlist applied first, then denylist) and `mcpServerStatus/list` in the v2
  app-server protocol (both confirmed against the pinned schema, see
  [01 protocol pin](01-codex-approvals.md#protocol-pin)).
- Invariant 11: only configured manifests become model-facing tools.

## Relation to 07 and 08

MCP adapters are **non-agent executors**. Their manifests always use
`roles: []`, `approvals: false`, `model_visibility: 'direct'`, and
`probe_policy: 'none'`; they have no manifest `agent` field. Each allowlisted
operation is compiled as a direct `${name}__${op}` tool. It never appears in
`dispatch.executor`, never enters the coding intake, and is not an agent
controller. The full shape is:

```ts
{
  name: 'mcp__<server>',
  display_name: string,
  roles: [],
  approvals: false,
  model_visibility: 'direct',
  probe_policy: 'none',
  ops: OpSpec[],
  policy: HandoffPolicy,
}
```

The `agent` descriptor is deliberately not a manifest field. Agent names,
summaries, and owned runtime channels come from the `AgentDescriptor` /
`AgentController` registry described in [07](07-executor-boundary.md); hidden
executor projection is likewise defined there. In particular, an MCP server
cannot become a hidden agent merely by changing its manifest.

The built-in Camera MCP is the explicit exception to the earlier native-only
boundary: `mcp__nova_camera__snapshot` is a Nova-owned direct tool, not an
external server, not an agent, and not a dispatch/intake route. Search keeps
the stable `SearchAdapter` contract; MCP is only a transport behind it, and
the public tool remains `search__search`.

## Goals

1. One registry that enables / disables built-in modules and user MCP servers.
2. Search gains an MCP web-search provider (qwen-audio-agent pattern) while
   `SearchAdapter` evidence canonicalisation stays Nova-owned.
3. User MCP tools callable by FrontBrain as direct tools named
   `mcp__<server>__<tool>`; they are not agent executors.
4. Optional exposure of the **same registry allowlist** into Codex’s private
   `CODEX_HOME`, with independent consumer gates: `exposeTo.frontbrain` and
   `exposeTo.codex` may differ, but neither consumer may see a tool omitted from
   the allowlist.
5. Fail-closed per server; secrets via env interpolation; reload through the
   coordinated settings commit ([06](06-settings-and-config.md)).

## Non-goals

- Rewriting native search / coding executors as external MCP servers. The
  built-in Camera MCP (`mcp__nova_camera__snapshot`) is the explicit direct
  tool exception documented above.
- Editing Codex’s own `~/.codex/config.toml` (Nova manages the per-workspace
  private home only).
- Routing MCP tool approvals from Codex through the Nova broker in v0.2.0.
- A per-tool approval broker for FrontBrain MCP calls in v0.2.0. Non-readonly
  direct calls reuse the same user-origin/current-turn gate primitive as
  `dispatch`, but they do not route through `dispatch` / intake and do not
  create an approval FSM. This gate preserves provenance, not ASR meaning:
  it cannot repair semantic mishearing. Per-tool confirmation through the
  existing `confirm(id, accepted)` is a v0.2.x follow-up/non-goal.
- Switching the search default before the Bailian MCP path has passed a live
  verification recorded in Getting Started.

## Registry file

Path: `~/.nova-audio-agent/capabilities.json` (override:
`NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG`). Versioned document:

```json
{
  "version": 1,
  "modules": {
    "search": {
      "enabled": true,
      "provider": "tavily",
      "mcp": {
        "url": "${NOVA_AUDIO_AGENT_SEARCH_MCP_URL}",
        "tool": "web_search",
        "headers": { "authorization": "Bearer ${DASHSCOPE_API_KEY}" }
      },
      "tavily": { "apiKeyEnv": "TAVILY_API_KEY" }
    },
    "camera": { "enabled": true },
    "coding": { "enabled": true },
    "knowledge": { "enabled": false, "exposeToCodex": false }
  },
  "mcpServers": {
    "example_docs": {
      "enabled": true,
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "authorization": "${DOCS_MCP_TOKEN}" },
      "tools": {
        "search": {
          "enabled": true,
          "timeoutMs": 8000,
          "maxResultBytes": 32768,
          "maxCallsPerTurn": 2
        }
      },
      "exposeTo": { "frontbrain": false, "codex": true }
    }
  }
}
```

Constraints (v1):

- ≤ 8 external servers; ≤ 32 tools listed per server.
- Server key: `^[a-z][a-z0-9_]{0,31}$` (also used as the Codex `mcp_servers`
  key and inside wire names, so hyphens are excluded).
- Tools omitted from `tools` or not `enabled: true` are never exposed to any
  consumer (explicit allowlist; one source of truth).
- A newly added external server defaults to
  `exposeTo: { frontbrain: false, codex: true }`. The 能力 panel must warn that
  Codex exposure is enabled while FrontBrain is not; adding a server to the
  FrontBrain surface requires an explicit user action and an allowlist of its
  tools. This default does not make an MCP server an agent.
- `${VAR}` interpolation for URLs / headers / env values; a missing required var
  is a configuration error (no secret echo).
- Remote HTTP requires HTTPS; loopback HTTP allowed only without auth headers.

`camera` gates the built-in Camera MCP snapshot and the Vision controller's
hidden monitoring channels together. The hardware-camera privacy toggle in the
orb is orthogonal.

For the current M1.5c production implementation, the sole camera-module source
is `NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED` → strict
`Settings.camera_module_enabled` → assembly, defaulting to `true`. The
capabilities registry does not yet control this gate. The built-in Camera MCP
is not an entry under user `mcpServers` and cannot be separately reconfigured
as an external server.

The later M3 registry will make `modules.camera.enabled` the persisted source;
at that point the explicit CLI/CI env override will take precedence (`env >
registry > true`). M3 is not implemented by the current M1.5c runtime.

### M1.5c Vision and Camera contract

The current M1.5c Vision controller owns the hidden `watch` and `guard`
channels. Its only voice entry points are `dispatch(executor: 'vision', ...)`
and `cancel(executor: 'vision', ...)`; `watch` and `guard` are never direct
model tools, and Vision does not add a separate confirmation tool. The camera
module is one assembly gate: in current M1.5c production, when
`NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED=false` resolves to
`Settings.camera_module_enabled=false`, assembly removes
`mcp__nova_camera__snapshot`, the Vision controller, and its hidden `watch` /
`guard` channels together.

Monitoring is policy-driven: the host owns sampling cadence, wake priority,
side-VLM invocation policy, and delivery mode. Watch/guard cannot alter those
policies through model output, and both remain behind the same camera-module
assembly gate.

Vision clarification is a new dispatch, not a Coding intake continuation.
On `clarification_required`, the frontend asks the user to restate the complete
condition, notification preference, and duration. That next complete user
request is sent through `dispatch(executor: 'vision', instruction: ...)` with
its own origin and revision; Vision does not retain a pending clarification.

The Camera MCP is deliberately in-process and in-memory. It supports exactly
one image result per snapshot, with supported MIME types limited to
`image/jpeg`, `image/png`, and `image/webp`. The boundary validates canonical
base64 (no alternate textual encodings, malformed padding, or hidden second
image) and the decoded payload is at most 5 MiB. The validated bytes are
written to `MediaStore`, which returns the authoritative digest and
`evidence_ref`; raw bytes, paths, and arbitrary MCP result objects do not cross
into Qwen.

The `watch_model` side VLM receives that one stored image plus the host-provided
objective; the objective input is not subject to the observation output bound.
It must produce strict JSON with exactly one `observation` string, whose
length is at most 400 characters. JSON parse failure, extra or missing fields,
an oversized observation, or model refusal fails with
`vision_description_unavailable`. The snapshot binding's provider-facing
`ToolAcceptance` / tool-result envelope must preserve that exact code (plus
only a fixed host-authored message, if the envelope includes one); it must not
remap the failure to generic `untrusted_external` or any other code. Qwen
receives only the resulting
`observation`, `captured_at`, image `dimensions`, and `evidence_ref`. Qwen's
original-image capability remains `false` pending a separately verified future
provider; an image ref in the Qwen context is evidence metadata, not an
implicit image input.

### Precedence

The registry is the source for MCP servers and the planned persisted module
enablement; current M1.5c camera enablement is sourced from the runtime env
mapping described above. Precedence for the current camera gate is simply:

1. `NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED` when set (explicit CLI / CI
   override);
2. built-in default (`true`).

When the M3 registry is implemented, camera precedence will become `env >
registry > true`, with `modules.camera.enabled` as the persisted registry
value. Precedence for the search provider is:

1. `NOVA_AUDIO_AGENT_SEARCH_PROVIDER` env, if set (CLI / CI override, logged as
   an override);
2. `modules.search.provider` in `capabilities.json`;
3. built-in default (`tavily` until the flip described below).

Desktop settings do **not** store a `searchProvider` key; the 能力 panel edits
the registry (see [06](06-settings-and-config.md) for the coordinated commit).

## Assembly filtering

1. Load and validate the registry at process start; validation errors for one
   server mark that server `failed` with a bounded reason and do not fail the
   assembly. Errors in `modules` or the document envelope fail the assembly
   (fail closed).
2. `buildAssembly` constructs adapters only when their module or server is
   enabled. The coding intake is gated by the role-level
   `modules.coding.enabled` (or the equivalent generic
   `executors.<name>.enabled` setting) and the one configured adapter whose
   manifest has `roles: ['coding']`.
3. `compileToolSchema` / Qwen session tools include only assembled manifests.
   Instruction sections describing a disabled capability are omitted.
4. Disabled search requires neither Tavily nor MCP credentials.

Disabling the unique coding-role adapter is a supported configuration, not an
assembly error: its controller and coding intake are absent. The host tools
`dispatch` / `cancel` / `confirm` remain while any other controller (such as
Vision) is registered, and are omitted only when no controllers remain.
Other direct tools, including allowlisted MCP tools, remain available.
An enabled coding role with duplicate coding-role adapters remains an
`AssemblyError`; role identity is never guessed from an executor name.

### FrontBrain visible-tool budget

After registry filtering and manifest compilation, assembly counts every tool
schema visible to the Qwen realtime FrontBrain — host/native tools, the
built-in Camera MCP, and user-selected direct MCP tools — as `N` against the
configured budget `B`. If `N > B`, assembly fails closed with
`frontbrain_tool_budget_exceeded`; the 能力 panel must show the exact `N/B`
count and the over-budget selection. It must never silently truncate a user's
allowlist or compile a partial surface.

The default `B = 24` is a candidate pending Qwen realtime live validation, not
a proven constant. The Codex projection is not subject to this realtime
budget: large user-selected MCP toolsets should be guided toward Codex, with
the separate Codex-side allowlist and visibility checks below.

## Search provider

| Provider | Selection |
|---|---|
| `tavily` (default in 03a) | default, or explicit |
| `mcp` | explicit `modules.search.provider: "mcp"` |

### MCP search transport

Port the shape of qwen’s `McpWebSearchProvider`
(`thirdparty/qwen-audio-agent/server/src/providers/search/mcp.mjs`):

- Streamable HTTP client via `@modelcontextprotocol/sdk`.
- Discover tools; require the configured tool name (default `web_search`).
- Sniff query / limit argument field names from the tool schema.
- Normalise structured results or extract links from text.
- Timeouts and max payload bounds.

Nova difference: the transport implements `SearchTransport` and feeds
`SearchAdapter`, so URL canonicalisation, digests, `web.search://` evidence
refs, and `trust: untrusted_external` are unchanged. Wire tool name stays
`search__search`.

### Bailian / DashScope preset and the default flip

- When `provider === 'mcp'` and `NOVA_AUDIO_AGENT_SEARCH_MCP_URL` is unset, the
  preset URL and tool name are used. The exact endpoint is verified against
  current DashScope / Bailian WebSearch MCP documentation at implementation time.
- Acceptance gate **before** the default changes to `mcp`: a live smoke
  (`npm run runtime:smoke:search:mcp`) against the real endpoint passes on macOS
  and Windows, the golden URL rules match, and the run is recorded with date and
  Codex/Nova versions in Getting Started. The flip is its own PR that changes
  the default in one place and updates the docs.
- `TAVILY_API_KEY` becomes optional as soon as 03a lands (disabled search or
  `mcp` provider); Desktop keeps the Tavily secret field.

## External MCP → FrontBrain

`McpExecutorAdapter` per enabled server with `exposeTo.frontbrain`. Each
allowlisted tool is a direct model-facing operation; it is not an agent
controller and never enters coding intake.

| Concern | Rule |
|---|---|
| Discovery | At assembly; an allowlisted tool missing from `tools/list` → that server `failed`, others load |
| Op names | `mcp__<server>__<alias>` (alias rules below) |
| Trust | Always `untrusted_external` on handoff |
| Channel | `mcp__<server>` (same as manifest name, preserving the runtime routing invariant) |
| Priority / wake | 40 / surrogate (same band as search) |
| Sync | `sync_result: true` when `timeoutMs ≤ 10000`; otherwise async handoff with progress |
| Bounds | per-tool `timeoutMs`, `maxResultBytes`, `maxCallsPerTurn` enforced by the adapter |

For a non-readonly direct operation, the host reuses the same
user-origin/current-turn gate primitive as `dispatch` (captured origin,
session epoch, accepted user-input revision, and the final `stillWanted`
check immediately before the call). This is an origin/provenance guard only;
it does not route the call through `dispatch` or create a project/approval FSM,
and it cannot correct an ASR semantic mishearing. Per-tool `confirm(id,
accepted)` remains a v0.2.x follow-up/non-goal.

Transports for user servers: `streamable-http` (URL + headers) and `stdio`
(command, args, env) spawned by Nova with the env allowlist and interpolated
secrets.

### Adapter to the tool compiler

MCP tools do not fit the native manifest contract as-is. The following rules
are explicit; nothing is inferred to make compilation pass.

| Topic | Rule |
|---|---|
| Readonly | `op.readonly = true` **only** when the tool’s `annotations.readOnlyHint === true`. No name heuristics. |
| Probe requirement | `ExecutorManifest` gains `probe_policy: 'readonly_ops' \| 'none'` (default `readonly_ops`, today’s behaviour). MCP manifests set `none`, which waives the “≥1 readonly op” rule. Consequences are honest: `compileProbes` emits no probe affordance for that channel; the runtime fence inside `dispatchExternal` still refuses re-dispatch after an `unknown` outcome; the handoff summary says the result is unverified. `probe_policy: 'none'` is rejected for non-`mcp__` manifests. |
| Tool alias | Wire name = `mcp__<server>__<alias>`. Normalise the MCP tool name: lower-case, any char outside `[a-z0-9_]` → `_`, collapse repeats, trim `_`. Let `budget = 64 - codePointLength("mcp__" + server + "__")` (with the max server key of 32 this is **25**). If the normalised name fits in `budget` and equals the original after charset rules, use it. Otherwise use a short form that **always** fits: `prefix + "_" + hex6` where `hex6` is the first 6 hex of `sha256(original)` and `prefix` is the first `budget - 7` code points of the normalised name (or empty if `budget < 7`, in which case use just `hex6` padded — but with server ≤ 32, `budget ≥ 25`, so the short form is always `≤18 chars>_<6 hex>`). Assert `codePointLength(wireName) ≤ 64` after construction; failure → server `failed`. The alias→original map lives in the manifest; the adapter calls the original name. Alias collision inside a server → server `failed`. |
| Params | `inputSchema` must be `type: object`. A property named `origin_ref` (host-reserved) or a non-object root → tool rejected; because the tool was explicitly allowlisted, the server is marked `failed` with reason `incompatible_tool:<name>`. |
| Description | Missing / empty description → use `MCP tool <original name> from <server>` (the compiler requires non-empty). |
| Schema depth | `prepareObjectSchema` rules apply unchanged; unsupported keywords → tool rejected → server `failed`. |

A `failed` server is visible in the 能力 panel and in `novaaudio doctor` with
its reason; it never blocks the rest of the assembly.

## External MCP → Codex

When `exposeTo.codex` is true, Nova writes the server into the private
per-workspace `CODEX_HOME/config.toml` **and** projects the tool allowlist:

```toml
[mcp_servers.example_docs]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "NOVA_MCP_EXAMPLE_DOCS_TOKEN"   # secret passed via child env, never inline
enabled = true
enabled_tools = ["search"]        # exactly the registry allowlist, original MCP names
disabled_tools = []
tool_timeout_sec = 8              # from timeoutMs, rounded up
startup_timeout_sec = 15
default_tools_approval_mode = "auto"   # see note
```

Closure rules:

1. **Config projection.** `enabled_tools` is exactly the allowlisted original
   tool names. `disabled_tools` is always `[]` (the allowlist is the single
   mechanism). stdio servers use `command` / `args` / `env` with the same env
   allowlist Nova applies for FrontBrain.
2. **Effective-config check.** `validateEffectiveCodexConfig({managedMcp})`
   requires `mcp_servers` to equal the managed set key-for-key, including each
   server’s `enabled_tools` array. Extra host servers, missing allowlists, or a
   non-empty `disabled_tools` fail the run with `config_not_isolated`.
3. **Runtime check.** After `thread/start` binds, Nova calls
   `mcpServerStatus/list` and verifies, per managed server, that the reported
   tool names are a subset of the allowlist. Any extra tool → the run fails
   before the first `turn/start` with `mcp_tools_not_isolated`; the 能力 panel
   shows the server as `failed(codex_visibility)`.
4. **Approval mode.** Exposed tools are the user’s explicit allowlist, so
   `default_tools_approval_mode = "auto"` prevents Codex from raising an MCP
   approval Nova does not route. If the pinned config schema lacks that key,
   an MCP approval prompt arriving at the broker fails closed (declined) and the
   panel copy must say Codex-side MCP calls may be refused.
5. **Bounds asymmetry.** `timeoutMs` maps to `tool_timeout_sec`.
   `maxCallsPerTurn` and `maxResultBytes` are FrontBrain-side bounds and **do
   not** apply to Codex (Codex manages its own context). The panel states this
   under the 暴露给 Codex checkbox.
6. Host `~/.codex` MCP entries are never copied into the private home.
7. `nova-knowledge` ([04](04-knowledge-base.md)) is part of the same managed
   set and follows rules 1–3 with its fixed allowlist.

This is a deliberate difference from qwen-audio-agent, where the backend loads
only its own MCP configuration. Nova projects user-selected servers because the
workspace-private `CODEX_HOME` is Nova-owned and otherwise empty.

## Desktop UI

Settings tab **能力**:

- Toggles for search / camera / coding / knowledge.
- Search sub-panel: provider radio (`tavily` / `mcp`), MCP URL / tool, live
  status, and the verification note for the preset.
- MCP server list: add / edit / enable / delete; transport fields; tool
  allowlist checkboxes after a “Probe” action (probe runs in main/backend,
  returns tool names, descriptions, and `readOnlyHint` only — never executes).
- Per-server: 暴露给前台 / 暴露给 Codex, with the bounds-asymmetry note.
- Server status column: `ok | failed(<reason>) | disabled`.
- Save → coordinated commit ([06](06-settings-and-config.md)) → backend restart.

CLI users edit `capabilities.json` or env overrides; `novaaudio doctor` reports
registry validation errors and per-server status.

## Dependency

Add `@modelcontextprotocol/sdk` to the runtime workspace with a pinned version.
No MCP SDK in the sandboxed renderer.

## Phasing

| Phase | Scope | Gate |
|---|---|---|
| M1.5c | Thin frontend contract: final six-tool Nova surface; in-process Camera MCP + side-VLM projection; Vision controller owns hidden `watch` / `guard`; camera module gate and policy-driven monitoring | Exact 6-tool compile; Camera boundary and `vision_description_unavailable` checks; Vision hidden-channel/controller checks; rerun applicable 08 live acceptance |
| 03a | Registry schema + load + precedence; module enable filters; MCP `SearchTransport` + Bailian preset (opt-in); Tavily optional | Deterministic tests green |
| 03a-flip | Default search provider → `mcp` | Live smoke recorded in Getting Started |
| 03b | `McpExecutorAdapter` + compiler adaptation; desktop MCP editor; Codex projection with closure rules 1–5 | Fake MCP server + fake app-server fixtures green; live Codex run shows only allowlisted tools |

## Verification checklist

- [ ] Registry schema rejects oversize / bad keys / missing `${VAR}`.
- [ ] Per-server failure isolates: one bad server → `failed`, others assembled.
- [ ] FrontBrain tool count is exact: the final Nova surface counts as six
      (`dispatch`, `cancel`, `confirm`, `memory__recall`, `search__search`,
      `mcp__nova_camera__snapshot`) before external direct tools; `N/B` is
      shown in the 能力 panel and `N > B` fails assembly with no truncation or
      partial tool table. The candidate default `B = 24` remains explicitly
      pending Qwen realtime live validation.
- [ ] Codex projection is excluded from the FrontBrain `N/B` count; large
      Codex-only toolsets remain available under their independent allowlist.
- [ ] A newly added external server defaults to
      `exposeTo: {frontbrain: false, codex: true}`; no server is exposed to
      FrontBrain until the user explicitly adds it and allowlists tools.
- [ ] Non-readonly direct MCP calls reject missing, stale, or mismatched
      origin/session-epoch/current-turn revision at the shared gate, with no
      approval FSM created and no dispatch/intake route. A valid call preserves
      the exact origin and revision; ASR semantic mishearing remains outside
      this provenance fence.
- [ ] Camera M1.5c: in-process/in-memory MCP accepts exactly one image with
      supported MIME (`image/jpeg`, `image/png`, or `image/webp`), canonical
      base64, and decoded bytes ≤5 MiB; it stores bytes in `MediaStore` and
      returns its digest/ref. `watch_model` must return strict JSON with only
      `observation` ≤400 chars; malformed JSON, extra/missing fields, an
      oversized observation, or model refusal returns
      `vision_description_unavailable`; the provider-facing acceptance/result
      preserves that exact code and never remaps it to a generic trust/error
      label. The input objective is not bounded by that output limit. Qwen
      receives only observation, captured_at, dimensions, evidence_ref; Qwen
      original-image capability is false until a future provider is verified.
- [ ] Disabled search / camera / coding / knowledge → tools absent from compiled
      schema and Qwen instructions.
- [ ] Fake MCP search server → `SearchAdapter` digests match golden URL rules;
      Tavily path unchanged; assembly succeeds with neither when disabled.
- [ ] Search provider precedence: env > registry > default; desktop stores no
      provider key.
- [ ] Compiler adaptation: `readOnlyHint` absent → no readonly op, manifest
      still compiles with `probe_policy: 'none'`; no probe affordance emitted;
      re-dispatch after `unknown` fenced; `probe_policy: 'none'` rejected for
      native manifests.
- [ ] Alias rules: long / non-ASCII / hyphenated tool names get deterministic
      aliases; fixture with a 32-char server key + long tool name asserts
      `codePointLength(wireName) ≤ 64` (regression for the old fixed
      `20+1+6` short form that produced 66); collision → server failed;
      `origin_ref` param → server failed with `incompatible_tool`.
- [ ] Codex projection: generated `config.toml` contains exactly the allowlist
      in `enabled_tools`; validator rejects extra servers, missing
      `enabled_tools`, non-empty `disabled_tools`.
- [ ] Fake app-server `mcpServerStatus/list` returning an extra tool → run
      fails with `mcp_tools_not_isolated` before `turn/start`.
- [ ] Secrets never appear in doctor / config error strings / generated TOML.
- [ ] Settings probe returns tool metadata without executing tools.

## Decision-record delta (apply on merge)

Add “Capability extension” and “Search transport” rows from
[00-overview.md](00-overview.md). Getting Started: Tavily remains default until
the 03a-flip PR; document DashScope MCP search as opt-in until then.

### M3 implementation transport policy

External server keys `nova_camera` and `nova_knowledge` are reserved individually
for the host-owned endpoints; another `nova_` name is allowed. A reserved external
entry reports `reserved_server_name` without preventing other servers from loading.

Startup uses bounded metadata-only discovery before the synchronous assembly
compiler. Frontend-disabled servers are not connected or spawned by this path.
The entry owns each prepared connection, including rollback if final compilation
or the exact tool budget fails. A stopped runtime never reuses these clients.
Unexpected connection closure changes that server's status to `failed`.

Stdio follows MCP SDK 1.30's platform default environment allowlist, then overlays
explicit configured `env`. On Unix the inherited keys are `HOME`, `LOGNAME`,
`PATH`, `SHELL`, `TERM`, and `USER`; Windows uses the SDK's documented system and
profile path keys. Other ambient values (including provider credentials and
`NODE_OPTIONS`) are not inherited. Stderr is piped and discarded. Protocol input
is bounded before JSON parsing. HTTP redirects and background notification streams
are disabled, and every concurrent request has its own deadline and byte bound.

External input schemas support typed objects/arrays/scalars, declared properties,
required keys, boolean additionalProperties, enums, numeric bounds and string/array
length bounds, with depth at most 8. Unsupported keywords (including references,
patterns and schema unions) fail the whole server's frontend exposure. The SDK's
AJV validator enforces accepted constraints before the call; native schemas keep
their existing contract. Missing descriptions use the specified fixed fallback.

The host's current user snapshot supplies origin, accepted input revision, local
speech-onset revision and session epoch. A nonreadonly call checks these again at
the transport send boundary. These callbacks remain in private runtime context,
not persisted delegates or memory. Tool results always remain untrusted external
content; `probe_policy: none` never promises verification after an unknown result.

### Pinned Codex 0.152 managed projection contract

The desktop entry prepares managed entries inside the enabled concrete Codex
boundary. The same prepared authority follows every ordinary, startup and project
transport. `prepareManagedCodexMcp(capabilities, trustedEntries)` is the host-only
seam for the fixed `nova_knowledge` entry; it does not relax external registry
validation. A sole `Authorization: Bearer …` header uses `bearer_token_env_var`;
other headers use `env_http_headers`. Values remain in the private child environment.

Codex 0.152 `env_vars` inherits original variable names; its object `source` means
`local` or `remote`, not an alias. Nova therefore supports credential variable names
`KEY`, `TOKEN`, `SECRET`, `PASSWORD` and application-prefixed versions, excluding
host/launcher namespaces. Unsupported settings fail only that server's Codex
exposure with `codex_env_unrepresentable`. Conflicting values for the same original
name fail every affected server with `codex_env_conflict`; Windows matching is
case-insensitive. Nova keeps its existing host environment allowlist. A future
scoped launcher adapter is needed for noncredential stdio settings.
Recognizable inline credentials in stdio command/argument text (including split
flags) fail as `codex_secret_command_unrepresentable`; supply them through the
supported environment references instead. TOML string escaping covers every
accepted string and key, including DEL, so one entry cannot break the shared file.

URLs containing interpolation, recognized credential parameters, userinfo or fragments cannot be
projected safely and fail with `codex_secret_url_unrepresentable`. Move credentials
to header references. Codex has one native timeout per server: all enabled tools
must have equal `ceil(timeoutMs / 1000)`, otherwise Codex exposure reports
`codex_timeout_unrepresentable`. No tool is silently removed or timeout enlarged.

`McpServerStatus.codex` separately reports `configured | ok | disabled | failed`
and a fixed, secret-free reason. FrontBrain status remains independent. `ok` means
one thread-scoped inventory check observed a connected server and only allowed raw
names; it is not a live tool execution claim. Any observed project visibility
failure stays visible until registry restart, even if a concurrent project passes.
Missing/disconnected servers report failed while other isolated tools remain usable.
Every run, including warm or resumed sessions, enumerates all status pages with its
own thread ID immediately before `turn/start`; unknown servers or tool names abort
the turn with `mcp_tools_not_isolated`. Effective config discrepancies use
`config_not_isolated`, admitting only the verified `environment_id = "local"`
normalization. Tool approval is `auto`, supported by the pinned schema.

UI must state: `maxCallsPerTurn` and `maxResultBytes` apply only to FrontBrain.
Codex uses its native timeout and context handling. Generated private TOML contains
references only, and host MCP configuration is never copied.
