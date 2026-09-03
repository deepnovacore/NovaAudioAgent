# v0.2.0 implementation ledger

Branch: `v0.2.0dev`. Contract: [00-overview.md](00-overview.md).
Implement M1 first, keeping package versions unchanged. Use the existing Node/TypeScript
runtime, one-shot confirmation controllers, desktop settings transaction and test harness.

- [x] 01: resolve ask / ask_headless / yolo once; derive process, thread and
  effective-config validation from the same profile. Validate the pinned Codex
  0.152.0 schema and exact per-kind approval results, including denial and expiry.
- [x] 06 (M1): settings v4 migration, env contract, permissions/intake/notification
  controls; preserve safe defaults, encrypted secrets and saved/applied distinction.
- [x] 02: bound intake assessment and WorkOrder compilation, request revisions,
  independent planning/execution gates, existing confirmation and admission paths.
- [x] 05: sanitized executor progress, bounded bubble stack and native bounds
  reservation, persistent last-result access independent of notification mode.
- [x] Integration: runtime and desktop builds/tests run serially; review authorization,
  stale-result rejection, config migration and renderer bounds before completion.

Live macOS/headset and Windows acceptance remains distinct from deterministic tests.

## M1.5 (inserted before M2)

- [ ] 07 executor boundary: move Codex under `executors/codex/`, `roles` /
  `display_name` / `approvals` on the manifest, `ApprovalBroker` port, role-based
  routing, `executor.*` / `project.*` wire, fixture executor,
  `check:executor-boundary`. Behaviour identical to M1.
- [ ] 08 project/session/work: `work__dispatch / steer / status / cancel`,
  `project__sessions / create`; roster in `workspace_context`; per-session
  locks with cap 3; `cancelDelegate` + `cancelled` outcome; host-derived titles
  through `thread/name/set` / `thread/name/updated`.
- [ ] Live acceptance for 08 recorded below with DashScope + Codex 0.152.0
  evidence (transcript, tool calls, `thread/list`).

M2–M4 follow M1.5; no MCP default switch or release cut without their recorded gates.

Implementation and independent reviews used Terra and Luna for launch profiles,
settings, approval handling and progress presentation. Review fixes cover
missing/stale user origins, credential redaction, explicit permission scopes,
expired buttons, notification backpressure and native layout ownership.

## Validation (2026-09-03)

| Check | Evidence |
|---|---|
| `npm run check` | Typecheck, lint, generated environment docs and Node source audit passed |
| Runtime full suite, concurrency 4 | 2060 passed, 2 platform skips, 0 failures |
| Desktop build | Passed, including macOS native components |
| Desktop `node --test` | 807 passed, 3 platform skips, 0 failures |
| CLI tests | 18 passed |
| Codex 0.152.0 config smoke | Real app-server, isolated homes, all three profiles; no model turns |
| Renderer smoke | Passed at 100/125/150% CSS zoom; screenshots inspected |
| macOS source window | Original Electron entry emitted `source_window_ready` with an isolated canonical HOME |

The initial isolated macOS HOME used the `/var` symlink and was rejected by the
existing canonical-directory check. The final source-window run used
`/private/tmp` and passed. Windows source startup is skipped on this host.
Live voice intake, headset interaction and Windows permission/DPI acceptance
remain required before marking the full M1 acceptance gate complete.

The default-concurrency runtime run encountered a timeout in the existing
SQLite graph-transition test. Its complete test file passed 30/30 in isolation;
the final full run uses `node --test --test-concurrency=4 dist/test/*.test.js`
from `runtime/` after the checked build, without changing assertion deadlines.
That full run passed; the graph-transition case completed in 235 ms.

## Reproducible renderer check

With an existing Playwright installation, run
`node desktop/ambient-orb/scripts/renderer-progress-smoke.mjs`.
`NOVA_PLAYWRIGHT_MODULE` may point to that installation's module; set
`NOVA_BROWSER_EXECUTABLE` when using a locally installed browser. The check uses
isolated browser state and local renderer files, with fake runtime/IPC ports.
It checks 100/125/150% CSS zoom, approval expiry, three-bubble bounds, a below-orb
stack with the last-result button, and the actual settings window size.
Screenshots go to ignored `desktop/ambient-orb/build/renderer-smoke/`.
This verifies rendering and interaction, not OS DPI behavior or live audio.
