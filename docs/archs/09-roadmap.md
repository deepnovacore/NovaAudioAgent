# 9. Roadmap

The current foundation includes the runtime spine, bounded memory views, executor ports, search,
Codex with named Workspaces and Sessions, vision, integrated and cascaded realtime voice, the
opt-in workspace memory graph, and the Ambient Orb.

Product direction for the next minor line is specified on branch `v0.2.0dev` in
[`docs/specs/v0.2.0/`](../specs/v0.2.0/00-overview.md): cross-platform Codex approvals and YOLO,
intake and planning, the capability registry / MCP (MCP search opt-in until verified, then default
flip), the private knowledge
base, and progress bubbles. Those specs propose decision-record deltas; they do not land as code
until each volume’s verification checklist is green.

Near-term engineering work that stays evidence-backed regardless of product features:

1. repeatable live-provider soak tests;
2. public integration examples using synthetic data;
3. desktop accessibility and packaging polish;
4. clearer adapter authoring tests and templates;
5. measured context and latency optimization.

New core abstractions are not roadmap items by themselves. They require a demonstrated boundary that
the current architecture cannot express safely.

Product-level direction also lives in the README Roadmap section; the items here remain
evidence-backed engineering improvements alongside the v0.2.0 spec series.
