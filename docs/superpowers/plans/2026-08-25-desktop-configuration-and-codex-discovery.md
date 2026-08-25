# Desktop Configuration and Codex Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make packaged and development desktop launches resolve defaults and a user-installed Codex CLI without requiring `.env`.

**Architecture:** Electron main owns settings-first configuration resolution and a pure platform-aware Codex candidate catalog. The existing runtime host policy remains the final authority; discovery only supplies a validated launch candidate.

**Tech Stack:** Node.js ESM, Electron, `node:test`, HTML/CSS settings renderer.

**Spec:** `docs/superpowers/specs/2026-08-25-cross-platform-desktop-design.md`

## Global Constraints

- Support `win32`, `darwin`, and `linux`.
- Default state is `~/.nova-audio-agent/state` and default workspace is `~/.nova-audio-agent/workspaces/default`.
- Settings override environment fallback, which overrides product defaults.
- Discover but never bundle Codex CLI.
- Never return secrets or login material to a renderer.

---

### Task 1: Settings v3 and product paths

**Files:**
- Create: `desktop/ambient-orb/src/main/platform-config.mjs`
- Modify: `desktop/ambient-orb/src/main/settings-store.mjs`
- Test: `desktop/ambient-orb/test/platform-config.test.mjs`
- Test: `desktop/ambient-orb/test/settings-store.test.mjs`

**Interfaces:**
- Produces: `productPaths({home, pathApi}) -> {root,stateRoot,managedRoot,defaultWorkspace}`.
- Produces: `resolveDesktopConfig({settings, environment, defaults, platform, realpath})`.

- [ ] **Step 1: Write failing tests** for home-derived Windows/POSIX paths, settings precedence, environment fallback, invalid/manual paths, and v2-to-v3 normalization. Include assertions shaped like:

  ```js
  assert.deepEqual(productPaths({home: 'C:\\Users\\nova', pathApi: win32}), {
    root: 'C:\\Users\\nova\\.nova-audio-agent',
    stateRoot: 'C:\\Users\\nova\\.nova-audio-agent\\state',
    managedRoot: 'C:\\Users\\nova\\.nova-audio-agent\\workspaces',
    defaultWorkspace: 'C:\\Users\\nova\\.nova-audio-agent\\workspaces\\default',
  })
  assert.equal(normalizeSettings({version: 2}).codexBinaryMode, 'auto')
  assert.equal(normalizeSettings({version: 2}).startListeningOnLaunch, false)
  ```
- [ ] **Step 2: Run** `node --test desktop/ambient-orb/test/platform-config.test.mjs desktop/ambient-orb/test/settings-store.test.mjs` and verify the new assertions fail.
- [ ] **Step 3: Implement** focused pure functions with these exports, then add the exact fields to `normalizeSettings`, `publicSettings`, and `applySettingsUpdate`:

  ```js
  export function productPaths({home, pathApi}) { /* return frozen exact shape above */ }
  export function resolveDesktopConfig({settings, environment, defaults, platform, realpath}) {
    /* return frozen settings > env > defaults values with canonical absolute paths */
  }
  export const SETTINGS_VERSION = 3
  ```
- [ ] **Step 4: Run the two tests** and verify all pass.
- [ ] **Step 5: Commit** `test and implementation` with `feat: add desktop product configuration`.

### Task 2: Cross-platform Codex discovery

**Files:**
- Create: `desktop/ambient-orb/src/main/codex-discovery.mjs`
- Test: `desktop/ambient-orb/test/codex-discovery.test.mjs`
- Modify: `scripts/start-client.mjs`
- Test: `desktop/ambient-orb/test/start-client.test.mjs`

**Interfaces:**
- Produces: `codexCandidates({platform, env, home, pathApi}) -> readonly Candidate[]`.
- Produces: `discoverCodex({candidates, inspect, canonicalize}) -> Promise<CodexDiscoveryView>`.
- `Candidate` is `{command:string,args:readonly string[],source:'path'|'npm-user'|'common'|'manual'}`; Windows may use `cmd.exe /d /s /c <canonical codex.cmd>` without claiming the shim is an EXE.

