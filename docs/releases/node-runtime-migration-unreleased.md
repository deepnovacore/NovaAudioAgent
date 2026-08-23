# Node runtime migration — unreleased

gate_state: pending_external_evidence
packaged_candidate_backend: node
source_development_backend: node

This unreleased work adds repository-owned Node runtime and release-candidate surfaces without
claiming a shipped distribution. Node Codex is app-server-only; JSONL is fixture-parser-only.
HA and AutoGLM are retired.

Repository additions include offline redacted diagnostics, committed configuration and product
fixtures, four deterministic reducer-backed demos, a pure scorecard evaluator, and generated
bilingual environment references.

Audio configuration now selects `integrated` or `cascaded` at the product level. Integrated Qwen
uses `qwen-audio-3.0-realtime-plus`, `longanqian`, and one DashScope key. Cascaded defaults to
Volcengine ASR -> Qwen `qwen-flash` -> Volcengine TTS; Ark is an explicit cascaded LLM selection.
Platform keys are stored once and reused, with the Volcengine ASR override falling back to the
Volcengine big-model key. Settings changes apply on the next launch and remain credential-safe.

Repository-owned release work now includes signed-candidate workflows, exact seven-artifact
digests, GitHub/OIDC attestation verification, checkout-free installed-candidate smoke, bounded
authenticated control, process-tree cleanup, and packaged file-camera pass/exit-75 classification.

Pending external evidence: actual signed three-platform workflow runs, clean-machine results, live
Qwen/Volcengine/Codex, microphone/speaker, Camera/Watch/Guard hardware, WindowServer, Windows
hardware, signing/notarization authority, and publication.

Publication remains gated on the signed external evidence above.
