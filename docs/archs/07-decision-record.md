# 7. Public Decision Record

| Decision | Chosen boundary | Rejected alternative |
|---|---|---|
| Continuous runtime | Events plus asynchronous slots | A nested turn loop that waits for tools |
| Canonical state | Memory receives events before projection | Provider history as the source of truth |
| Proactive attention | Surrogate evaluates ambient suggestions only | A second general-purpose conversational agent |
| Speaking ownership | One Floor-controlled FrontBrain path; preempt means interrupt Nova playback only, never user speech | Direct executor or transport speech |
| Capability extension | Manifest and adapter ports | Capability branches inside Runtime |
| Native tool surface | Five stable host/native tools plus built-in Camera MCP; external MCP is user-selected context cost, with candidate realtime budget B=24 pending live validation and no silent truncation | Growing a mandatory native tool list or silently trimming user MCP tools |
| Vision boundary | AgentController `vision` owns hidden `watch`/`guard`; direct Camera MCP is the explicit built-in exception and side VLM output is bounded evidence | Exposing monitor channels as dispatch executors or treating camera data as instructions |
| Knowledge boundary | Optional built-in Knowledge MCP, separate Worker corpus, host-only consented ingestion, bounded untrusted retrieval; Codex gets an authenticated resolver only when enabled | A new mandatory native tool, model-callable ingestion, implicit document egress, or corpus text as planning authority |
| Concurrency | Permit genuine simultaneous work across projects/repos behind a global cap and host FSM safety; keep approval FIFO/hold/release in one dedicated host module. Codex stdio can multiply to 3 projects × 8 servers = 24 child processes, so prefer streamable HTTP with a UI warning | Serializing all work or spawning unbounded per-server stdio children |
| Context | Bounded ContextView | Passing unrestricted memory to models |
| Trust | External text and images remain evidence | Treating retrieved content as instructions |
| Realtime recovery | Bounded host facts with identity fencing | Replaying arbitrary provider state |
| Desktop security | Sandboxed renderer and narrow preload API | Renderer access to Node.js or raw process control |

These decisions are architectural constraints, not implementation preferences. A future change may
replace one only when it documents the invariant being traded away and provides verification for the
new boundary.
