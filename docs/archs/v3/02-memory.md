# 2. Memory

Memory is the canonical state shared by runtime and model calls. Channel entries record conversation,
executor observations, progress, and terminal outcomes. Structured state separately tracks intent,
goal, and authorization and can be changed only by FastBrain.

Entries carry time, trust, priority, and bounded content. Applying an event to memory precedes any
suggestion or response derived from that event. This ordering lets the system defer speech without
losing the underlying fact.

Persistence is intentionally outside the core contract. A deployment may add storage as long as it
preserves append order, trust labels, and bounded reads.
