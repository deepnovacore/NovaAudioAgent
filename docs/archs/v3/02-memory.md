# 2. Memory

Nova uses several memory layers with deliberately different authority. They are not one global bag
of prompt text.

## Layers

- **L0 — causal runtime blackboard.** `Memory` channels and structured intent, goal, authorization,
  active delegates, and current work-order state are the live session truth. Entries carry time,
  trust, priority, outcome, and evidence references. Applying an event precedes any response derived
  from it. Only the causal runtime owns current task/executor state.
- **L1 — durable workspace observation store.** A dedicated Worker owns SQLite, append-only gated
  observations, operation receipts, identity bindings, projection records, and optimistic revisions.
  The main thread and voice hot path never open SQLite. One transaction persists an observation and
  its authenticated identity/projection deltas; a publication is produced only after commit.
- **L2 — workspace cards.** Logical workspaces, concrete instances, and relation cards summarize
  revisioned evidence and provenance with status and confidence; observations retain their own
  trust classification. Cards remember the map between projects, not another project's files, work
  orders, branches, or current executor state.
- **L3 — published graph.** An immutable `PublishedGraphSnapshot` is the only durable-graph state
  visible to main-thread consumers. Recall, board, and `GraphContext` projections impose their own
  independent bounds. The read-only graph board is a separate allowlisted UI projection of the
  snapshot. It exposes safe metadata and evidence counts, never paths, relation reasons, evidence
  bodies, aliases, or mutation commands.
- **L4 — recall and explanation projections.** `GraphRecall` and `ContextBudgeter` read only the
  latest published snapshot. Automatic recall is local, intent-matched, suggestion-only, and has no
  global or recency fallback. An explicit evidence request may additionally query a compatible
  MyContext adapter for the authoritative current workspace; those results remain untrusted,
  non-persistent explanation data.

## Authority and failure boundaries

The SQLite sidecar is the source of truth only for workspace-memory observations, cards, relations,
and receipts. L0 remains authoritative for the present conversation and work. A graph hint cannot
authorize a tool, mutate a task, inspect another workspace, or become a user instruction.

All discovery and free-text fields pass path/content sensitivity gates before persistence. Denied
paths and credential spans do not become observations, diagnostics, snapshots, prompts, or host
items. Agent/model prose is not user evidence. ASR aliases are low-confidence candidates and cannot
route; their candidate observations may remain private durable evidence but never become published
card aliases. Only an explicit user confirmation can create a durable alias. The three-state merge
distinguishes confirmation, supplement, and conflict; confirmed user evidence outranks lower-trust
evidence, while conflict retains evidence without overwriting confirmed user wording. Suppression
is a separate durable relation state that prevents later recall.

Publication is last-good: a locked, unavailable, or failed store leaves the prior immutable snapshot
readable with a degraded marker. Bounded compaction retains the 512 most recent observations per
logical workspace subject to a 4096-observation global ceiling. Observation pruning does not cascade
into relation cards, evidence, projection provenance, or suppression history. A separate derived-row
bound may remove overflow inactive workspace instances and stale relation cards; evidence belonging
to a removed stale relation follows that card, while active, weak, and suppressed relations remain.
The configured receipt-retention/idempotency invariants are separate again; sufficiently old
overflow receipts may be pruned after their retention window. The service requests advisory
compaction on startup and after every 64 successful observation writes. A compaction failure is
visible as a fixed diagnostic, is retried after the next successful observation write, and cannot
turn an already committed graph write into a failure. Compaction cannot lock out a later valid
write. No graph operation reads work state from a second workspace.

Adjacent authoritative committed workspace transitions contribute only weak `discussed_with`
metadata. The runtime records a fixed, non-imperative reason and one runtime evidence reference; it
does not derive a relation from model/work-order prose or read either workspace. Reopening a
workspace also performs bounded maintenance: relation cards not refreshed for 90 days are marked
stale with their evidence retained. Committed transitions are admitted in host order: admission
synchronously revokes the old current scope, while a bounded FIFO preserves A→B→C adjacency as
A→B and B→C. If an admitted event must be dropped, inference fails closed rather than bridging
the unknown gap. The same gap fence applies when an admitted event cannot be resolved or committed:
the next successful workspace becomes a fresh anchor and only its successor may create a new edge.
All durable graph timestamps use Unix seconds; the causal runtime's monotonic clock is not a
persistence clock.

Transition provenance is authenticated independently of the caller's projected result. Inside the
atomic store transaction, Nova re-runs the pure projector against current state and requires an
exact delta match. This prevents a fixed transition cue from smuggling arbitrary wording,
confidence, status, or evidence. A weak transition may supplement an existing higher-authority
relation, but it cannot replace that relation's confirmed wording, confidence, or state.

Schema-v3 relation receipts contain the complete gated historical result and therefore replay
exactly even after the current relation advances. Historical schema-v2 receipts did not persist that
payload. Migration retains those receipt rows and may reconstruct a result only while the matching
relation revision is still current; after the relation advances, the old operation returns the
stable `STORE_OPERATION_CONFLICT` error. Nova never fabricates a historical card or discards the
retained receipt to claim success.

Database upgrades are explicit and transactional. Nova validates the exact STRICT table columns,
unique keys, composite foreign key, and receipt autoincrement invariant for the recorded version,
applies v1→v2 and v2→v3 steps in order, validates the resulting v3 schema, and only then commits the
new version rows. An unversioned partial schema or a recorded legacy schema with missing, extra, or
incompatible structure fails with `STORE_MIGRATION_FAILED`; it is never merely stamped as current.

## Optional MyContext gain and limits

Nova's graph is project-wide and derived from authoritative workspace lifecycle. MyContext can add a
different, person-wide signal: bounded evidence from meetings, notes, and other configured sources.
That gain is available only through an explicit same-current-workspace recall and a versioned,
read-only capability handshake. The adapter is off by default; provider text is neutralized,
untrusted, and never written into the graph or injected automatically.

Raw upstream MyContext capabilities schema v2 is not Nova's exact-workspace evidence protocol, so it
fails closed. Installing MyContext alone does not activate enrichment: this repository bundles no
MyContext code, runtime, or compatible adapter executable.
