# 04. Knowledge Base (RAG)

> 摘要：新增独立的知识层 K（用户策展文档），与 L0–L4 工作区图分离。本地 SQLite Worker 存 sources / chunks / embeddings；默认 DashScope `text-embedding-v4`，local EmbeddingProvider 只预留接口、界面上不可选。混合检索（向量 + FTS5，RRF）。检索面：FrontBrain `knowledge__recall`、工作单引用（只附加当前执行端能解析的定位符）、可选 Codex 用的 loopback `nova-knowledge` MCP（开启即必须提供 `get_chunk`）。数据流向在设置页明示。默认不自动注入 ContextView。
>
> 修订（2026-09-03）：回应评审 P2-7（`knowledge://` 引用 Codex 打不开、`get_chunk` 可选、删除/重索引后失效）及产品建议「本地知识库要把数据流说清楚」「未实现的 provider 不可选」。发布门槛：本卷是否进入 v0.2.0 见 [00](00-overview.md#release-gate-for-04)。

## Baseline (today)

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
- Auto-injecting knowledge into every ContextView (`autoRecall` default off).
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

## Store schema (v1)

Tables (conceptual):

- `sources` — id, title, kind (`file`\|`url`\|`folder_child`), locator, mime,
  fingerprint, bytes, created_at, updated_at, status
- `chunks` — id, source_id, ordinal, heading_path, text, token_estimate,
  content_digest
- `embeddings` — chunk_id, provider_id, dims, vector BLOB (float32 little-endian)
- `ingest_jobs` — id, source_id, state, error_code, updated_at
- FTS5 virtual table over chunk text + heading_path

Spike before implementation: confirm FTS5 is available in Node 22’s bundled
SQLite. If not, ship trigram / LIKE fallback and note FTS5 as follow-up.

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
Changing provider requires re-embed of all chunks (ingest job: `reindex`).

### Data flow disclosure

The 知识库 panel shows this table verbatim (Chinese UI copy) before the first
ingest and next to the provider control. “Local knowledge base” means local
storage; text still leaves the machine in these cases:

| Step | What leaves the machine | To whom |
|---|---|---|
| Ingest / reindex | Full chunk text (after the sensitivity gate) | Embedding provider (DashScope by default) |
| `knowledge__recall` | The query; recalled chunk excerpts are then part of the realtime model context | Embedding provider; realtime model provider |
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

Limits (v1 starting points): max source size 10 MiB; max sources per profile
configurable (suggest 100); empty files rejected.

## Retrieval

Hybrid: vector cosine top-N ∪ FTS5 top-N → Reciprocal Rank Fusion → truncate to
`k`.

### Surface 1 — FrontBrain tool

`knowledge__recall`:

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

- `chunk_id` is stable for the life of a chunk row; `d` is the first 12 hex of
  the chunk’s `content_digest`.
- Resolution semantics for `get_chunk(locator)`:

| State | Result |
|---|---|
| Chunk exists, digest matches | `ok` + text + title + heading_path |
| Chunk exists, digest differs (source re-indexed, text changed) | `stale` + current text + note; caller must not assume the quoted excerpt is still there |
| Chunk row gone (source deleted or re-chunked) | `gone` + source title if the source still exists |
| Source deleted | `gone` |

Re-index creates new chunk rows; old locators resolve to `gone`. Removal of a
source removes its chunks. There is no soft-delete; the point is that a
locator is never silently re-pointed at different text.

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

`knowledge.autoRecall` defaults **false**. Automatic packing of chunks into
ContextView would reopen the deferred “unrestricted long-term memory search”
item. Explicit tool / planner / Codex recall only.

## Phasing

| Phase | Scope |
|---|---|
| 04 | Store, worker, DashScope embeddings, ingest UI, `knowledge__recall`, module toggle |
| 04b | Host-attached work-order `references` / `evidence_excerpts`, `nova-knowledge` MCP for Codex (`recall` + `get_chunk`) |

## Implementation touchpoints

| Area | Likely paths |
|---|---|
| Worker / store | `runtime/src/knowledge/` (new), mirror workspace-graph client/worker split |
| Tool | `tool-schema` + realtime recall wiring |
| Desktop | knowledge panel in settings or a sibling window; main-process dialogs |
| Deps | embedding HTTP client; `pdf-parse`; `mammoth`; MCP SDK (from 03) |

## Verification checklist

- [ ] Worker isolation: main thread tests never open the DB file directly.
- [ ] Sensitivity gate drops credential-like chunks.
- [ ] Hybrid recall returns stable citations; empty corpus → empty ok handoff.
- [ ] Disabled module removes `knowledge__recall` from schemas.
- [ ] DashScope embed failure marks ingest job failed without crashing runtime.
- [ ] `local` provider not selectable in the panel; env-forced `local` fails
      assembly with `embedding_provider_unavailable`, no half-written vectors.
- [ ] `nova-knowledge` listens on loopback only; token required; both `recall`
      and `get_chunk` present in `tools/list`; fixture for `ok` / `stale` /
      `gone`.
- [ ] Reference attachment: locators only when `exposeToCodex`; workspace paths
      only for in-workspace files; nothing else; pre-render `get_chunk` check
      drops non-`ok` locators (fixture: delete source between recall and
      render).
- [ ] Data-flow table rendered in the panel before first ingest.
- [ ] `autoRecall` off: ContextView goldens unchanged.
- [ ] FTS5 spike result documented in the PR that lands 04.

## Decision-record delta (apply on merge)

Add the “Knowledge” row from [00-overview.md](00-overview.md). Keep
“unrestricted long-term memory search” deferred; note layer K explicit recall
as the allowed exception.
