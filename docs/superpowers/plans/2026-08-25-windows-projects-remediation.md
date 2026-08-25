# Windows Projects Durability And ACL Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Projects store commit successfully on Windows and create, verify, and repair application-owned directories without an insecure or identity-changing path race.

**Architecture:** Keep POSIX directory-fsync semantics unchanged, but model the Windows post-replace metadata commit as a distinct durability step. Extend the native project addon so ACL protection is verified and can be applied to an already-open directory handle; the desktop startup and repair IPC select directories in trusted main-process code and operate on retained handles.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Electron IPC, Node-API C addon, Windows ACL APIs, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-cross-platform-desktop-design.md`

## Global Constraints

- Windows must never report a successful POSIX directory `fsync`; its durable replace completion has the distinct step `windows_metadata_commit`.
- Default state remains rooted at `~/.nova-audio-agent` on Windows, macOS, and Ubuntu.
- ACL repair accepts only a root selected from current trusted settings; renderer-provided arbitrary paths are rejected.
- Windows default directory creation applies the protected owner-only DACL at creation time and verifies `SE_DACL_PROTECTED`.
- Existing user files and unrelated worktree changes are preserved.

---

### Task 1: Platform-Correct Store Durability

**Files:**
- Modify: `runtime/src/codex-project-store.ts`
- Modify: `runtime/test/codex-project-store.test.ts`

**Interfaces:**
- Produces: `DurabilityStep = 'temp_open' | 'file_fsync' | 'atomic_replace' | 'dir_fsync' | 'windows_metadata_commit'`.
- Produces: a successful Windows save after rename and identity revalidation without calling `FileHandle.sync()` on a directory.

- [ ] **Step 1: Write the failing Windows first-save test**

Add a test using `platform: 'win32'` that saves an empty store once, asserts `ok === true`, asserts `windows_metadata_commit` is published after `atomic_replace`, and asserts `dir_fsync` is absent.

- [ ] **Step 2: Run the focused test and confirm the current `EPERM`/`state_write_failed` failure**

Run: `npm run build --workspace @nova-audio-agent/runtime && node --test --test-name-pattern="Windows.*first save" runtime/dist/test/codex-project-store.test.js`

- [ ] **Step 3: Implement the platform branch after post-replace identity verification**

For `#platform === 'win32'`, publish `windows_metadata_commit` and do not call `directory.sync()`. For every other platform, retain the existing `directory.sync()` followed by `dir_fsync`.

- [ ] **Step 4: Add and run a POSIX regression test**

Assert Linux still performs `dir_fsync` and never publishes `windows_metadata_commit`.

Run: `npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/codex-project-store.test.js`

- [ ] **Step 5: Commit the isolated durability fix**

Commit message: `fix: make project commits durable on Windows`

### Task 2: Verified Handle-Based Windows ACL Protection

**Files:**
- Modify: `desktop/ambient-orb/native/project-native/project_native_windows.c`
- Modify: `desktop/ambient-orb/native/project-native/project_native_posix.c`
- Modify: `runtime/src/project-native-resource.ts`
- Modify: `runtime/test/project-native-resource.test.ts`
- Modify: `desktop/ambient-orb/test/native-project-addon.test.mjs`

**Interfaces:**
- Produces: native `protectHandle(fd): {status:'ok'} | {status:'error', code:string}`.
- Produces: `ProjectNativeHost.protectDirectoryHandle(handle: FileHandle): boolean`.
- Preserves: existing `protectDirectory(path)` for compatibility, implemented through the same verified ACL routine.

- [ ] **Step 1: Add failing addon contract tests**

Assert the binding exports `protectHandle`; a retained directory handle is protected successfully; the addon fails when the descriptor is not a directory; and Windows validation rejects a descriptor whose DACL is owner-only but not protected.

- [ ] **Step 2: Run the focused native tests**

Run: `npm run build:native:project --workspace @nova-audio-agent/ambient-orb && node --test desktop/ambient-orb/test/native-project-addon.test.mjs runtime/dist/test/project-native-resource.test.js`

- [ ] **Step 3: Implement one Windows handle routine for set-and-verify**

Use `_get_osfhandle`, `SetSecurityInfo`, and `GetSecurityInfo` on the retained directory handle. Verify owner SID equality, exactly one allow ACE for the owner, no inherited ACEs, and `GetSecurityDescriptorControl(..., &control, ...)` containing `SE_DACL_PROTECTED`; return a bounded stable code on failure.

- [ ] **Step 4: Implement the POSIX handle counterpart and TypeScript adapter**

