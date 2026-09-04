# 11. Vision

Vision is the current M1.5c thin-frontend contract. The `vision` AgentController owns hidden
`watch` and `guard` channels; the only model dispatch/cancel target is `vision`. The camera module is
not a separate Vision executor: it provides the built-in direct Camera MCP
`mcp__nova_camera__snapshot` and removes camera MCP plus Vision hidden channels when disabled.

The Camera MCP is in-process/in-memory and returns exactly one image with a supported MIME type
(`image/jpeg`, `image/png`, or `image/webp`), canonical base64, and decoded size at most 5 MiB.
`MediaStore` records a digest/reference; it does not expose a local path. `watch_model` is a side VLM
that must produce strict JSON with an objective `observation` no longer than 400 characters. Qwen
receives only `observation`, `captured_at`, `dimensions`, and `evidence_ref`; original-image capability
is false pending a verified future provider. Parse failure, oversize output, or model refusal becomes
the typed `vision_description_unavailable` failure.

The direct snapshot is pull-shaped. Watch and Guard add repeated observation with different attention
and policy, while preserving the same untrusted-evidence rule. Preemptive means interrupting Nova
playback, never user speech. Text visible inside an image is never an instruction.

Supported sources are disabled, a local camera through Chromium's capture pipeline, and an explicit
video file. File sources are
useful for deterministic demonstrations such as the
[cat-sofa fixture](../../assets/demos/cat-sofa-guard/README.md).
