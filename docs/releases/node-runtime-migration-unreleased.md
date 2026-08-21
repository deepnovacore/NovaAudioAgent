# Node runtime migration — unreleased

gate_state: pending_external_evidence
default_backend: python
node_availability: opt_in_source_development

This unreleased work adds repository-owned Node runtime parity surfaces without claiming a shipped
distribution. Python remains the default and executable source oracle during the rollback release.
Node Codex is app-server-only; JSONL is fixture-parser-only. HA/AutoGLM are retired in Node and
remain only in the temporary Python source rollback.

Repository additions include offline redacted diagnostics, Python-owned configuration and product
fixtures, four deterministic reducer-backed demos, a pure scorecard evaluator, and generated
bilingual environment references.

Pending external evidence: built-artifact inspection, three-platform installer jobs,
clean-machine/no-Python launch, descendant cleanup, live Qwen/Volcengine/Codex, microphone/speaker,
Camera/Watch/Guard, WindowServer, Windows hardware, signing/notarization, and publication.

The Node-default switch and the published one-release Python source rollback belong to the later
release gate. The next release after that window may remove Python and the temporary rollback-only
HA/AutoGLM source, tests, environment surface, submodule, realtime probe, launchers, and backend
switch.
