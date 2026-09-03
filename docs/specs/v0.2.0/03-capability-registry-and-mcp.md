# 03. Capability Registry and MCP

> 摘要：用 `capabilities.json` + 设置「能力」页统一管理内置模块（search / camera / codex / knowledge）与外部 MCP。内置仍是原生 executor，不做 in-process MCP 包装。搜索新增 MCP Provider（百炼 / DashScope WebSearch 预设）；**默认值在真实接入验证通过之前保持 Tavily**。外部 MCP 的工具白名单是唯一真相：前台按白名单装配，Codex 侧通过私有 `CODEX_HOME` 的 `enabled_tools` 投射同一份白名单，并在线程启动后用 `mcpServerStatus/list` 核对实际可见工具。MCP manifest 通过一层显式的适配规则进入现有工具编译器：不伪造只读属性，不兼容的服务器单独失效。
>
> 修订（2026-09-03）：回应评审 P1-4（白名单未在 Codex 侧闭环）、P2-5（manifest 规则与编译器不兼容）及产品建议「先验证再切默认」；再修订回应 P2（别名在 32 字符 server 下可达 66 → 按 server 长度动态预算）。

## Baseline (today)

- Always-on adapters in `buildAssembly`: search, cam, watch, guard. Configurable
  executors are only `fast_sim | slow_sim | codex`
  ([`docs/archs/05-executors.md`](../../archs/05-executors.md),
  [`docs/archs/10-executor-onboarding.md`](../../archs/10-executor-onboarding.md)).
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

## Goals

1. One registry that enables / disables built-in modules and user MCP servers.
2. Search gains an MCP web-search provider (qwen-audio-agent pattern) while
   `SearchAdapter` evidence canonicalisation stays Nova-owned.
3. User MCP tools callable by FrontBrain as `mcp__<server>__<tool>` executors.
4. Optional exposure of the **same allowlisted tools** into Codex’s private
   `CODEX_HOME`; a tool hidden from FrontBrain is hidden from Codex too.
5. Fail-closed per server; secrets via env interpolation; reload through the
   coordinated settings commit ([06](06-settings-and-config.md)).

## Non-goals

- Rewriting cam / watch / guard / Codex as MCP servers.
- Editing Codex’s own `~/.codex/config.toml` (Nova manages the per-workspace
  private home only).
- Routing MCP tool approvals from Codex through the Nova broker in v0.2.0.
- A per-tool approval broker for FrontBrain MCP calls (results stay
  `untrusted_external`; annotations are metadata, not Gateway policy).
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
    "codex": { "enabled": true },
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
      "exposeTo": { "frontbrain": true, "codex": false }
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
- `${VAR}` interpolation for URLs / headers / env values; a missing required var
  is a configuration error (no secret echo).
- Remote HTTP requires HTTPS; loopback HTTP allowed only without auth headers.

`camera` gates cam + watch + guard together. The hardware-camera privacy toggle
in the orb is orthogonal.

### Precedence

The registry is the only place module enablement, MCP servers, and the search
provider live. Precedence for the search provider is:

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
2. `buildAssembly` constructs built-in adapters only when their module is
   enabled. Codex remains behind `settings.executors` **and**
   `modules.codex.enabled`.
3. `compileToolSchema` / Qwen session tools include only assembled manifests.
   Instruction sections describing a disabled capability are omitted.
4. Disabled search requires neither Tavily nor MCP credentials.

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

`McpExecutorAdapter` per enabled server with `exposeTo.frontbrain`.

| Concern | Rule |
|---|---|
| Discovery | At assembly; an allowlisted tool missing from `tools/list` → that server `failed`, others load |
| Op names | `mcp__<server>__<alias>` (alias rules below) |
| Trust | Always `untrusted_external` on handoff |
| Channel | `mcp:<server>` |
| Priority / wake | 40 / surrogate (same band as search) |
| Sync | `sync_result: true` when `timeoutMs ≤ 10000`; otherwise async handoff with progress |
| Bounds | per-tool `timeoutMs`, `maxResultBytes`, `maxCallsPerTurn` enforced by the adapter |

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

- Toggles for search / camera / Codex / knowledge.
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
| 03a | Registry schema + load + precedence; module enable filters; MCP `SearchTransport` + Bailian preset (opt-in); Tavily optional | Deterministic tests green |
| 03a-flip | Default search provider → `mcp` | Live smoke recorded in Getting Started |
| 03b | `McpExecutorAdapter` + compiler adaptation; desktop MCP editor; Codex projection with closure rules 1–5 | Fake MCP server + fake app-server fixtures green; live Codex run shows only allowlisted tools |

## Verification checklist

- [ ] Registry schema rejects oversize / bad keys / missing `${VAR}`.
- [ ] Per-server failure isolates: one bad server → `failed`, others assembled.
- [ ] Disabled search / camera / codex / knowledge → tools absent from compiled
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
