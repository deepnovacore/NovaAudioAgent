# Node runtime migration — unreleased

gate_state: pending_external_evidence
packaged_candidate_backend: node
source_development_backend: python

This unreleased work adds repository-owned Node runtime parity and release-candidate surfaces
without claiming a shipped distribution. Packaged candidates default to Node and reject explicit
Python with `source_rollback_unavailable`; Python remains the default and executable source oracle
for source development during the rollback release.
Node Codex is app-server-only; JSONL is fixture-parser-only. HA/AutoGLM are retired in Node and
remain only in the temporary Python source rollback.

Repository additions include offline redacted diagnostics, Python-owned configuration and product
fixtures, four deterministic reducer-backed demos, a pure scorecard evaluator, and generated
bilingual environment references.

Repository-owned release work now includes signed-candidate workflows, exact seven-artifact
digests, GitHub/OIDC attestation verification, checkout-free installed-candidate smoke, bounded
authenticated control, process-tree cleanup, and packaged file-camera pass/exit-75 classification.

Pending external evidence: actual signed three-platform workflow runs, clean-machine results, live
Qwen/Volcengine/Codex, microphone/speaker, Camera/Watch/Guard hardware, WindowServer, Windows
hardware, signing/notarization authority, and publication.

The published Node-default switch and its one-release Python source rollback belong to the later
release gate. The next release after that window may remove Python and the temporary rollback-only
HA/AutoGLM source, tests, environment surface, submodule, realtime probe, launchers, and backend
switch.
