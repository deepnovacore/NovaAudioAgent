# Windows and Ubuntu Packaging Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the default source client startup and produce natively built, inspected, install-smoked unsigned Windows NSIS, Ubuntu AppImage, and Ubuntu deb artifacts in GitHub Actions.

**Architecture:** Keep credential compatibility inside the host-owned configuration resolver and bind the fallback to the exact DashScope-compatible endpoint. Remove three host-specific test assumptions, then add a dedicated unsigned-package workflow that reuses the repository's release artifact collector, attestation, checkout-free smoke kit, and installed-candidate verifier.

**Tech Stack:** Node.js 22, TypeScript 5.9, Electron 43, electron-builder 26, Node test runner, GitHub Actions, NSIS, AppImage, deb, GitHub artifact attestations.

**Spec:** `docs/superpowers/specs/2026-08-23-windows-ubuntu-packaging-design.md`

## Global Constraints

- Explicit `DASHSCOPE_API_KEY` always wins.
- Generic model credentials may reach integrated Qwen only when the normalized generic base URL is exactly `https://dashscope.aliyuncs.com/compatible-mode/v1`.
- Cascaded provider credential rules do not change.
- Windows and Ubuntu packages must be built on their native GitHub-hosted runners.
- The deliverables are unsigned development candidates; do not claim Authenticode, provider-live, camera, or hardware success.
- Installed smoke must authenticate, exercise, quit, prove the owned tree gone, and remove residue.
- Mainline user documentation must not add Python instructions.
- Preserve and never stage the user's existing untracked files.

---

### Task 1: Restore endpoint-bound integrated Qwen credential compatibility

**Files:**
- Modify: `runtime/test/config.test.ts`
- Modify: `runtime/src/config.ts`

**Interfaces:**
- Consumes: `Settings`, `DASHSCOPE_COMPATIBLE_BASE_URL`, `stripLikePython`.
- Produces: unchanged `requireIntegratedRealtime(settings: Settings): QwenRealtimeConfig` with endpoint-bound fallback semantics.

- [ ] **Step 1: Write the failing configuration tests**

Add literal cases proving:

```ts
const compatible = loadSettings({
  NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
  NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER: 'qwen',
  NOVA_AUDIO_AGENT_MODEL_BASE_URL: DASHSCOPE_COMPATIBLE_BASE_URL,
  NOVA_AUDIO_AGENT_MODEL_API_KEY: 'generic-dashscope-key',
})
assert.equal(requireIntegratedRealtime(compatible).apiKey, 'generic-dashscope-key')

const explicit = loadSettings({
  NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
  NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER: 'qwen',
  NOVA_AUDIO_AGENT_MODEL_BASE_URL: DASHSCOPE_COMPATIBLE_BASE_URL,
  NOVA_AUDIO_AGENT_MODEL_API_KEY: 'generic-dashscope-key',
  DASHSCOPE_API_KEY: 'explicit-dashscope-key',
})
assert.equal(requireIntegratedRealtime(explicit).apiKey, 'explicit-dashscope-key')

const foreign = loadSettings({
  NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
  NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER: 'qwen',
  NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'https://example.invalid/v1',
  NOVA_AUDIO_AGENT_MODEL_API_KEY: 'foreign-key',
})
assert.throws(() => requireIntegratedRealtime(foreign), /DASHSCOPE_API_KEY/u)
```

The production mutation this test catches is replacing the exact endpoint check with an unconditional generic-key fallback.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test --test-name-pattern='integrated Qwen credential' runtime/dist/test/config.test.js
```

Expected: the compatible generic-key case fails with `缺少 DASHSCOPE_API_KEY`.

- [ ] **Step 3: Implement the minimal resolver change**

In `requireIntegratedRealtime`, normalize both credentials. Select:

```ts
const explicitKey = stripLikePython(settings.dashscope_api_key ?? '')
const compatibleGenericKey = settings.model_base_url === DASHSCOPE_COMPATIBLE_BASE_URL
  ? stripLikePython(settings.model_api_key ?? '')
  : ''
const apiKey = explicitKey || compatibleGenericKey
if (apiKey === '') throw new ConfigurationError('缺少 DASHSCOPE_API_KEY')
```

Keep URL/model/voice validation and immutable return shape unchanged.

- [ ] **Step 4: Run focused config and assembly tests and verify GREEN**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/config.test.js runtime/dist/test/integrated-realtime-assembly.test.js runtime/dist/test/production-realtime-assembly.test.js
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add runtime/src/config.ts runtime/test/config.test.ts
git commit -m "fix(runtime): restore integrated DashScope credential compatibility"
```

---

### Task 2: Make the parity audit source inventory platform-independent

