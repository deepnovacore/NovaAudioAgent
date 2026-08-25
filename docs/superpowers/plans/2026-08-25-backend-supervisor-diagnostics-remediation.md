# Backend Supervisor Diagnostics Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop endless opaque respawn loops by classifying backend failures into stable user-actionable states and applying jittered retries only to recoverable failures.

**Architecture:** A small diagnostic classifier converts construction, exit, and bounded stderr signals into a closed failure enum. The supervisor owns the state machine and timer policy; main/preload/renderers receive sanitized status objects without raw exceptions, output, credentials, or filesystem details.

**Tech Stack:** Electron main/preload/renderer, Node.js utility process APIs, TypeScript runtime diagnostics, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-cross-platform-desktop-design.md`

## Global Constraints

- Public states are `starting`, `connected`, `reconnecting`, `configuration_required`, `authentication_failed`, `unavailable`, and `stopped`.
- Configuration and authentication failures are terminal until an explicit retry or settings change.
- Recoverable failures use capped exponential backoff with injected jitter; all timers are cancellable.
- Renderer diagnostics are stable codes and safe Chinese copy only; raw stderr, tokens, URLs with credentials, and arbitrary exception messages never cross IPC.

---

### Task 1: Closed Failure Classification

**Files:**
- Create: `desktop/ambient-orb/src/main/backend-diagnostics.mjs`
- Create: `desktop/ambient-orb/test/backend-diagnostics.test.mjs`
- Modify: `runtime/src/desktop-entry.ts`
- Modify: `runtime/test/desktop-realtime.test.ts`

**Interfaces:**
- Produces: `BackendFailureKind = 'configuration_required' | 'authentication_failed' | 'unavailable' | 'recoverable'`.
- Produces: `classifyBackendFailure(input): {kind:BackendFailureKind, code:string}`.
- Produces: runtime diagnostic lines matching `[runtime-diagnostic] <stable-code>` with no exception message.

- [ ] **Step 1: Write classifier and runtime diagnostic failing tests**

Cover missing model/API configuration, invalid Codex host configuration, provider 401/403, missing native/runtime resource, abnormal transport exit, and unknown exceptions. Assert hostile exception text and secrets are absent from outputs.

- [ ] **Step 2: Run focused tests**

Run: `node --test desktop/ambient-orb/test/backend-diagnostics.test.mjs && npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/desktop-realtime.test.js`

- [ ] **Step 3: Implement stable classification and bounded emission**

Map known configuration error codes to `configuration_required`, provider authentication evidence to `authentication_failed`, missing executable/resource evidence to `unavailable`, and remaining lifecycle failures to `recoverable`. The runtime emits codes only.

- [ ] **Step 4: Re-run focused tests**

Run: `node --test desktop/ambient-orb/test/backend-diagnostics.test.mjs && npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/desktop-realtime.test.js`

- [ ] **Step 5: Commit classifier**

Commit message: `fix: classify backend startup failures`

### Task 2: Supervisor State Machine And Jitter

**Files:**
- Modify: `desktop/ambient-orb/src/main/backend-supervisor.mjs`
- Modify: `desktop/ambient-orb/test/backend-supervisor.test.mjs`

**Interfaces:**
- Consumes: `start(onExit)` rejects or calls `onExit` with `{kind,code}`.
- Produces: status `{state, connection:null|object, retryInMs:null|number, diagnostic:null|string}`.
- Produces: injectable `random(): number` and policy `{baseMs:1000, capMs:30000, jitterRatio:0.2}`.

- [ ] **Step 1: Replace legacy-state tests with state-table tests**

Assert successful start reaches `connected`; recoverable failure reaches `reconnecting` and schedules jitter within the bounded window; configuration/auth failures schedule no timer; unavailable schedules retry only after explicit `retry()`; `restart()` cancels pending timers and resets attempts; `stop()` is terminal.

- [ ] **Step 2: Run supervisor tests and confirm failures**

Run: `node --test desktop/ambient-orb/test/backend-supervisor.test.mjs`

- [ ] **Step 3: Implement the closed state machine**

Remove `idle`, `ready`, `retry_wait`, and `disconnected`; compute `min(capMs, baseMs * 2 ** attempt)` and multiply by deterministic injected jitter in `[1-jitterRatio, 1+jitterRatio]`; publish the safe diagnostic code on terminal/unavailable states.

- [ ] **Step 4: Run supervisor tests**

Run: `node --test desktop/ambient-orb/test/backend-supervisor.test.mjs`

- [ ] **Step 5: Commit supervisor policy**

Commit message: `fix: make backend retries failure-aware`

### Task 3: Main, Preload, Orb, And Settings Diagnostics

**Files:**
- Modify: `desktop/ambient-orb/src/main/main.mjs`
- Modify: `desktop/ambient-orb/src/preload/preload.cjs`
- Modify: `desktop/ambient-orb/src/renderer/state.mjs`
- Modify: `desktop/ambient-orb/src/renderer/index.mjs`
- Modify: `desktop/ambient-orb/src/renderer/settings-controller.mjs`
- Modify: `desktop/ambient-orb/src/renderer/settings.mjs`
- Modify: `desktop/ambient-orb/src/renderer/settings.html`
- Modify: `desktop/ambient-orb/test/preload.test.mjs`
- Modify: `desktop/ambient-orb/test/state.test.mjs`
- Modify: `desktop/ambient-orb/test/settings-panel.test.mjs`
- Modify: `desktop/ambient-orb/test/main-security.test.mjs`

**Interfaces:**
- Produces: preload `onBackendStatus(callback)` for the sanitized supervisor status.
- Produces: preload `retryBackend()` invoking a sender-validated IPC command.
- Changes: settings `backendStatus` uses the new public state enum and diagnostic-code copy map.

- [ ] **Step 1: Add failing IPC and rendering tests**

Assert no raw stderr crosses the status channel; terminal states show the correct actionable copy and retry control; reconnecting displays a bounded delay; orb distinguishes disconnected/reconnecting from configuration/auth failures; only the orb/settings webContents can invoke retry.

- [ ] **Step 2: Run focused desktop tests**

Run: `node --test desktop/ambient-orb/test/preload.test.mjs desktop/ambient-orb/test/state.test.mjs desktop/ambient-orb/test/settings-panel.test.mjs desktop/ambient-orb/test/main-security.test.mjs`

- [ ] **Step 3: Integrate diagnostic collection and status IPC**

Capture at most the recognized runtime diagnostic code, discard unknown stderr for UI purposes, pass classified failures to the supervisor, publish status to both windows, and keep development console output bounded and secret-redacted.

- [ ] **Step 4: Add explicit retry UI and copy**

Map every public state/diagnostic code to fixed Chinese text in renderer-owned constants. Retry invokes the main supervisor without sending environment/configuration data.

- [ ] **Step 5: Run integration tests**

Run: `node --test desktop/ambient-orb/test/backend-diagnostics.test.mjs desktop/ambient-orb/test/backend-supervisor.test.mjs desktop/ambient-orb/test/preload.test.mjs desktop/ambient-orb/test/state.test.mjs desktop/ambient-orb/test/settings-panel.test.mjs desktop/ambient-orb/test/main-security.test.mjs`

- [ ] **Step 6: Commit diagnostics integration**

Commit message: `fix: surface actionable backend diagnostics`

### Task 4: Supervisor Regression Verification

**Files:**
- Verify only.

**Interfaces:**
- Confirms: no infinite retry for missing configuration/authentication and recoverable exits still reconnect.

- [ ] **Step 1: Run all backend and settings suites**

Run: `node --test desktop/ambient-orb/test/backend*.test.mjs desktop/ambient-orb/test/preload.test.mjs desktop/ambient-orb/test/state.test.mjs desktop/ambient-orb/test/settings-panel.test.mjs desktop/ambient-orb/test/main-security.test.mjs`

- [ ] **Step 2: Run desktop build and runtime typecheck**

Run: `npm run build --workspace @nova-audio-agent/ambient-orb && npm run typecheck --workspace @nova-audio-agent/runtime`

- [ ] **Step 3: Commit test-only corrections if required**

Commit message, only if needed: `test: cover backend failure states`
