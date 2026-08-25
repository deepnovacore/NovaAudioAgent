# Backend Supervision and Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the desktop alive and reconnect it through backend/provider failures and settings changes.

**Architecture:** A main-process generation supervisor owns spawn, readiness, exit classification, capped backoff, and controlled restart. Renderer sockets follow immutable generation snapshots and ignore stale callbacks.

**Tech Stack:** Electron main/preload/renderer, Node.js child processes and WebSocket, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-cross-platform-desktop-design.md`

## Global Constraints

- Only app quit permanently stops the supervisor.
- Diagnostics are bounded and credential-free.
- One generation owns one backend and endpoint.
- Settings changes drain then restart; stale generations cannot publish state.

---

### Task 1: Pure supervisor state machine

**Files:**
- Create: `desktop/ambient-orb/src/main/backend-supervisor.mjs`
- Test: `desktop/ambient-orb/test/backend-supervisor.test.mjs`

**Interfaces:**
- Produces `createBackendSupervisor({launch,shutdown,schedule,random,onState})`.
- Produces `start()`, `restart(reason)`, `stop()`, `snapshot()` and states from the approved spec.

- [ ] **Step 1: Write failing fake-clock tests** for start/connect, spawn error, early exit, classification, backoff, restart cancellation, stale exit suppression, and idempotent stop:

  ```js
  const supervisor = createBackendSupervisor({launch, shutdown, schedule, random: () => 0.5, onState})
  await supervisor.start()
  exits[0]({code: 1, diagnostic: 'provider_authentication'})
  assert.equal(supervisor.snapshot().state, 'authentication_failed')
  assert.equal(scheduled[0].delay, 1_000)
  ```
- [ ] **Step 2: Run** `node --test desktop/ambient-orb/test/backend-supervisor.test.mjs` and verify failure.
- [ ] **Step 3: Implement** the generation-owned state machine with this surface and exact snapshot shape:

  ```js
  export function createBackendSupervisor({launch, shutdown, schedule, random, onState}) {
    return {start, restart, stop, snapshot}
  }
  // snapshot(): {generation,state,endpoint,retryAt,diagnostic}
  ```
- [ ] **Step 4: Run the supervisor test** and verify pass.
- [ ] **Step 5: Commit** with `feat: supervise desktop backend generations`.

### Task 2: Main/preload integration

**Files:**
- Modify: `desktop/ambient-orb/src/main/main.mjs`
- Modify: `desktop/ambient-orb/src/preload/preload.cjs`
- Test: `desktop/ambient-orb/test/main-security.test.mjs`
- Test: `desktop/ambient-orb/test/preload.test.mjs`
- Test: `desktop/ambient-orb/test/fake-backend-smoke.test.mjs`

**Interfaces:**
- Consumes `createBackendSupervisor` and existing `launchBackend`/`shutdownBackend`.
- Produces sender-validated `nova:backend:state`, `nova:backend:retry`, and bootstrap `backendState`.

- [ ] **Step 1: Write failing tests** that the window survives backend exit, state replay cannot race bootstrap, retry is sender validated, settings changes restart, and quit awaits stop:

  ```js
  assert.match(source, /backendSupervisor\.restart\('settings_changed'\)/)
  assert.match(source, /backendState:\s*backendSupervisor\.snapshot\(\)/)
  assert.doesNotMatch(source, /app\.quit\(\).*backend.*exit/s)
  ```
- [ ] **Step 2: Run the three focused tests** and verify failure.
- [ ] **Step 3: Replace `backendExited`** with supervisor snapshots/events using one guarded publisher:

  ```js
  function publishBackendState(snapshot) {
    sendToOrb('nova:backend:state', publicBackendState(snapshot))
    settingsWindow?.webContents.send('nova:backend:state', publicBackendState(snapshot))
  }
  ```

  Keep the existing private readiness-token validation and graceful stdin shutdown.
- [ ] **Step 4: Run focused tests** and verify pass.
- [ ] **Step 5: Commit** with `feat: keep desktop alive through backend failures`.

### Task 3: Renderer reconnect and diagnostics

**Files:**
- Modify: `desktop/ambient-orb/src/renderer/index.mjs`
- Modify: `desktop/ambient-orb/src/renderer/state.mjs`
- Modify: `desktop/ambient-orb/src/renderer/index.css`
- Test: `desktop/ambient-orb/test/state.test.mjs`
- Test: `desktop/ambient-orb/test/renderer-caption.test.mjs`

**Interfaces:**
- Consumes renderer-safe backend snapshots from preload.
- Produces exactly one current WebSocket, closed before replacement.

- [ ] **Step 1: Write failing state/contract tests** for reconnecting, configuration-required, authentication-failed, retry labels, endpoint replacement, and stale close suppression:

  ```js
  assert.equal(deriveOrbState({...base, backendState: 'reconnecting'}).name, 'reconnecting')
  assert.equal(deriveOrbState({...base, backendState: 'authentication_failed'}).name,
    'authentication-failed')
  ```
- [ ] **Step 2: Run the focused tests** and verify failure.
- [ ] **Step 3: Route bootstrap and push snapshots** through one function with a generation guard:

  ```js
  function applyBackendState(next) {
    if (next.generation < backendGeneration) return
    backendGeneration = next.generation
    if (next.endpoint !== currentEndpoint) replaceSocket(next.endpoint)
    axes.backendState = next.state
    render()
  }
  ```
- [ ] **Step 4: Run desktop renderer tests** and verify pass.
- [ ] **Step 5: Commit** with `feat: reconnect orb to supervised backend`.
