# Task loop and executor interaction acceptance

Run against an isolated desktop profile and disposable local project. Do not use production Todos, publish artifacts, send external messages, or copy credentials into fixture files. Automated evidence and real product/device evidence are separate gates.

## Automated checks

Run serially from the repository root because runtime builds replace `runtime/dist`:

```sh
npm run test:runtime
npm run test:desktop
npm run test:cli
npm run test:server-cli
npm run lint --workspace @nova-audio-agent/runtime
npm run check
```

Focused UI: `node --test clients/desktop/test/task-handoff.test.mjs clients/desktop/test/personal-controller.test.mjs clients/desktop/test/task-detail.test.mjs clients/desktop/test/chat-pane.test.mjs`.
Host receipt coverage: `node --test runtime/dist/test/task-control.test.js` after a serial runtime build.
Capture commands, exit status, test counts, skipped checks, and named failures. Do not substitute a mocked adapter or direct host command for live acceptance.

## Real product protocol

1. Start the source desktop using a disposable `--user-data-dir` and isolated host persistence. Confirm actual configured model, Codex, and managed computer-use discovery without printing credential values. Record application revision and fixture directory.
2. Create a disposable Todo in the UI. Use its assistance action to delegate a local coding task with explicit acceptance: fix a known defect, show its failing then passing regression, and inspect the result through configured computer use. Also delegate a separate Nova-only deliverable, such as a short three-step plan.
3. Inspect both cards in their origin conversation and the tasks page. Browse, switch sessions, change conversations, blur the window, and close/reopen the inspector. Confirm none of those actions acquires or returns control. Main composer must still address Nova.
4. Explicitly take over the coding task. Verify the host controller and control revision before the executor composer enables. Send one correction to the displayed exact session; check the accepted input receipt. Leave another message unsent. Switch away and back to verify its task/session draft isolation.
5. Switch workbench to orb using the mode control; repeat through tray/hotkey/collapse requests. While awaiting acknowledgment, expect pending feedback. Only a host receipt with returned task IDs and control revisions permits the returned-to-Nova notice. Ensure every task owned by this client returns once, other clients retain control, and no draft, approval, cancellation, or extra instruction is sent.
6. Converse with Nova in orb. Verify aggregate task counts and that a decision or new result is prioritized above ongoing tool activity. Open its task link: workbench must open before detail and the controller must remain Nova. Check exact new public events since the previous view, artifacts, and outstanding decisions. Missing/truncated history must remain visibly qualified.
7. Repeat exit during an active executor turn and an actual pending approval. Existing approval identity and decision remain unchanged until explicitly acted on. Takeover does not claim physical device control; use the adapter's explicit stop/pause before manually operating its surface.
8. Interrupt the connection while an exit acknowledgment is outstanding, then reconnect. Check the original presentation request ID and parameters are retried and reconciled, with no duplicate handback or instruction. An attempted return to workbench must first reconcile the outstanding exit. Unknown input delivery remains blocked pending exact receipt reconciliation; do not resend with a new ID.
9. Observe the real Codex run repair the fixture, capture failing and passing check output, and use the real configured computer-use tool to activate the fixture and read back its result. Verify same-device calls are exclusive. Confirm task verification, completion, linked Todo projection, and artifact references. A passing executor summary alone is insufficient.
10. Close and normally restart the same isolated app profile without clearing or editing its files. Confirm the original conversation text, saved command receipts, nondefault settings, task history and Todo remain intact; memory initialization must not overwrite them.
11. Confirm the Nova-only deliverable was actually delivered and verified without a fabricated executor session. Verify keyboard opening/Back/Escape, focus restoration, narrow layouts through 959px, long activity scroll, and preserved unsent drafts. Background must stop capture and must not speak the handback notice.

## Evidence record

Complete each row with dated evidence, exact revision, and links to local logs/screenshots. An unavailable gate must name the missing provider, adapter, permission, or device prerequisite.

| Gate | Evidence at implementation handoff |
| --- | --- |
| Automated runtime/desktop/CLI checks | Runtime 2960 passed / 8 skipped; desktop 1036 passed / 3 skipped; CLI 21 passed; server CLI 4 passed; repository check passed. Final focused UI 56 passed. See isolated Task8 logs for revision and command context |
| Real Nova text/model | 2026-09-22, source desktop at `1250ae34`, isolated profile, configured qwen3.8-max: actual conversation reply and Nova-only delivery/verification observed |
| Two live tasks / takeover / accepted correction / retained draft | Actual independent Nova-only and coding tasks coexisted. At `087276bd`, new session `b669420e6e4f4f4ebc466b9c51e6cebf` accepted direct steering and acknowledged `DIRECT_INPUT_ACK_0922`. `UNSENT_DIRECT_INPUT_0922` survived orb handback and task navigation. At `437a9da7`, exact-session idle continuation produced actual sleep/test observations and task `83d72b1a-7d3c-4057-9204-67232bc81c69` visibly completed after Nova verification |
| Orb/background / tray/hotkey / reconnect / pending approval | Real workbench collapse during Codex run returned the original task to Nova; orb displayed receipt and pending command approval. Renderer reload preserved that approval and Nova ownership; one explicit read-only approval was then accepted. `UNSENT_DRAFT_0922` remained in the disabled exact-session composer, including after completion. A second real background selection also returned ownership by durable receipt. Background hotkey restoration was not established: key injection returned but CUA window access timed out, with no subsequent workbench receipt; normal quit/relaunch succeeded. Tray, voice and an interrupted handback acknowledgment remain automated-only |
| Real Codex failing-then-passing task and linked Todo | 2026-09-22 at `43e971f6`: original task `29feecdf-cbe8-41ca-aadc-d4120f590c53` completed, original goal revision 0, `todo_sync: synced`; original Todo visibly completed. Disposable fixture commit `5c06581` contains the +2 → +1 fix and failing/passing test evidence |
| Real computer-use observable result and exclusive device | Same real Codex session `ab9ec07784d04f9cadec0ea601fe8714` used managed `cua_live` native Chrome: reload showed 0, mouse click showed 1, Space activation showed 2. Exact public tool readbacks retained and `evidence/ui-readback.md` committed in fixture. Shared-device exclusion has automated coverage; a competing live physical call was not induced |
| Nova-only verified deliverable | Actual task `3dca5743-d854-4581-af8c-259493882613` completed after two explicit model corrections; full 459-character plan retained, no executor session, separate coding Todo stayed open |
| Keyboard / focus / layout | Actual 1102×768 workbench: task cards and composer do not overlap; opening detail focuses Back; Escape restores original card focus; criteria list and collapsed public receipts visible. Narrow layouts and long pagination have automated coverage; physical narrow-window acceptance remains unrun |
| Normal restart / conversation retention | Actual normal quit/relaunch at `1250ae34`, same isolated profile: five messages preserved identically, including `HISTORY_KEEP_0922_OK`; completed task and open Todo retained, GUI reconnected |

The Nova-only, normal-restart and original Todo → Codex → computer-use → Nova verification → completed Todo loop are real product evidence. Direct executor input failed explicitly on the first attempt because a new running session was still marked `starting`; the repair passed real active-turn steering and idle-session continuation. A subsequent identical-goal reconciliation wrongly incremented its revision; exact equality now preserves revision, while genuine changes remain fenced. The final read-only task completed with actual command evidence. Full suite counts above are checkpoints; later live fixes each passed their scoped tests and independent reviews (latest: task-dispatch 30, transport 107, task-loop 22, personal-tasks 7). Tests and source-app observations do not establish packaged-app or physical voice acceptance.
