# 5. Executors

Nova Audio Agent ships deterministic simulators plus adapters for search, Codex (app-server),
`cam` snapshots, Watch, and Guard. Assembly always includes search, cam, watch, and guard;
configuration selects only `fast_sim`, `slow_sim`, or `codex`. Codex ships base (`run` / `status`),
live (`steer`), and project (`project` / `confirm_project_action`) manifests. Realtime additionally
exposes the non-executor `memory.recall` query tool.

Adapter-local responsibilities include:

- credential and endpoint validation;
- transport timeouts and cancellation;
- request normalization;
- output sanitization and trust classification;
- effect verification where the integration supports it.

Runtime owns the generic delegate lifecycle. Capability-specific recovery belongs in the adapter,
not in runtime branches.