**Files:**
- Create: `runtime/scripts/node-parity-paths.mjs`
- Modify: `runtime/scripts/node-parity-audit.mjs`
- Modify: `runtime/test/node-parity-audit.test.ts`

**Interfaces:**
- Produces: `canonicalAuditPath(value: string): string` and `isAuditedSource(value: string): boolean`.
- Consumes: raw repository-relative strings returned by `node:path.relative`.

- [ ] **Step 1: Write the failing path behavior test**

Import the pure helper and assert literal Windows and POSIX spellings:

```ts
assert.equal(canonicalAuditPath('runtime\\src\\config.ts'), 'runtime/src/config.ts')
assert.equal(isAuditedSource('runtime\\src\\unicode-tables.ts'), false)
assert.equal(isAuditedSource('runtime/src/unicode-tables.ts'), false)
assert.equal(isAuditedSource('runtime\\src\\config.ts'), true)
```

The production mutation this catches is filtering before slash normalization.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test --test-name-pattern='platform-independent source inventory' runtime/dist/test/node-parity-audit.test.js
```

Expected: import/helper absence fails the test.

- [ ] **Step 3: Implement and wire the pure helper**

Create:

```js
export function canonicalAuditPath(value) {
  if (typeof value !== 'string') throw new TypeError('audit path must be a string')
  return value.replaceAll('\\', '/')
}

export function isAuditedSource(value) {
  return canonicalAuditPath(value) !== 'runtime/src/unicode-tables.ts'
}
```

In `node-parity-audit.mjs`, canonicalize immediately after `relative(...)`, then filter and sort canonical values through this helper. Absolute paths remain the TypeScript program inputs; the canonical strings remain manifest identities.

- [ ] **Step 4: Run the behavior test and the real audit**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/node-parity-audit.test.js
npm run check:node-parity
```

Expected: tests and the 163+ occurrence manifest check pass without regenerating reviewed dispositions.

- [ ] **Step 5: Commit Task 2**

```bash
git add runtime/scripts/node-parity-paths.mjs runtime/scripts/node-parity-audit.mjs runtime/test/node-parity-audit.test.ts
git commit -m "fix(ci): normalize parity inventory paths"
```

---

### Task 3: Remove Ubuntu filesystem and ICU assumptions from tests

**Files:**
- Modify: `runtime/test/codex-project-store.test.ts`
- Modify: `runtime/test/unicode-nfkc.test.ts`

**Interfaces:**
- Consumes: existing `ProjectRootFileAuthority` test seam and pinned Unicode tables.
- Produces: platform-neutral behavioral tests only; no production API change.

- [ ] **Step 1: Preserve the observed RED evidence**

Record the existing GitHub Actions failures in the task notes:

```text
Ubuntu: pre-commit rollback expected dev:ino inequality but allocator reused the inode.
Ubuntu: Unicode host decomposition count was 37 while the macOS host count was 36.
```

These native-runner failures are the RED evidence for test portability.

- [ ] **Step 2: Replace inode-number inequality with authority behavior**

In `a pre-commit rollback failure restores a safe managed child and advances its pin`, remove the `dev:ino` inequality assertion. Retain literal assertions that:

```ts
assert.equal(after.mode & 0o7777n, 0o700n)
assert.equal(hostWorkspacePath(await store.revalidateWorkspace(id)), managed.canonical_path)
rootFiles.failTempCreate = false
assert.equal(await store.rollbackManagedCreate(id), true)
```

Also assert the original moved child is not accepted as the current workspace through the existing root authority seam. Do not weaken production identity checks.

- [ ] **Step 3: Replace exact host ICU counts with mechanism assertions**

Keep the complete equality:

```ts
assert.deepEqual([...NFKC_HOLDBACK_CODE_POINTS], shouldHold)
```

Replace exact incidental counts with:

```ts
assert.ok(decomposing.length > 0)
assert.ok(shouldHold.length - decomposing.length > 0)
assert.ok(decomposing.includes(0x1ccf0))
assert.ok(shouldHold.includes(0x10d50))
```

