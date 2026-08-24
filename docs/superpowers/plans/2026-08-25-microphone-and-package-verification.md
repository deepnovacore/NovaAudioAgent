# Microphone and Package Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically request microphone permission without auto-recording, report real capture failures, and verify packaged behavior across supported operating systems.

**Architecture:** A pure error classifier and a renderer capture controller separate permission preflight from active listening. Main supplies platform permission status/actions; Settings exposes safe diagnostics and explicit retry/test controls.

**Tech Stack:** Electron `systemPreferences`, Chromium MediaDevices/Web Audio, Node.js tests, electron-builder, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-25-cross-platform-desktop-design.md`

## Global Constraints

- First-run preflight stops all tracks immediately.
- Persistent listening is click-activated unless explicitly enabled in Settings.
- Only true denied/restricted states use permission-denied copy.
- No exception text, device ID, host path, or secret reaches UI/logging.

---

### Task 1: Permission classifier and preflight controller

**Files:**
- Create: `desktop/ambient-orb/src/renderer/microphone.mjs`
- Test: `desktop/ambient-orb/test/microphone.test.mjs`
- Modify: `desktop/ambient-orb/src/renderer/audio.mjs`

**Interfaces:**
- Produces `classifyMicrophoneFailure(error, systemStatus)` returning the approved taxonomy.
- Produces `preflightMicrophone({mediaDevices})` returning `{status}` and stopping every acquired track.

- [ ] **Step 1: Write failing tests** for DOM exception mappings and immediate track release:

  ```js
  assert.equal(classifyMicrophoneFailure({name: 'NotAllowedError'}, 'denied'),
    'permission_denied')
  assert.equal(classifyMicrophoneFailure({name: 'NotFoundError'}, 'granted'), 'no_input_device')
  const result = await preflightMicrophone({mediaDevices: {getUserMedia: async () => stream}})
  assert.equal(result.status, 'granted')
  assert.equal(track.stop.mock.calls.length, 1)
  ```
- [ ] **Step 2: Run** `node --test desktop/ambient-orb/test/microphone.test.mjs desktop/ambient-orb/test/audio.test.mjs` and verify failure.
- [ ] **Step 3: Implement** these exports and the approved closed taxonomy:

  ```js
  export function classifyMicrophoneFailure(error, systemStatus = 'unknown') { /* code */ }
  export function createMicrophonePreflight({mediaDevices}) {
    return {run: () => Promise.resolve({status: 'granted' /* or classified code */})}
  }
  ```

  Do not retain or return device labels/IDs or raw errors.
- [ ] **Step 4: Run the focused tests** and verify pass.
- [ ] **Step 5: Commit** with `feat: classify and preflight microphone access`.

### Task 2: Platform permission IPC and active capture state

**Files:**
- Modify: `desktop/ambient-orb/src/main/security.mjs`
- Modify: `desktop/ambient-orb/src/main/main.mjs`
- Modify: `desktop/ambient-orb/src/preload/preload.cjs`
- Modify: `desktop/ambient-orb/src/renderer/index.mjs`
- Modify: `desktop/ambient-orb/src/renderer/state.mjs`
- Test: `desktop/ambient-orb/test/security.test.mjs`
- Test: `desktop/ambient-orb/test/main-security.test.mjs`
- Test: `desktop/ambient-orb/test/state.test.mjs`

**Interfaces:**
- Produces sender-validated `microphone.status()`, `microphone.request()`, and Windows-only `microphone.openSettings()` preload calls.
- Consumes `startListeningOnLaunch` and `preflightMicrophone`.

- [ ] **Step 1: Write failing tests** for platform ordering, exact Windows settings URI, preflight, opt-in listening, and distinct labels:

  ```js
  assert.equal(await requestMicrophonePermission({platform: 'darwin', systemPreferences}), 'granted')
  assert.deepEqual(events, ['status:microphone', 'ask:microphone', 'status:microphone'])
  assert.equal(deriveOrbState({...base, microphone: 'no_input_device'}).name,
    'microphone-unavailable')
  ```
- [ ] **Step 2: Run the focused tests** and verify failure.
- [ ] **Step 3: Implement** sender-validated platform IPC and classified renderer state:

  ```js
  ipcMain.handle('nova:microphone:status', event => {
    if (event.sender !== mainWindow?.webContents && event.sender !== settingsWindow?.webContents) {
      return 'unknown'
    }
    return microphoneStatus({platform: process.platform, systemPreferences})
  })
  ```

  Replace the blanket catch with `axes.microphone = classifyMicrophoneFailure(error, status)` and preserve active resource cleanup.
- [ ] **Step 4: Run focused tests** and verify pass.
- [ ] **Step 5: Commit** with `fix: request and diagnose microphone access`.

### Task 3: Settings controls and package matrix

**Files:**
- Modify: `desktop/ambient-orb/src/renderer/settings.html`
- Modify: `desktop/ambient-orb/src/renderer/settings.css`
- Modify: `desktop/ambient-orb/src/renderer/settings.mjs`
- Modify: `desktop/ambient-orb/electron-builder.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/unsigned-packages.yml`
- Test: `desktop/ambient-orb/test/settings-panel.test.mjs`
- Test: `desktop/ambient-orb/test/builder-config.test.mjs`
- Test: `desktop/ambient-orb/test/package-inspection.test.mjs`

**Interfaces:**
- Consumes safe microphone and backend/Codex settings views.
- Produces test/retry/open-settings actions and the opt-in launch-listening toggle.

- [ ] **Step 1: Write failing contract tests** for controls, metadata, package targets, and CI matrix:

  ```js
  assert.match(html, /id="microphone-status"/)
  assert.match(html, /id="test-microphone"/)
  assert.match(html, /id="open-microphone-settings"/)
  assert.deepEqual(ci.strategy.matrix.os.sort(), ['macos-latest', 'ubuntu-latest', 'windows-latest'])
  ```
- [ ] **Step 2: Run the three focused test files** and verify failure.
- [ ] **Step 3: Implement** the controls with existing controller writes and exact preload actions:

  ```js
  startListening.addEventListener('change', () => void push({
    startListeningOnLaunch: startListening.checked,
  }, '麦克风启动偏好已保存'))
  testMicrophone.addEventListener('click', () => void api.microphone.test())
  ```

  Do not broaden shell/external URL access beyond the exact Windows settings URI.
- [ ] **Step 4: Run** `npm run check`, desktop tests, targeted runtime tests, native builds, and `npm run package:win` on Windows. Inspect the produced package and run the installed-candidate/packaged smoke scripts where supported.
- [ ] **Step 5: Commit** with `test: verify cross-platform desktop packages`.