- [ ] **Step 1: Write failing tests** proving Windows finds `codex.cmd` under `%APPDATA%\npm`, macOS/Linux find executable `codex`, manual candidates win only in manual mode, hostile/noncanonical candidates fail closed, and version probes are bounded and credential-free:

  ```js
  const candidates = codexCandidates({
    platform: 'win32', env: {APPDATA: 'C:\\Users\\nova\\AppData\\Roaming', PATH: ''},
    home: 'C:\\Users\\nova', pathApi: win32,
  })
  assert.equal(candidates[0].command.toLowerCase(), 'cmd.exe')
  assert.match(candidates[0].args.at(-1), /codex\.cmd$/i)
  ```
- [ ] **Step 2: Run** `node --test desktop/ambient-orb/test/codex-discovery.test.mjs desktop/ambient-orb/test/start-client.test.mjs` and verify failure.
- [ ] **Step 3: Implement** the catalog and probe with these exact public signatures. Replace `start-client.mjs`'s `.env` requirement and `codex.exe` assumption with the same discovery contract; keep `shell:false`:

  ```js
  export function codexCandidates({platform, env, home, pathApi}) { /* Candidate[] */ }
  export async function discoverCodex({candidates, inspect, canonicalize}) {
    /* {status:'ready'|'missing'|'invalid', candidate:null|Candidate, version:null|string} */
  }
  ```
- [ ] **Step 4: Run the focused tests** and verify pass.
- [ ] **Step 5: Commit** with `feat: discover installed Codex across platforms`.

### Task 3: Wire settings into launch and panel

**Files:**
- Modify: `desktop/ambient-orb/src/main/backend.mjs`
- Modify: `desktop/ambient-orb/src/main/main.mjs`
- Modify: `desktop/ambient-orb/src/preload/preload.cjs`
- Modify: `desktop/ambient-orb/src/renderer/settings.html`
- Modify: `desktop/ambient-orb/src/renderer/settings.css`
- Modify: `desktop/ambient-orb/src/renderer/settings.mjs`
- Test: `desktop/ambient-orb/test/backend.test.mjs`
- Test: `desktop/ambient-orb/test/settings-panel.test.mjs`
- Test: `desktop/ambient-orb/test/main-security.test.mjs`

**Interfaces:**
- Consumes: `resolveDesktopConfig` and `discoverCodex`.
- Produces renderer-safe `codexStatus`, product paths, and provider status through existing sender-validated settings IPC.

- [ ] **Step 1: Write failing tests** for settings-over-env launch variables, omitted unsafe/unknown fields, Codex rescan IPC sender validation, and settings HTML controls. Pin the launch precedence explicitly:

  ```js
  const spec = backendLaunchSpec({settings: {codexProjectsEnabled: true}, environment: {
    NOVA_AUDIO_AGENT_CODEX_PROJECTS: 'false',
  }, resolvedConfig, decryptedSecrets: {}})
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_PROJECTS, 'true')
  assert.doesNotMatch(JSON.stringify(settingsView), /apiKey|secrets\s*:/i)
  ```
- [ ] **Step 2: Run** the three focused test files and verify failure.
- [ ] **Step 3: Implement** launch-spec injection and renderer-safe status/actions using the existing validated IPC pattern:

  ```js
  ipcMain.handle('nova:codex:rescan', async event => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) return null
    return publicCodexStatus(await rescanCodex())
  })
  ```

  Decrypt secrets only while constructing the child environment; never log the patch or resolved secrets.
- [ ] **Step 4: Run focused desktop tests** and `npm run check`.
- [ ] **Step 5: Commit** with `feat: configure packaged desktop from settings`.