Use the actual fixed code points already documented by the surrounding tests; adjust the decomposition literal only if the committed vector identifies a different exact representative.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test --test-name-pattern='pre-commit rollback failure restores|holdback set is every' runtime/dist/test/codex-project-store.test.js runtime/dist/test/unicode-nfkc.test.js
```

Expected: both tests pass on the local host while preserving the full pinned equality assertion.

- [ ] **Step 5: Commit Task 3**

```bash
git add runtime/test/codex-project-store.test.ts runtime/test/unicode-nfkc.test.ts
git commit -m "test(runtime): remove host-specific filesystem assumptions"
```

---

### Task 4: Add an attested unsigned cross-platform package workflow

**Files:**
- Create: `.github/workflows/unsigned-packages.yml`
- Create: `desktop/ambient-orb/scripts/run-unsigned-installed-smoke.mjs`
- Modify: `desktop/ambient-orb/scripts/installed-candidate-smoke.mjs`
- Modify: `desktop/ambient-orb/test/installed-candidate-smoke.test.mjs`
- Modify: `desktop/ambient-orb/test/builder-config.test.mjs`

**Interfaces:**
- Extends CLI: `installed-candidate-smoke.mjs --signer-workflow <allowlisted-path>`.
- Reuses: `collect:release-artifacts`, `prepare:release-smoke-kit`, GitHub build-provenance attestations, stable artifact filenames.

- [ ] **Step 1: Write failing smoke-workflow allowlist tests**

Add behavior tests proving:

```js
assert.equal(
  canonicalSignerWorkflow('deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml'),
  'deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml',
)
assert.throws(() => canonicalSignerWorkflow('owner/repo/.github/workflows/arbitrary.yml'))
```

Update CLI option tests so omission uses the release-candidate authority and explicit unsigned workflow is accepted. The verifier must still reject any third workflow.

Add a wrapper classification test with literal child results:

```js
assert.deepEqual(classifyUnsignedSmoke({status: 0, signal: null,
  stdout: 'installed candidate smoke passed\n', stderr: ''}),
{installed: 'passed', camera: 'passed'})
assert.deepEqual(classifyUnsignedSmoke({status: 75, signal: null,
  stdout: 'camera-file-integration: chromium_codec_unavailable\n', stderr: ''}),
{installed: 'passed', camera: 'pending'})
assert.throws(() => classifyUnsignedSmoke({status: 1, signal: null,
  stdout: '', stderr: 'private'}))
