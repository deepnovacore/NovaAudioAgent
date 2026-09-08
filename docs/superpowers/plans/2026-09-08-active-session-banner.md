# Active Session Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship the approved readable Nova task banner with Finder opening, exact cancellation, and optional continuous coding narration.

**Architecture:** Reuse host task identities and the authenticated desktop connection. Keep a bounded task snapshot at the desktop bridge, a small renderer controller, and task-bound host actions. Narration changes only coding progress routing and preserves existing speech admission.

**Tech Stack:** Node 22+, TypeScript, Electron, plain renderer JavaScript/CSS, node:test.

**Spec:** docs/superpowers/specs/2026-09-08-active-session-banner-design.md (user approved including section 8).

## Global Constraints

- Work only in /Users/fishwowater/sqxh/nova-audio-agent/.worktrees/active-session-banner on feature/active-session-banner.
- Normal text contrast at least 4.5:1; message text at least 14px; button targets at least 32 CSS px.
- No new runtime, model, dependency, global Codex config, merges or publishing.
- Runtime and desktop builds both write runtime/dist: coordinate and serialize builds. Parent owns final full tests.
- Preserve existing user work; group coherent implementation into one final feature commit after validation.
- Finder opens the exact work's project. Do not claim Codex session navigation works for isolated CODEX_HOME.

### Task 1: Continuous narration and executor expression

**Files:** runtime/src/config.ts, environment-contract.ts, assembly.ts, runtime.ts, realtime/service.ts and frontend-instructions.ts, executors/codex/factory.ts; desktop/ambient-orb/src/main/settings-store.mjs and backend.mjs, renderer/settings.html and settings.mjs; corresponding runtime/test and desktop/ambient-orb/test files. New small narration-policy module allowed.

**Interfaces:** Add codingProgressNarration desktop setting and corresponding runtime coding_progress_narration enum `smart | continuous`, default smart. Keep surrogate_model configured for intake. Parent does not edit these files except integration fixes after handoff. Any new voice tool must be registered through existing host tool schema and produce a typed host preference, never regex-match backend text.

- [x] Write failing routing tests: continuous new coding summary reaches Host once with zero progress surrogate calls; smart retains old routing; repeated summary stays silent; final is delivered once; monitor behavior unchanged. Add settings round-trip/default tests.
```ts
assert.equal(settings.coding_progress_narration, 'smart')
// In service harness: post two identical working summaries in continuous mode;
// assert exactly one progress host fact and no surrogate.watch progress wake.
```
- [x] Run focused tests and record the expected red before implementation.
- [x] Implement one effective coding progress policy shared by core and service, so neither duplicates nor drops progress. Keep existing floor/expiry/ownership logic. Preserve explicit user silence with a host-owned progress preference and a tested voice path. Mode switch must not restart tasks. If settings architecture requires restart, provide live authenticated preference control and reuse its state in the settings path or report a precise integration contract to parent.
```ts
type CodingProgressNarration = 'smart' | 'continuous'
// effective coding policy: continuous => progress_via_surrogate false;
// other channels retain manifest policy. Empty summaries must not narrate counters.
```
- [x] Add backend developer instructions through factory's existing developerInstructions field: concise findings/blockers/verified scope first, full work and artifacts preserved, WorkOrder constraints untouched. Verify start/resume and no steer accumulation.
- [x] Run focused regression tests, record results, self-review. No commit: parent will commit coherent feature. Write report under /tmp/nova-banner-narration-report.md.

### Task 2: Task banner, snapshot, and actions

**Files:** runtime/src/desktop-tasks.ts (new), desktop-realtime.ts, desktop-bridge.ts, desktop.ts, desktop-wire.ts, coding-executor.ts, executors/codex/adapter-project.ts; desktop/ambient-orb/src/renderer/task-banner.mjs (new), task-banner.css (new), index.html, index.mjs; main/window-position.mjs if geometry needs adjustment. Corresponding tests.

**Interfaces:** Wire frame `executor.tasks` with monotonic revision, active_project and bounded tasks; each task has work_id/executor/project/title/phase/summary/ts. Control `executor.task_action` has request_id, work_id, executor and action `open | cancel`; response `executor.task_action_result` echoes request/work and status. Host adapter exposes exact task action methods via an optional structural port, with no renderer-supplied paths.

