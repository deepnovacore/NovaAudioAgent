# 5. Executors

Nova Audio Agent ships deterministic simulators plus adapters for search, Home Assistant, Codex,
AutoGLM, camera snapshots, Watch, and Guard. Assembly exposes only selected manifests.

Adapter-local responsibilities include:

- credential and endpoint validation;
- transport timeouts and cancellation;
- request normalization;
- output sanitization and trust classification;
- effect verification where the integration supports it.

Runtime owns the generic delegate lifecycle. Capability-specific recovery belongs in the adapter,
not in runtime branches.
