# 3. Context View

Models never receive unrestricted memory or a raw workspace graph. `ContextView` is the only bounded
call-level model projection: recent conversation, relevant channel evidence, structured state,
active delegates, and—when present—one immutable `GraphContext`. `GraphContext` is the sole graph
projection allowed to feed `ContextView`; the graph board is a separate read-only UI projection and
is never model context.

## Bounded graph projection

`ContextBudgeter` emits fixed, authority-labelled wrappers:

- a `<workspace_context kind="data">` Header identifying only the current logical workspace and
  instance plus bounded preferences; and
- an optional `<workspace_hints authority="suggestion_only"
  scope="current_workspace_next_step" cross_workspace="forbidden" action="forbidden">` Recall Pack
  containing at most two whole, intent-matched relation hints and one evidence pointer per hint.

There is no relation-only fallback. Items are structurally neutralized and dropped whole rather than
clipped. Token estimates, Unicode code-point limits, and UTF-8 byte limits all apply; the strictest
limit wins. The blocks render after runtime material and before intent, goal, and authorization, so
their lower authority is explicit without displacing the current user request.

Hints can only suggest a next step inside the current workspace. They never request or execute a
workspace switch, inspect another workspace, call an action tool, or act as user instructions.
Detailed provider evidence is returned only by explicit explanation/recall and is not automatically
added to Header, Recall Pack, or `ContextView`.

At the actual model-call boundary, `RealtimeAssembly` owns one synchronous graph-context provider
binding on the causal runtime. The binding uses the latest accepted user text, the authoritative
current workspace instance, and the current provider-session epoch, then calls the graph service's
snapshot-only turn projection. It performs no store, filesystem, provider, or workspace I/O. An
absent scope, malformed result, or exception omits `graph_context` and never delays or rejects the
model call. Assembly shutdown releases the binding.

An authoritative committed-workspace event revokes the prior model/provider graph scope
synchronously at event admission, before queued graph persistence begins. A bounded FIFO retains
every admitted transition in host order. Older queued commits may persist their adjacency evidence,
but generation fencing prevents them from restoring stale model context or a stale Header after a
newer commit has been admitted. Their resolved host-to-instance mapping remains available for typed
terminal events already associated with that workspace; that durable event mapping is not current
model scope. Queue overflow or a resolution/commit failure breaks the adjacency anchor instead of
inventing an edge across a dropped or unknown event.

## Realtime delivery truth

`workspace_context` is an inject-only host item. It cannot become a host response intent or user
activation, and a provider may deliver it only through a proven replacement/refresh capability.
Qwen Header replacement uses an ordered delete-confirm then distinct create-confirm protocol, so a
new committed workspace supersedes the provider-visible prior Header rather than accumulating stale
items.

Qwen's server-VAD path does not expose a documented pre-response hook for context derived from the
accepted transcript. Its per-turn Recall Pack capability is therefore deliberately `unavailable`:
Nova does not inject a late pack, cancel/recreate the response, or claim that the current response saw
it. Qwen voice receives the bounded Header at session start and confirmed workspace changes; the
causal runtime's model-call projection still performs automatic snapshot-only relation recall
without creating a late Qwen provider item. Providers without a proven delivery capability remain
unavailable, and graph failure never blocks the normal response path.

These boundaries keep provider sessions replaceable and prompt cost bounded while preserving L0 and
the durable workspace store as independent sources of truth.