```

The wrapper must never turn an arbitrary exit 75 or unexpected output into success.

- [ ] **Step 2: Run the focused smoke tests and verify RED**

Run:

```bash
node --test desktop/ambient-orb/test/installed-candidate-smoke.test.mjs
```

Expected: helper/CLI option is absent.

- [ ] **Step 3: Implement the exact signer-workflow allowlist**

Allow only:

```js
const SIGNER_WORKFLOWS = new Set([
  'deepnovacore/NovaAudioAgent/.github/workflows/release-candidate.yml',
  'deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml',
])
```

Pass the canonical value to `gh attestation verify --signer-workflow`. Keep repository, source digest, artifact digest, and all other validation unchanged.

- [ ] **Step 4: Write the workflow contract test first**

Extend `builder-config.test.mjs` to parse `.github/workflows/unsigned-packages.yml` and assert:

- triggers are `workflow_dispatch` and pushes to `main`;
- permissions include `id-token: write` and `attestations: write` only where needed;
- native package matrix contains exactly `win32-x64` and `linux-x64-gnu`;
- commands run check, runtime tests, desktop tests, build, package, inspect, collect, smoke-kit preparation, attestation, and upload without `continue-on-error`;
- installed smoke matrix contains exactly NSIS, AppImage, and deb;
- smoke jobs use `actions/download-artifact`, `GH_TOKEN`, exact commit SHA, exact digest sidecar, camera fixture, and the unsigned workflow authority; and
- uploaded paths are only normalized release artifacts, digests, and the smoke kit.

The production mutation this catches is uploading raw `dist/**` without inspection or installed smoke.

- [ ] **Step 5: Run the workflow contract test and verify RED**

Run:

```bash
node --test --test-name-pattern='unsigned cross-platform workflow' desktop/ambient-orb/test/builder-config.test.mjs
```

Expected: workflow file missing.

- [ ] **Step 6: Implement `.github/workflows/unsigned-packages.yml`**

Use a native build matrix:

```yaml
on:
  workflow_dispatch:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write
  attestations: write

jobs:
  package:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            target_id: win32-x64
            package_script: package:win
            artifact_name: unsigned-win32-x64
          - os: ubuntu-latest
            target_id: linux-x64-gnu
            package_script: package:linux
            artifact_name: unsigned-linux-x64-gnu
```

Each matrix entry installs Node 22/npm 11.6, runs all gates, packages, inspects, collects normalized artifacts, prepares the smoke kit, attests `build/release-artifacts/*`, and uploads only the closed bundle.

Add a dependent three-entry installed-smoke matrix. Download the matching bundle and run its checkout-free script with `--signer-workflow deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml`. Use `xvfb-run -a node` for Linux. Treat camera exit 75 as the existing explicit pending result at the workflow step level, not as package success; the main installed launch must still pass.

Implement `run-unsigned-installed-smoke.mjs` as the portable workflow entry. It invokes the checkout-free installed smoke with `process.execPath`, captures bounded output, and accepts only the two literal outcomes above. Exit 75 is therefore evidence that the installed launch/auth/control/quit/tree/residue sequence passed while camera codec evidence remains pending; every other nonzero result fails the job.

- [ ] **Step 7: Run workflow and desktop contract tests**

Run:

```bash
node --test desktop/ambient-orb/test/installed-candidate-smoke.test.mjs desktop/ambient-orb/test/builder-config.test.mjs
npm run test:desktop
```

Expected: all desktop tests pass.

- [ ] **Step 8: Commit Task 4**

```bash
git add .github/workflows/unsigned-packages.yml desktop/ambient-orb/scripts/installed-candidate-smoke.mjs desktop/ambient-orb/scripts/run-unsigned-installed-smoke.mjs desktop/ambient-orb/test/installed-candidate-smoke.test.mjs desktop/ambient-orb/test/builder-config.test.mjs
git commit -m "feat(release): build unsigned Windows and Ubuntu candidates"
```

---

### Task 5: Document source startup and unsigned artifact use

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`

**Interfaces:**
- Consumes: stable artifact filenames and workflow name from Task 4.
- Produces: user instructions only; no backend selector or Python instructions.

- [ ] **Step 1: Update the documentation**

Document:

- `npm run start:client` and endpoint-bound DashScope credential compatibility;
- Actions workflow `Unsigned Windows and Ubuntu packages`;
- `nova-win32-x64.exe`, `nova-linux-x64.AppImage`, and `nova-linux-x64.deb`;
- Windows SmartScreen's unsigned warning without recommending global protection disablement;
- `chmod u+x nova-linux-x64.AppImage` then direct execution;
- deb installation through the system package manager; and
- unsigned-development-candidate status.

- [ ] **Step 2: Run documentation contracts**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/documentation-contract.test.js
npm run check:env-contract
```

Expected: user docs remain synchronized with the public environment contract and contain no mainline Python startup instructions.

- [ ] **Step 3: Commit Task 5**

```bash
git add README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md
git commit -m "docs: explain unsigned Windows and Ubuntu packages"
```

---

### Task 6: Verify locally, launch the real client, and request fresh review

**Files:**
- No planned product changes; fix only failures caused by Tasks 1–5 through a new RED/GREEN cycle.

**Interfaces:**
- Consumes: complete working tree.
- Produces: local gate evidence and a reviewable commit range.

- [ ] **Step 1: Run static and build gates**

```bash
npm run check
npm run build
git diff --check
```

- [ ] **Step 2: Run full test suites**

```bash
npm run test:runtime
npm run test:desktop
```

Use loopback permission where the real socket suites require it. Require zero failures.

- [ ] **Step 3: Run the actual development client**

Run `npm run start:client` outside the sandbox. Observe authenticated readiness or the orb's connected state, then request graceful quit and confirm the backend process exits. Do not print `.env` values.

- [ ] **Step 4: Request a fresh P0/P1 review**

Ask a read-only reviewer to inspect the full implementation range against the spec, with emphasis on credential domain binding, workflow authority, artifact closure, and installed process cleanup. Resolve every P0/P1 with its own RED/GREEN cycle.

---

### Task 7: Push, run native CI, and verify downloadable artifacts

**Files:**
- No local source changes unless native CI reveals a reproducible repository defect.

**Interfaces:**
- Consumes: reviewed implementation commits.
- Produces: successful GitHub Actions run and downloadable artifacts.

- [ ] **Step 1: Merge the implementation branch into `main` without rewriting history**

Fetch `origin`, verify `origin/main` has no remote-only commits, and fast-forward or merge the reviewed branch. Preserve all user untracked files.

- [ ] **Step 2: Push `main`**

```bash
git push origin main
```

- [ ] **Step 3: Monitor the unsigned package workflow**

Use `gh run list` to identify the run for the pushed commit, then `gh run watch --exit-status`. Do not claim completion while any package or installed-smoke job is skipped, pending, or failed.

- [ ] **Step 4: Diagnose native failures scientifically**

For any native failure, download only the failed job log, identify the first product assertion or tool boundary, write a local injectable behavior test, and make the smallest fix. Repeat local gates, review, commit, push, and monitor.

- [ ] **Step 5: Download and verify the final bundles**

Download `unsigned-win32-x64` and `unsigned-linux-x64-gnu` to a private temporary directory. Verify the bundle contains exactly:

```text
nova-win32-x64.exe
nova-win32-x64.exe.sha256
nova-linux-x64.AppImage
nova-linux-x64.AppImage.sha256
nova-linux-x64.deb
nova-linux-x64.deb.sha256
release-smoke-kit/**
```

Rehash the three installer files and compare them with their sidecars. Report the Actions run URL, artifact names, and hashes.