- [x] Add failing snapshot tests for terminal absorbing state, project/title enrichment, retention/reconnect and stale event rejection. Add banner tests for sticky selection, dismiss vs cancel, terminal retention, disconnected controls, and invalid frames.
```js
assert.equal(view.selected.work_id, 'work-a')
assert.equal(view.tasks.find(t => t.work_id === 'work-a').phase, 'completed')
// A late working event must not revive work-a or select work-b.
```
- [x] Implement bounded snapshot projection using existing validated progress and public project roster, replay on authentication independently of progressBubbles filter. Add wire allowlist through generator.
- [x] Implement direct authenticated task action routing; cancel only exact currently running work. Open uses host-revalidated task workspace with platform file manager; stale task returns not_available. Echo action result and display failure; no arbitrary URL, path or shell command accepted.
```ts
interface DesktopTaskPort {
  cancelTask(workId: string): boolean
  taskDirectory(workId: string): Promise<string | null>
}
```
- [x] Implement renderer controller/mount and readable amber card. Reserve existing native bubble area for card; preserve Orb anchor and priority of confirmation UI. Arrow has descriptive title, stop waits for terminal, hide leaves Orb restore entry, multi-task selector keeps user selection. Pause 8-second terminal dismissal on hover/focus and respect reduced motion.
- [x] Integrate live frames and connection reset with renderer; suppress duplicate task progress bubbles but keep unrelated notifications. Run focused tests and capture real browser screenshots at normal and constrained layouts.

### Task 3: Integration review and delivery

**Files:** tests and modules touched above; approved spec and this plan for completion record.

- [x] Serialize runtime build/tests, desktop build/tests, root check; save full logs in /tmp and inspect all failures.
```sh
npm run test:runtime
npm run test:desktop
npm run check
git diff --check
```
- [x] Review complete diff against spec, including live mode changes and explicit silence, open/cancel target binding, reconnect, contrast and layout. Delegate fresh bounded review per implementation unit and whole branch review; fix concrete findings and rerun only affected tests.
- [x] Update spec status, capture screenshots and report tested versus unavailable native/voice/platform acceptance. Commit complete feature, keep branch/worktree for user.

## Execution ledger

- Design approved including continuous narration. Existing baseline progress/window tests: 25 passed.
- Ruling: Finder is the supported initial open target — user explicitly accepts it and Codex desktop visibility for managed home is unverified — cost is no direct conversation navigation.
- Ruling: Inline parent handles task 2 while a fresh implementer handles independent task 1, per execution skill's subagent recommendation; no shared file ownership or concurrent builds.
- Preflight: config/ui/speech constraints => Task 1; snapshot/actions/layout/accessibility => Task 2; real validation/review => Task 3. No uncovered spec requirements identified.

- Implemented smart/continuous shared host preference, authenticated voice preference tool, cross-mode deduplication and lifecycle cleanup. Continuous bypasses coding progress Surrogate only; intake and other channels remain intact.
- Implemented bounded authenticated task snapshots, exact task open/cancel, socket-generation checks, Finder workspace opening, readable amber card, selection/hide/restore and terminal timers.
- Review repairs: old socket queued actions cannot execute under new connection; independent alerts survive combined-area suppression; native capacity is six rows; terminal timers chain; fallback suppression persists through native drag callbacks.
- Browser smoke passed real renderer with simulated tasks at 1x/1.5x/2x zoom, long-text focus scrolling, above/below layout, small-screen alert priority, exact actions, disconnect and live mode. Minimum measured text contrast over white wallpaper: 10.36:1. Preview artifacts: output/playwright/task-banner/ (not committed).
- Native macOS Finder opener successfully launched this worktree directory. Native Electron ABI check passed. This does not constitute real Codex task / live ASR-TTS acceptance. Windows/Linux native UI and measured speech latency/cost remain unverified.
- Full-suite run exposed an existing approval fixture race: terminal completion could close stdin before the FIFO response-count probe. Reused the existing held-terminal barrier and release after the probe; preserved exactly-one-response assertion.
- Final verification: `npm test` exited 0 — Runtime 2393 passed / 5 skipped, Desktop 913 passed / 3 skipped, CLI 21 passed. Windows-only source-startup smoke skipped on macOS. Full log: /tmp/nova-banner-final-tests.log.
- Final read-only branch review: no remaining actionable findings after fallback-state regression repair. `git diff --check` passed. Branch/worktree retained without merge, push or release.
- Final `npm run check` exited 0: typecheck, lint, environment/wire contracts, Node parity (231 files / 394 reviewed occurrences), executor boundary and capability drift checks passed. Log: /tmp/nova-banner-final-check.log.
