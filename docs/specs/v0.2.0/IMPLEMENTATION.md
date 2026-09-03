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
- [ ] 08 project/session/work — **implemented 2026-09-04, live acceptance pending**
  (coordinator sink). Deterministic coverage is in; nothing below has been
  exercised against DashScope + a real Codex yet.
  - [x] Voice tools `dispatch(executor, instruction)` / `cancel(executor,
    instruction?)` / `confirm(id, accepted)` are single global `host` bindings
    (`work-tools.ts`, `tool-schema.ts`); executors with manifest `agent.summary`
    fold into the `dispatch.executor` enum and lose their `${name}__${op}`
    schemas (bindings stay for host routing). `confirm` selects the FSM by id
    (approval `pending_approval_id` vs project `pending_confirmation_id`).
  - [x] Intake + coordinator live in `runtime/src/executors/coding/`
    (`intake.ts`, `intake-model.ts`, `work-order.ts`); `assess` returns
    `kind / project / project_evidence / session`, gets roster ≤10 + active
    project + running works; non-active project needs `project_evidence`
    verified against the raw utterance, otherwise `unclear`; non-roster names
    are never mapped (`unclear` or explicit `create`); `create` with a goal
    runs clarify → plan → proposal `{action:'create', work_order}`; create-only
    proposes `work_order: null`; `switch` / `steer` / `cancel` route straight
    to the adapter and close the intake as `routed`.
  - [x] `AgentExecutor` port on `coding-executor.ts` (`roster`, `running`,
    `cancel`, `resolveIntakeTarget(decision)`); deterministic resolver in the
    Codex project adapter (exact roster-name match; `unknown_project` + ≤3
    suggestions, `ambiguous_project`, `busy_project`, `capacity`).
  - [x] Per-workspace run slots, `MAX_CONCURRENT_WORK = 3`, adapter-level
    cancel → `{outcome:'cancelled', reason:'user_cancelled', work_id}` through
    the normal handoff path; one `turn/interrupt` per cancelled run.
  - [x] Host-derived titles (`deriveSessionTitle`: first sentence, ≤20 code
    points) sent as `threadName`; `thread/name/updated` mirrored into
    `store.setSessionTitle`; `任务 N` defaults deleted, `beginSessionForRun`
    requires a title.
  - [x] Approval FIFO in the Codex approval controller: one voice-visible
    approval at a time, queued items start their TTL when they become head,
    invalidation is scoped per work; `ApprovalView` carries `work` (project +
    session title) and `queued`.
  - [x] Internal Codex contract collapsed to `run / steer / status / cancel`;
    the six `project` actions and two `confirm_*` ops are gone from the
    model-facing manifest.
  - [x] Desktop `project.state` gains `roster[{name, last_used_at,
    running[{work_id, title}]}]`; `pending_action` is only `create_workspace`
    and the renderer pill shows only for create. The renderer validates and
    forwards `roster` but does not draw it yet.
  - [ ] Live acceptance (below). Not yet exercised: real `thread/name/set`
    round-trip, parallel Codex children per workspace, approval queueing
    against a real app-server, and DashScope calling `dispatch` / `cancel` /
    `confirm` from the rewritten instructions.
  - Known residue: `realtime/evidence.ts` still carries speech-match branches
    for `reuse_workspace` / `select_workspace` / `resume_session`, now
    unreachable (the host emits only `create_workspace`).
- [ ] Live acceptance for 08 recorded below with DashScope + Codex 0.152.0
  evidence (transcript, tool calls, `thread/list`).

M2–M4 follow M1.5; no MCP default switch or release cut without their recorded gates.

Implementation and independent reviews used Terra and Luna for launch profiles,
settings, approval handling and progress presentation. Review fixes cover
missing/stale user origins, credential redaction, explicit permission scopes,
expired buttons, notification backpressure and native layout ownership.

## Validation (2026-09-04, 08 deterministic)

| Check | Evidence |
|---|---|
| `npm run check` | Typecheck, lint, env contract, Node parity audit (187 files / 275 reviewed occurrences), executor boundary (15 allowlisted) passed |
| `npm run test:runtime` | 2066 tests, 2064 passed, 2 platform skips, 0 failures |
| `npm run test:desktop` | 810 tests, 807 passed, 3 platform skips, 0 failures |
| `npm run test:cli` | 18 passed |

The desktop build re-runs `npm run build` for the runtime workspace, which
cleans `runtime/dist`; running `test:runtime` and `test:desktop` concurrently
makes the runtime run lose its test modules mid-flight and look hung. Run them
serially, as `npm test` does.

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
