# 9. Roadmap

The current foundation includes the runtime spine, bounded memory views, executor ports, search,
Codex with named Workspaces and Sessions, integrated and cascaded realtime voice, the opt-in
workspace memory graph, the Ambient Orb, local Chinese wake-word detection and host-owned
cascaded response scheduling. Vision's M1.5c thin-frontend contract and live/Windows acceptance
remain pending evidence.

Product direction for the next minor line is specified on branch `v0.2.0dev` in
[`docs/specs/v0.2.0/`](../specs/v0.2.0/00-overview.md): cross-platform Codex approvals and YOLO,
intake and planning, the capability registry / MCP (MCP search opt-in until verified, then default
flip), the private knowledge
base, and progress bubbles. Those specs propose decision-record deltas; they do not land as code
until each volume’s verification checklist is green.

## v0.2dev sequencing and evidence

The dependency order is **M1.5b → M1.5c → 03a**. M1.5c is the thin FrontBrain frontend gate:
the final six-tool surface, built-in Camera MCP plus VLM projection, Vision-owned hidden
`watch`/`guard`, policy-driven monitoring, and a rerun of the 08 live acceptance checklist must be
verified before 03a capability expansion. The candidate realtime tool budget `B=24` is a pending
Qwen live-validation value, not a proven constant; Codex projection is outside that budget.

External MCP settings are not presented as shipped. `FASTBRAIN_SYSTEM` remains deferred legacy/dead
code rather than a live second model or planning path. Live-provider and Windows gates stay pending
until their evidence is recorded.

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

`v0.2.0dev` integration requires automated checks. Merging into `main` requires all feature
acceptance in [RELEASE-GATE.md](../specs/v0.2.0/RELEASE-GATE.md), including human voice and
installed Windows wake-word checks. Linux release artifacts are deferred; Ubuntu source tests remain.
