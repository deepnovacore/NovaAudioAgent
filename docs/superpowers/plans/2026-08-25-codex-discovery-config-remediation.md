# Codex Discovery And Configuration Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover and launch user-installed Codex reliably on Windows, macOS, and Ubuntu while preserving direct-argv security and making saved Settings authoritative.

**Architecture:** Replace the binary-path-only model with a validated invocation tuple. Native executables remain first choice; on Windows, an official npm launcher may be converted into `node.exe` plus the canonical official `bin/codex.js`, but the application never executes `.cmd`, `.bat`, `.ps1`, or a command shell.

**Tech Stack:** Electron main process, Node.js `child_process`, TypeScript runtime host, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-cross-platform-desktop-design.md`

## Global Constraints

- `command` is an absolute canonical native executable path; `prefixArgs` is a frozen validated array.
- Candidate order is native executable first, validated official npm launcher fallback second.
- A fallback is accepted only when package metadata names `@openai/codex`, the canonical JS entry is inside that package root, and the canonical Node executable is native.
- No Codex launch or probe invokes `cmd.exe`, `powershell.exe`, `sh`, or `{shell:true}`.
- Saved auto mode ignores stale manual paths and `NOVA_AUDIO_AGENT_CODEX_BIN`; saved manual mode requires a usable path and never silently becomes auto.
- Model base URLs from both Settings and environment pass the same URL validator.

---

### Task 1: Invocation Tuple And Windows npm Fallback

**Files:**
- Modify: `desktop/ambient-orb/src/main/codex-discovery.mjs`
- Modify: `desktop/ambient-orb/src/main/desktop-startup.mjs`
- Modify: `desktop/ambient-orb/test/codex-discovery.test.mjs`
- Modify: `desktop/ambient-orb/test/desktop-startup.test.mjs`
- Modify: `desktop/ambient-orb/test/packaged-codex-smoke.test.mjs`

**Interfaces:**
- Produces: `CodexInvocation = {command:string, prefixArgs:readonly string[], source:'path'|'npm-user'|'common'|'manual'|'npm-launcher'}`.
- Produces: discovery status `{status:'ready', invocation, displayPath, source, version}` or bounded `missing`.
- Changes: `inspectCodexVersion(invocation, deps)` executes `[...prefixArgs, '--version']`.

- [ ] **Step 1: Replace the test that locks in `codex.cmd` rejection with fallback tests**

Cover native PE preference, official npm `codex.cmd` layout conversion to `{command:node.exe,prefixArgs:[canonicalCodexJs]}`, rejection of an unrelated shim, package-name mismatch, entry escaping the package root, non-native Node, and absence of any shell option.

- [ ] **Step 2: Run discovery/startup tests and confirm tuple expectations fail**

Run: `node --test desktop/ambient-orb/test/codex-discovery.test.mjs desktop/ambient-orb/test/desktop-startup.test.mjs desktop/ambient-orb/test/packaged-codex-smoke.test.mjs`

- [ ] **Step 3: Implement candidates, canonicalization, and bounded version probing**

Deduplicate candidates by `command + NUL + prefixArgs`. Validate native Windows commands as PE executables; validate the fallback against the canonical npm package root and package metadata; freeze every returned object and array; probe with a 5-second timeout and 1 KiB output cap.

- [ ] **Step 4: Run focused tests**

Run: `node --test desktop/ambient-orb/test/codex-discovery.test.mjs desktop/ambient-orb/test/desktop-startup.test.mjs desktop/ambient-orb/test/packaged-codex-smoke.test.mjs`

- [ ] **Step 5: Commit discovery changes**

Commit message: `fix: support validated npm Codex launchers on Windows`

### Task 2: Carry Prefix Arguments Into The Runtime Host

**Files:**
- Modify: `desktop/ambient-orb/src/main/backend.mjs`
- Modify: `desktop/ambient-orb/test/backend.test.mjs`
- Modify: `runtime/src/environment-contract.ts`
- Modify: `runtime/src/config.ts`
- Modify: `runtime/src/codex-host-config.ts`
- Modify: `runtime/src/codex-process-owner.ts`
- Modify: `runtime/test/config.test.ts`
- Modify: `runtime/test/codex-host-config.test.ts`
- Modify: `runtime/test/codex-process-owner.test.ts`

**Interfaces:**
- Produces: environment key `NOVA_AUDIO_AGENT_CODEX_PREFIX_ARGS` containing a strict JSON string array generated only by the trusted desktop host.
- Produces: `ResolvedCodexHostConfig.binaryPrefixArgs: readonly string[]`.
- Changes: Codex app-server spawn argv becomes `[...binaryPrefixArgs, 'app-server', ...existingArgs]` with `shell:false`.

- [ ] **Step 1: Add failing environment and process-owner tests**

Accept only a JSON array of absolute canonical script paths with bounded item/count lengths; reject shell metacharacter handling as irrelevant because no string concatenation occurs; assert native discovery emits `[]` and npm fallback emits exactly one JS path before `app-server`.

- [ ] **Step 2: Run focused runtime tests**

Run: `npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/config.test.js runtime/dist/test/codex-host-config.test.js runtime/dist/test/codex-process-owner.test.js`

- [ ] **Step 3: Implement strict transport and direct argv composition**

Parse once in runtime configuration, freeze the array, verify each prefix argument belongs to a host-approved canonical script catalog, and pass it as an argv array to the existing process factory. Never log or interpolate the array into a command string.

- [ ] **Step 4: Update the environment contract artifact and run its check**

Run: `npm run check:env-contract`

- [ ] **Step 5: Run desktop/backend and runtime tests**

Run: `node --test desktop/ambient-orb/test/backend.test.mjs && npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/config.test.js runtime/dist/test/codex-host-config.test.js runtime/dist/test/codex-process-owner.test.js`

- [ ] **Step 6: Commit invocation transport**

Commit message: `fix: preserve direct argv for Codex npm installs`

### Task 3: Settings Precedence And URL Validation

**Files:**
- Modify: `desktop/ambient-orb/src/main/platform-config.mjs`
- Modify: `desktop/ambient-orb/src/main/settings-store.mjs`
- Modify: `desktop/ambient-orb/test/platform-config.test.mjs`
- Modify: `desktop/ambient-orb/test/settings-store.test.mjs`

**Interfaces:**
- Produces: `resolveDesktopConfig(...).codexConfigurationError: null | 'manual_path_required'`.
- Produces: one exported `validateModelBaseUrl(value): string` used for both Settings and environment inputs.
- Preserves: environment fallback only when no saved discovery-mode choice exists, represented by settings-store provenance rather than inference from a stale path.

- [ ] **Step 1: Add the precedence truth-table tests**

Cover saved auto plus stale saved path and env path; saved manual plus empty path; saved manual plus valid path; no saved mode plus env fallback; invalid Settings URL; invalid environment URL; and valid HTTPS/loopback HTTP URLs.

- [ ] **Step 2: Run the focused configuration tests**

Run: `node --test desktop/ambient-orb/test/platform-config.test.mjs desktop/ambient-orb/test/settings-store.test.mjs`

- [ ] **Step 3: Implement explicit provenance and validation**

The settings loader reports whether `codexBinaryMode` existed in persisted input. The resolver uses that provenance to choose Settings versus environment, clears stale paths in auto mode, emits `manual_path_required` for empty manual mode, and validates either source of `modelBaseUrl` through the same helper.

- [ ] **Step 4: Run configuration and startup suites**

Run: `node --test desktop/ambient-orb/test/platform-config.test.mjs desktop/ambient-orb/test/settings-store.test.mjs desktop/ambient-orb/test/desktop-startup.test.mjs`

- [ ] **Step 5: Commit precedence changes**

Commit message: `fix: make desktop settings precedence explicit`

### Task 4: Cross-Platform Discovery Verification

**Files:**
- Verify only.

**Interfaces:**
- Confirms: Windows native and npm invocation shapes plus unchanged macOS/Linux native discovery.

- [ ] **Step 1: Run all Codex discovery and host tests**

Run: `node --test desktop/ambient-orb/test/codex-discovery.test.mjs desktop/ambient-orb/test/desktop-startup.test.mjs desktop/ambient-orb/test/backend.test.mjs desktop/ambient-orb/test/packaged-codex-smoke.test.mjs && npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/config.test.js runtime/dist/test/codex-host-config.test.js runtime/dist/test/codex-process-owner.test.js`

- [ ] **Step 2: Run typecheck and environment-contract checks**

Run: `npm run typecheck --workspace @nova-audio-agent/runtime && npm run check:env-contract`

- [ ] **Step 3: Commit test-only corrections if required**

Commit message, only if needed: `test: cover cross-platform Codex invocation`
