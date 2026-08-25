# Microphone State And Permission Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically request microphone access from the correct renderer lifecycle point and preserve distinct permission, device, and audio-pipeline failure states.

**Architecture:** The main process exposes a bounded platform-permission query/request API after the orb renderer is ready; Chromium `getUserMedia` remains the actual capture preflight. A pure classifier maps DOM capture failures into a closed taxonomy, and microphone state is independent from backend connection and listening activation.

**Tech Stack:** Electron `systemPreferences`, Chromium MediaDevices/Permissions APIs, renderer JavaScript, preload IPC, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-cross-platform-desktop-design.md`

## Global Constraints

- Permission request starts only after the orb renderer is ready and only from an explicit main/preload contract.
- Preflight requests audio once per unresolved decision, immediately stops all tracks, and never enables persistent listening unless the user opted in.
- Taxonomy is `granted`, `permission_denied`, `restricted`, `no_input_device`, `device_busy`, `capture_unavailable`, and `audio_pipeline_error`.
- Closing/deactivating listening never resets a definitive OS permission result to unknown.
- Settings and orb copy must never tell users to change OS permissions for device absence, device busy, or pipeline failures.

---

### Task 1: Pure Microphone Failure Taxonomy

**Files:**
- Modify: `desktop/ambient-orb/src/renderer/microphone-permission.mjs`
- Modify: `desktop/ambient-orb/test/microphone-permission.test.mjs`

**Interfaces:**
- Produces: `classifyMicrophoneFailure(error, systemStatus): MicrophoneStatus`.
- Changes: `preflightMicrophone({mediaDevices, systemStatus})` returns `{status:MicrophoneStatus}` and stops every acquired track.

- [ ] **Step 1: Add failing table-driven classifier tests**

Map `NotAllowedError` plus denied/restricted status, `NotFoundError`, `DevicesNotFoundError`, `NotReadableError`, `TrackStartError`, `AbortError`, missing MediaDevices, and an unknown exception to the exact taxonomy. Assert error objects/messages are not returned.

- [ ] **Step 2: Run focused tests and confirm the current single `denied` result fails**

Run: `node --test desktop/ambient-orb/test/microphone-permission.test.mjs`

- [ ] **Step 3: Implement pure classification and preflight mapping**

Read only `error.name`; treat system `restricted` separately from `denied`; keep `audio_pipeline_error` reserved for post-capture initialization failures.

- [ ] **Step 4: Run focused tests**

Run: `node --test desktop/ambient-orb/test/microphone-permission.test.mjs`

- [ ] **Step 5: Commit classifier**

Commit message: `fix: preserve microphone failure categories`

### Task 2: Renderer-Ready Platform Permission Handshake

**Files:**
- Modify: `desktop/ambient-orb/src/main/security.mjs`
- Modify: `desktop/ambient-orb/src/main/main.mjs`
- Modify: `desktop/ambient-orb/src/preload/preload.cjs`
- Modify: `desktop/ambient-orb/test/security.test.mjs`
- Modify: `desktop/ambient-orb/test/preload.test.mjs`
- Modify: `desktop/ambient-orb/test/main-security.test.mjs`

**Interfaces:**
- Produces: main `resolveMicrophonePermission({platform, systemPreferences, request}): Promise<'granted'|'denied'|'restricted'|'not-determined'|'unknown'>`.
- Produces: preload `requestMicrophonePermission(): Promise<{status:string}>` over `nova:microphone:permission`.

- [ ] **Step 1: Add failing lifecycle and sender-validation tests**

Assert macOS `askForMediaAccess('microphone')` is not called during app/window construction, is called once after orb renderer invocation when status is `not-determined`, is not repeated after a definitive response, and the settings window cannot impersonate the orb request. Assert Windows/Linux return bounded status without main-process capture.

- [ ] **Step 2: Run focused security tests**

Run: `node --test desktop/ambient-orb/test/security.test.mjs desktop/ambient-orb/test/preload.test.mjs desktop/ambient-orb/test/main-security.test.mjs`

- [ ] **Step 3: Move macOS prompting behind the orb IPC handshake**

Remove eager permission asking from window setup. Register one main handler with exact sender validation, cache only the current-process definitive answer, query `getMediaAccessStatus` before asking, and return a frozen status object.

- [ ] **Step 4: Run focused security tests**

Run: `node --test desktop/ambient-orb/test/security.test.mjs desktop/ambient-orb/test/preload.test.mjs desktop/ambient-orb/test/main-security.test.mjs`

- [ ] **Step 5: Commit permission lifecycle**

Commit message: `fix: request microphone permission after renderer ready`

### Task 3: Independent Microphone State In Orb And Settings

**Files:**
- Modify: `desktop/ambient-orb/src/renderer/index.mjs`
- Modify: `desktop/ambient-orb/src/renderer/state.mjs`
- Modify: `desktop/ambient-orb/src/renderer/settings-controller.mjs`
- Modify: `desktop/ambient-orb/src/renderer/settings.mjs`
- Modify: `desktop/ambient-orb/src/renderer/settings.html`
- Modify: `desktop/ambient-orb/test/state.test.mjs`
- Modify: `desktop/ambient-orb/test/settings-panel.test.mjs`
- Modify: `desktop/ambient-orb/test/orb-visual.test.mjs`

**Interfaces:**
- Produces: `axes.microphone: MicrophoneStatus` independent of `axes.connection` and `axes.activity`.
- Produces: fixed Chinese copy and recovery action for each microphone status.
- Preserves: `startListeningOnLaunch` as the sole startup opt-in for persistent capture.

- [ ] **Step 1: Add failing state and rendering tests**

Assert each status maps to distinct copy/action; backend disconnection does not overwrite microphone status; stopping listening retains the permission result; and an audio graph construction failure becomes `audio_pipeline_error` without being called a denial.

- [ ] **Step 2: Run focused renderer tests**

Run: `node --test desktop/ambient-orb/test/state.test.mjs desktop/ambient-orb/test/settings-panel.test.mjs desktop/ambient-orb/test/orb-visual.test.mjs`

- [ ] **Step 3: Integrate platform handshake, capture preflight, and axis updates**

After renderer bootstrap, request the bounded platform status, call `preflightMicrophone` only if capture remains meaningful, store the returned taxonomy in `axes.microphone`, stop the test stream, and activate persistent input only when the opt-in setting is true.

- [ ] **Step 4: Add correct recovery copy and retry control**

Permission denial/restriction links to platform settings guidance; no device asks the user to connect/select a mic; busy asks them to close the conflicting app; capture unavailable reports platform support; pipeline failure offers an in-app retry.

- [ ] **Step 5: Run renderer suites**

Run: `node --test desktop/ambient-orb/test/microphone-permission.test.mjs desktop/ambient-orb/test/state.test.mjs desktop/ambient-orb/test/settings-panel.test.mjs desktop/ambient-orb/test/orb-visual.test.mjs`

- [ ] **Step 6: Commit state integration**

Commit message: `fix: expose actionable microphone state`

### Task 4: Microphone Regression Verification

**Files:**
- Verify only.

**Interfaces:**
- Confirms: one-shot permission preflight, no retained stream without opt-in, and distinct recovery states.

- [ ] **Step 1: Run microphone, security, preload, state, and renderer tests**

Run: `node --test desktop/ambient-orb/test/microphone-permission.test.mjs desktop/ambient-orb/test/security.test.mjs desktop/ambient-orb/test/preload.test.mjs desktop/ambient-orb/test/main-security.test.mjs desktop/ambient-orb/test/state.test.mjs desktop/ambient-orb/test/settings-panel.test.mjs desktop/ambient-orb/test/orb-visual.test.mjs`

- [ ] **Step 2: Run the desktop build**

Run: `npm run build --workspace @nova-audio-agent/ambient-orb`

- [ ] **Step 3: Commit test-only corrections if required**

Commit message, only if needed: `test: cover microphone permission lifecycle`

### Task 5: Release-Candidate Verification Across All Remediations

**Files:**
- Verify only.

**Interfaces:**
- Confirms: runtime/desktop suites, Windows packaging, native resource inspection, and installed Codex smoke behavior.

- [ ] **Step 1: Run repository checks and complete test suites**

Run: `npm run check && npm test`

- [ ] **Step 2: Build the Windows NSIS candidate and inspect packaged resources**

Run: `npm run package:win && npm run inspect:package --workspace @nova-audio-agent/ambient-orb`

- [ ] **Step 3: Run packaged Codex and installed-candidate smoke tests**

Run: `npm run smoke:packaged-codex --workspace @nova-audio-agent/ambient-orb && npm run smoke:installed-candidate --workspace @nova-audio-agent/ambient-orb`

- [ ] **Step 4: Record installer SHA-256 and commit final verification-only changes if any**

Run: `Get-FileHash 'desktop/ambient-orb/dist/Nova Audio Agent Ambient Orb Setup 0.1.0.exe' -Algorithm SHA256`

Commit message, only if needed: `test: complete cross-platform desktop remediation`