The POSIX binding applies mode `0700` to the open descriptor and validates it with `fstat`. The TypeScript adapter accepts only the already-open `FileHandle.fd` and maps only `{status:'ok'}` to `true`.

- [ ] **Step 5: Run native and runtime contract suites**

Run: `npm run build:native:project --workspace @nova-audio-agent/ambient-orb && npm run build --workspace @nova-audio-agent/runtime && node --test desktop/ambient-orb/test/native-project-addon.test.mjs runtime/dist/test/project-native-resource.test.js`

- [ ] **Step 6: Commit the verified ACL primitive**

Commit message: `fix: verify project directory ACLs by handle`

### Task 3: Secure Default Creation And Explicit Repair

**Files:**
- Create: `desktop/ambient-orb/src/main/project-directories.mjs`
- Create: `desktop/ambient-orb/test/project-directories.test.mjs`
- Modify: `desktop/ambient-orb/src/main/desktop-startup.mjs`
- Modify: `desktop/ambient-orb/src/main/main.mjs`
- Modify: `desktop/ambient-orb/src/preload/preload.cjs`
- Modify: `desktop/ambient-orb/src/renderer/settings-controller.mjs`
- Modify: `desktop/ambient-orb/src/renderer/settings.mjs`
- Modify: `desktop/ambient-orb/src/renderer/settings.html`
- Modify: `desktop/ambient-orb/test/preload.test.mjs`
- Modify: `desktop/ambient-orb/test/settings-panel.test.mjs`
- Modify: `desktop/ambient-orb/test/main-security.test.mjs`

**Interfaces:**
- Produces: `ensurePrivateProjectDirectories({config, platform, openDirectory, nativeHost, pathApi}): Promise<void>`.
- Produces: IPC `nova:projects:repair` with request `{root:'state'|'managed'|'workspace'}` and response `{status:'ok'|'failed', code:string|null}`.
- Consumes: `nativeHost.rootFiles.mkdirAt(parentHandle, name)` and `nativeHost.protectDirectoryHandle(handle)`.

- [ ] **Step 1: Add failing pure tests for default creation and repair target selection**

Prove Windows creates `.nova-audio-agent`, `state`, `workspaces`, and in-root `default` descriptor-relatively, protects each retained handle before descendants are opened, rejects traversal/name separators, and never accepts a renderer path.

- [ ] **Step 2: Run the focused desktop tests**

Run: `node --test desktop/ambient-orb/test/project-directories.test.mjs desktop/ambient-orb/test/main-security.test.mjs`

- [ ] **Step 3: Implement protected descriptor-relative startup creation**

On Windows, open the canonical home directory once, create a missing child with native `mkdirAt`, reopen it without following a reparse point, verify the expected parent/name identity through the native lookup API, then protect and retain it before proceeding. On macOS/Linux retain recursive `mkdir(...,{mode:0o700})` plus post-open `fchmod` verification.

- [ ] **Step 4: Add repair IPC and settings UI**

The main process maps the root enum to the current resolved config, opens that exact directory, applies handle-based protection, and returns only stable codes. The preload exposes `repairProjectDirectory(root)`; Settings renders one repair control per configured root and never sends a path.

- [ ] **Step 5: Run security, preload, and settings tests**

Run: `node --test desktop/ambient-orb/test/project-directories.test.mjs desktop/ambient-orb/test/main-security.test.mjs desktop/ambient-orb/test/preload.test.mjs desktop/ambient-orb/test/settings-panel.test.mjs`

- [ ] **Step 6: Commit startup and repair integration**

Commit message: `fix: securely create and repair project directories`

### Task 4: Projects Regression Verification

**Files:**
- Verify only.

**Interfaces:**
- Confirms: all three preceding task interfaces coexist in development and packaged resource layouts.

- [ ] **Step 1: Run the full Projects and native-owner suites**

Run: `npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/codex-project-store.test.js runtime/dist/test/project-native-resource.test.js desktop/ambient-orb/test/native-project-addon.test.mjs desktop/ambient-orb/test/windows-native-owners.test.mjs desktop/ambient-orb/test/native-resource-contract.test.mjs`

- [ ] **Step 2: Run runtime typecheck and desktop build**

Run: `npm run typecheck --workspace @nova-audio-agent/runtime && npm run build --workspace @nova-audio-agent/ambient-orb`

- [ ] **Step 3: Commit any test-only corrections**

Commit message, only if needed: `test: cover Windows project durability and ACLs`
