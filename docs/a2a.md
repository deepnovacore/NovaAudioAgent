# Agent-to-Agent Boundaries

Nova Audio Agent treats a remote agent like any other executor: a manifest declares its public
operations, the adapter owns its protocol, and Runtime sees only typed progress and a terminal
handoff.

```mermaid
sequenceDiagram
  participant Model as FastBrain
  participant Runtime
  participant Adapter
  participant Remote as Remote agent
  participant Memory

  Model->>Runtime: tool request
  Runtime->>Adapter: identity-bound delegate
  Adapter->>Remote: protocol-specific task
  Remote-->>Adapter: bounded progress
  Adapter-->>Runtime: typed progress
  Runtime->>Memory: append
  Remote-->>Adapter: terminal result
  Adapter-->>Runtime: handoff
  Runtime->>Memory: append before projection
```

Protocol authentication, retries, cancellation, and response validation belong inside the adapter.
The remote side cannot bypass host authorization, memory, Surrogate, or Floor. This keeps remote
capabilities replaceable without creating another conversational authority.
