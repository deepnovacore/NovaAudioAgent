# 04. Knowledge Base (RAG)

> 摘要：新增独立的知识层 K（用户策展文档），与 L0–L4 工作区图分离。本地 SQLite Worker 存 sources / chunks / embeddings；默认 DashScope `text-embedding-v4`，local EmbeddingProvider 只预留接口、界面上不可选。混合检索（向量 + FTS5，RRF）。检索面：内置 Knowledge MCP 的 `mcp__nova_knowledge__recall`、工作单引用（只附加当前执行端能解析的定位符）、可选 Codex 用的 loopback `nova-knowledge` MCP（开启即必须提供 `get_chunk`）。数据流向在设置页明示。默认不自动注入 ContextView。

> 决定（2026-09-05，用户确认）：M4 纳入本轮实施。知识检索不新增原生语音工具，改为默认保留名称的内置 Knowledge MCP；模块默认关闭。`get_chunk` 仅投射给 Codex，导入/移除/重建仅走宿主入口。本卷描述验收目标，进度以 STATUS 台账为准。
>
> 修订（2026-09-03）：回应评审 P2-7（`knowledge://` 引用 Codex 打不开、`get_chunk` 可选、删除/重索引后失效）及产品建议「本地知识库要把数据流说清楚」「未实现的 provider 不可选」。发布门槛：本卷是否进入 v0.2.0 见 [00](00-overview.md#release-gate-for-04)。

## Baseline (before M4)

- Memory layers L0–L4 are documented in
  [`docs/archs/02-memory.md`](../../archs/02-memory.md). L1 is the workspace
  graph SQLite sidecar; there is no document corpus.
- Retrieval today is lexical only: `memory__recall` and ≤2 graph hints.
- MyContext is an optional read-only evidence adapter, off by default, not a
  document store.
- `node:sqlite` `DatabaseSync` already runs in a Worker
  (`runtime/src/workspace-graph/store-worker.ts`).
- Deferred: unrestricted long-term memory search
  ([`docs/archs/08-deferred.md`](../../archs/08-deferred.md)).

## Goals

1. Let users ingest private documents into a local store Nova can retrieve.
2. Keep knowledge as **evidence**, never instructions (invariant 10 / trust
   table).
3. Separate knowledge from the workspace graph (layer K ≠ L1).
4. Provide three controlled retrieval surfaces: FrontBrain tool, planner
   references, optional Codex MCP.
5. Default embedding via existing DashScope credentials; reserve a local
   provider port.

## Non-goals

- Shipping a full local embedding implementation in v0.2.0 (interface + settings
  enum only).
- Auto-injecting knowledge into every ContextView (no automatic recall setting is implemented).
- Merging knowledge cards into the workspace graph board.
- Multi-user sync, cloud blob storage, or proprietary vector DB requirement.
- Copying qwen’s substring-only domain library as the primary retriever
  (take the provider/untrusted rules; use real embeddings).

## Layer K

| Property | Rule |
|---|---|
| Authority | User-curated documents; lower than L0 conversation and user confirmations |
| Trust on recall | `untrusted_external` |
| Persistence | `~/.nova-audio-agent/knowledge.sqlite` (override `NOVA_AUDIO_AGENT_KNOWLEDGE_PATH`) |
| Process | Dedicated Worker; main / voice hot path never opens SQLite |
| Module gate | `modules.knowledge.enabled` in [03](03-capability-registry-and-mcp.md) |

## Store schema (content-digest migration)

Tables (conceptual):

- `sources` — id, title, kind (`file`\|`url`\|`folder_child`), locator, mime,
  fingerprint, bytes, created_at, updated_at, status
- `chunks` — id, source_id, ordinal, heading_path, text, token_estimate,
  content_digest, legacy_digest (migration compatibility only)
- `embeddings` — chunk_id, provider_id, dims, vector BLOB (float32 little-endian)
- `jobs` — id, source_id, state, error_code, updated_at
- FTS5 virtual table over chunk text + heading_path; `knowledge_metadata.fts_dirty`
  marks canonical mutations performed while FTS is unavailable.

Spike (2026-09-05, macOS): Node v22.13.0 reports `no such module: fts5`;
Node v24.8.0 supports FTS5. The Worker feature-probes it and uses bounded,
parameterized LIKE when absent (≤24 terms, ≤50 lexical candidates, existing
20k chunk ceiling). `open()` reports `{fts: boolean}`; `knowledge.status` and
the desktop panel expose the selected lexical mode. The LIKE fallback has no
lexical relevance ranking (the vector/RRF leg remains available).
An FTS-capable open transactionally builds a missing index or rebuilds one
marked dirty by fallback writes, including changes made by Node 22. Ordinary
clean opens reuse it. `forceLexical` is an internal test seam, not a user setting.
Both paths retain the same vector/RRF and citation contracts. At the 2026-09-05
spike, all 55 then-existing Knowledge tests and synthetic-document real
embedding/MCP smoke passed on Node 22.13.0; the real smoke also passed on
Node 24.8.0. The [integration review follow-up](../../handoffs/2026-09-06-integration-review-followup.md)
records the later 65-test deterministic suite on Node 24.8.0 and 22.23.2;
those deterministic counts do not establish a new real embedding smoke. Windows
remains a separate gate.

Scale target: 1k–20k chunks with brute-force cosine is acceptable; document
`sqlite-vec` as a later acceleration option.

## EmbeddingProvider

```ts
interface EmbeddingProvider {
  readonly id: string
  readonly dims: number
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>
}
```

| Provider id | Status in v0.2.0 |
|---|---|
| `dashscope` | Shipped — `text-embedding-v4` (or current DashScope embedding id verified at impl) via compatible `model_base_url` / DashScope key |
| `local` | Interface reserved. **Not selectable** in the panel (shown disabled with “即将支持”); the runtime enum accepts it only behind `NOVA_AUDIO_AGENT_EMBEDDING_PROVIDER=local` for development and then fails assembly with `embedding_provider_unavailable` |

Settings: `embeddingProvider`, `embeddingModel` (see [06](06-settings-and-config.md)).
Changing provider requires explicit reindexing to re-embed all chunks. Until then,
old-provider vectors are excluded and existing text remains lexically searchable.

### Data flow disclosure

The 知识库 panel shows this table verbatim (Chinese UI copy) before the first
ingest and next to the provider control. “Local knowledge base” means local
storage; text still leaves the machine in these cases:

| Step | What leaves the machine | To whom |
|---|---|---|
| Ingest / reindex | Full chunk text (after the sensitivity gate) | Embedding provider (DashScope by default) |
| `mcp__nova_knowledge__recall` | The query; recalled chunk excerpts are then part of the realtime model context | Embedding provider; realtime model provider |
| Work-order references / excerpts | Locators and ≤2 short excerpts inside the work order | Codex’s model provider |
| `nova-knowledge` MCP for Codex | Chunk text returned by `recall` / `get_chunk` becomes Codex context | Codex’s model provider |

Chunks never enter realtime telemetry payloads or logs.

## Ingest

Desktop tab **知识库** (only if module enabled):

- Add files / folders through Electron **main-process** native dialogs (renderer
  never supplies raw filesystem paths).
- Add URL (bounded fetch, size cap, HTML → text).
- List sources, remove, re-index, show job status.

Parsers:

| Format | Approach |
|---|---|
| text / markdown / code / json / yaml / csv | Native decode |
| PDF | `pdf-parse` (or equivalent pinned dep) |
| DOCX | `mammoth` |

Chunking: heading-aware, ~800 tokens, ~15% overlap. Reuse sensitivity gates from
`runtime/src/workspace-graph/sensitivity.ts` so credential-like spans are
refused before persistence.

Limits (v1 starting points): max source size 10 MiB; 100 sources per profile
(the internal store option can lower this cap; there is no profile setting); empty files rejected.

## Retrieval

Hybrid: vector cosine top-N ∪ FTS5 top-N → Reciprocal Rank Fusion → truncate to
`k`.

### Surface 1 — FrontBrain tool

`mcp__nova_knowledge__recall` (reserved built-in MCP server `nova_knowledge`):

```json
{
  "query": "string 1..512",
  "k": { "type": "integer", "minimum": 1, "maximum": 5 }
}
```

- Query kind; `sync_result: true`.
- Each hit ≤ 600 characters of chunk text plus a locator, title, heading_path.
- Absent / disabled module → tool not in schema.

### Locators

```text
knowledge://<source_id>/<chunk_id>?d=<content_digest_prefix>
```

- `d` is the first 12 hex of SHA-256 over UTF-8 `JSON.stringify([title,
  heading_path, text])`, before output redaction. Metadata changes also invalidate
  the old citation; embedding-provider and timestamp changes alone do not.
- Initial ingest assigns a source UUID; explicit reindex keeps it. The source
  fingerprint hashes the original document bytes and is not the source identity.
- Reindex reuses chunk UUIDs by zero-based ordinal. This is positional
  correspondence, not semantic section tracking: insertion or reordering can
  make a retained position refer to another passage, always marked `stale` when
  its content differs. Surplus old positions are deleted; new positions get UUIDs.
- Resolution semantics for `get_chunk(locator)`:

| State | Result |
|---|---|
| Chunk exists, digest matches | `ok` + text + title + heading_path |
| Chunk exists, digest differs (source re-indexed, text changed) | `stale` + current text + note; caller must not assume the quoted excerpt is still there |
| Chunk row gone (source deleted or ordinal removed) | `gone` |
| Source deleted | `gone` |

Migration of the original database adds ordinals in per-source insertion order
and backfills full content digests in one transaction, preserving source/chunk
IDs, embeddings and jobs. Original identity-tag locators remain `ok` while the
migrated content is unchanged; the first content change retires their legacy
alias so they resolve `stale` to current text. Newly returned locators always use
content digests. Deleting a source removes all its chunks; no soft-delete or
historical text archive is kept. Old references cannot recover content changes
that happened before the migration.

### Surface 2 — Work-order references (host-attached)

When intake reaches `plan.compile` ([02](02-intake-and-planning.md)) and
knowledge is enabled, the **host** (not the planner) runs one bounded recall
with the compiled objective and attaches at most 3 references — but only in a
form the current executor can open:

| Executor context | What may be attached |
|---|---|
| Codex with `knowledge.exposeToCodex = true` | `knowledge://…?d=…` locators; Codex resolves them through `nova-knowledge.get_chunk` (required tool, below) |
| Codex without exposure, source is a file inside the current workspace | Workspace-relative path + heading path (Codex opens it with ordinary file tools) |
| Codex without exposure, source outside the workspace or a URL | No locator. The host may add ≤2 `evidence_excerpts` (≤300 chars each) labelled as user-provided material |

Locators that the executor cannot resolve are never emitted. The host
re-checks `get_chunk` on each attached locator immediately before render and
drops anything not `ok`.

### Surface 3 — Codex MCP `nova-knowledge`

When `knowledge.exposeToCodex` is true (module setting):

- Nova hosts a loopback Streamable-HTTP MCP server for the process lifetime.
- Bearer token generated per launch; passed to the child as an env var referenced
  by `bearer_token_env_var` in the private Codex `mcp_servers.nova_knowledge`
  entry (managed set and closure rules from
  [03](03-capability-registry-and-mcp.md#external-mcp--codex)).
- Tools (fixed allowlist, both **required**): `recall(query, k)` and
  `get_chunk(locator)` with the resolution semantics above. No delete / ingest
  from Codex. `readOnlyHint: true` on both.
- Bind `127.0.0.1` only.
- Result bounds: `recall` ≤ 5 hits × 600 chars; `get_chunk` returns the full
  chunk (≤ chunk size cap from ingest).

## ContextView policy

There is no `knowledge.autoRecall` setting. Automatic packing of chunks into
ContextView is not implemented and would reopen the deferred “unrestricted long-term memory search”
item. Explicit tool / planner / Codex recall only.

## Phasing

| Phase | Scope |
|---|---|
| 04 | Store, worker, DashScope embeddings, ingest UI, `mcp__nova_knowledge__recall`, module toggle |
| 04b | Host-attached work-order `references` / `evidence_excerpts`, `nova-knowledge` MCP for Codex (`recall` + `get_chunk`) |

## Implementation touchpoints

| Area | Likely paths |
|---|---|
| Worker / store | `runtime/src/knowledge/` (new), mirror workspace-graph client/worker split |
| Tool | `tool-schema` + realtime recall wiring |
| Desktop | knowledge panel in settings or a sibling window; main-process dialogs |
| Deps | bounded compatible embedding HTTP client; `pdfjs-dist`; `mammoth` with `jszip` expansion preflight; MCP SDK (from 03) |

## Store shutdown

`close()` fences the client immediately and rejects pending and future requests.
It waits up to 500 ms for graceful Worker exit, within the 2-second shutdown
upper bound. This leaves 500 ms of the outer 1-second core cleanup budget for
the other resources. At the deadline it unrefs the
Worker, initiates termination and resolves best-effort. Resolution after that
deadline does **not** prove native work or SQLite locks have finished. Protocol
failure and abnormal exit remain errors. A replacement store uses normal database
admission and can fail closed with `STORE_WRITE_FAILED` if an old native lock
outlives SQLite's 1000 ms busy timeout; no concurrent write bypass is introduced.

## Verification checklist

Checked rows record the specific automated or static evidence mapped below, not
15 human/live acceptances. Real provider evidence is explicitly historical;
current rerun counts and platform skips belong in [IMPLEMENTATION](IMPLEMENTATION.md).

- [x] Worker isolation: production opens SQLite only in the store Worker;
      tests may open fixture databases to construct legacy rows or hold locks.
- [x] Sensitivity gate drops credential-like chunks.
- [x] Hybrid recall returns stable citations; empty corpus → empty ok handoff.
- [x] Legacy DB migration retains source/chunk IDs, vectors, jobs and original references;
      unchanged reindex stays `ok`, content/metadata changes become `stale`, removal becomes `gone`.
- [x] Real file reindex → store Worker → MCP returns current text/title/heading for the original stale reference.
- [x] Store close rejects pending calls immediately and initiates best-effort
      termination after a 500 ms grace period, with the shutdown limits above.
- [x] Disabled module removes `mcp__nova_knowledge__recall` from schemas.
- [x] Simulated embedding failure marks the ingest job failed without crashing
      runtime; DashScope HTTP errors are separately normalized by adapter tests.
- [x] `local` provider not selectable in the panel; env-forced `local` fails
      assembly with `embedding_provider_unavailable`, no half-written vectors.
- [x] `nova-knowledge` listens on loopback only; token required; both `recall`
      and `get_chunk` present in `tools/list`; fixture for `ok` / `stale` /
      `gone`.
- [x] Reference attachment: locators only when `exposeToCodex`; workspace paths
      only for in-workspace files; nothing else; pre-render `get_chunk` check
      drops non-`ok` locators (fixture: delete source between recall and
      render).
- [x] Data-flow table rendered in the panel before first ingest.
- [x] Explicit tool / planner / Codex recall only; no automatic ContextView injection setting.
- [x] FTS5 spike and Node 22 fallback evidence documented in the implementation ledger.
- [x] Forced LIKE tests exercise substring matching and literal underscore escaping;
      status/panel report fallback, clean FTS reopen preserves the index, and
      fallback writes/removal are reflected after an FTS-capable reopen.

### Checklist evidence map

Test filenames below are under `runtime/test/` unless a desktop path is given.
Fake embeddings exercise deterministic storage/MCP behavior without claiming a
DashScope service call or a human voice session.

| Row | Evidence and scope |
|---|---|
| 1 | Static client/Worker ownership in `runtime/src/knowledge/`; real Worker use in `knowledge-store.test.ts` |
| 2 | `knowledge-documents.test.ts`: credential-bearing text/files rejected before ingest |
| 3 | `knowledge-store.test.ts`: empty corpus and lexical/vector recall; `knowledge-mcp.test.ts`: bounded citations |
| 4 | `knowledge-store.test.ts`: legacy migration, unchanged/changed reindex and ordinal removal |
| 5 | `knowledge-mcp.test.ts`: real file → service → store Worker → MCP stale/gone lifecycle, with fake embeddings |
| 6 | `knowledge-store.test.ts`: busy Worker, unresolved termination and same-database reopen; `knowledge-service.test.ts`: deferred reindex cannot overwrite reopened store; `realtime-assembly.test.ts`: full prepared Knowledge/core/realtime cleanup settles within the outer budget |
| 7 | `knowledge-assembly.test.ts`: disabled module and exact read-only tool surface |
| 8 | `knowledge-service.test.ts`: failed reindex preserves old source and records a safe failure; `knowledge-embeddings.test.ts`: simulated HTTP failures |
| 9 | Static disabled `local` option in `desktop/ambient-orb/src/renderer/settings.html`; `knowledge-assembly.test.ts`: forced local fails before opening store |
| 10 | `knowledge-mcp.test.ts`: actual SDK/loopback authentication and strict ok/stale/gone branches; `knowledge-assembly.test.ts`: loopback projection |
| 11 | `knowledge-references.test.ts`: exposure, canonical workspace paths, stale/deleted pre-render references |
| 12 | Static disclosure table in `desktop/ambient-orb/src/renderer/settings.html`; `desktop/ambient-orb/test/knowledge-panel.test.mjs` and `knowledge-actions.test.mjs`: consent precedes ingest |
| 13 | Static registry/settings/assembly contract: no `knowledge.autoRecall` setting; explicit recall surfaces only |
| 14 | 2026-09-05 Node 22/24 FTS probe and synthetic real-provider smoke in IMPLEMENTATION; not rerun by unit tests |
| 15 | `knowledge-store.test.ts`: forced LIKE escaping and FTS reopen/rebuild; `knowledge-service.test.ts` and desktop `knowledge-panel.test.mjs`: fallback status |

## Decision-record delta (apply on merge)

Add the “Knowledge” row from [00-overview.md](00-overview.md). Keep
“unrestricted long-term memory search” deferred; note layer K explicit recall
as the allowed exception.
