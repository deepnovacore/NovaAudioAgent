# Projects Platform Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Codex Projects filesystem guarantees on Windows, macOS, and Ubuntu using native platform security semantics.

**Architecture:** Keep one `CodexProjectStore` and inject a platform filesystem-security authority. POSIX retains UID/mode validation; Windows delegates SID/DACL/reparse/handle identity and descriptor-relative operations to the existing native addon.

**Tech Stack:** TypeScript, Node-API C addon, Win32 security APIs, POSIX filesystem APIs, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-cross-platform-desktop-design.md`

## Global Constraints

- Never skip ownership, no-follow, identity, lock, atomicity, or durability checks.
- Windows must not interpret POSIX `Stats.uid`, `Stats.mode`, or `chmod` as an ACL proof.
- Unsafe existing roots require an explicit repair action.
- Default app-owned roots are secure at creation time.

---

### Task 1: Define the platform security boundary

**Files:**
- Create: `runtime/src/project-filesystem-security.ts`
- Modify: `runtime/src/project-native-resource.ts`
- Test: `runtime/test/project-filesystem-security.test.ts`
- Test: `runtime/test/project-native-resource.test.ts`

**Interfaces:**
- Produces `ProjectFilesystemSecurity` with `validateRoot`, `provisionRoot`, `validateFile`, and `repairOwnedRoot` methods returning exact synchronous native results.
- Produces `createProjectFilesystemSecurity({platform,native,fs})`.

- [ ] **Step 1: Write failing tests** proving POSIX dispatches to UID/mode checks, Windows requires native authority, and malformed values fail closed:

  ```ts
  const security = createProjectFilesystemSecurity({platform: 'win32', native, fs})
  assert.deepEqual(security.validateRoot('C:\\Users\\nova\\.nova-audio-agent'), identity)
  assert.throws(() => createProjectFilesystemSecurity({platform: 'win32', native: null, fs}),
    (error: unknown) => hasProjectCode(error, 'state_permissions'))
  ```
- [ ] **Step 2: Run** `npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/project-filesystem-security.test.js runtime/dist/test/project-native-resource.test.js` and verify failure.
- [ ] **Step 3: Implement** the policy factory and exact result validation around this interface; export no raw authority from the package root:

  ```ts
  export interface ProjectFilesystemSecurity {
    validateRoot(path: string): ProjectFileIdentity
    provisionRoot(path: string): ProjectFileIdentity
    validateFile(root: ProjectFileIdentity, name: string): ProjectFileIdentity
    repairOwnedRoot(path: string): ProjectFileIdentity
  }
  export function createProjectFilesystemSecurity(options: SecurityOptions): ProjectFilesystemSecurity
  ```
- [ ] **Step 4: Run focused runtime tests** and verify pass.
- [ ] **Step 5: Commit** with `refactor: isolate project filesystem security`.

### Task 2: Extend Windows native root security

**Files:**
- Modify: `desktop/ambient-orb/native/project-native/project_native_windows.c`
- Modify: `desktop/ambient-orb/scripts/build-project-native.mjs`
- Modify: `desktop/ambient-orb/test/fixtures/project-native-addon-behavior.cjs`
- Test: `desktop/ambient-orb/test/native-project-addon.test.mjs`
- Test: `desktop/ambient-orb/test/windows-native-owners.test.mjs`

**Interfaces:**
- Produces native `validate_root`, `provision_root`, and `repair_owned_root` operations with `{ok:true,identity}` or bounded `{ok:false,code}` data.
- `identity` contains only opaque volume/file identifiers; no private path or SID text crosses to JavaScript.

- [ ] **Step 1: Add failing native behavior tests** for protected owner DACL creation, broad ACE refusal, reparse refusal, replacement, and repair:

  ```js
  const provisioned = addon.provision_root({path: root})
  assert.deepEqual(Object.keys(provisioned).sort(), ['identity', 'ok'])
  assert.equal(provisioned.ok, true)
  assert.deepEqual(addon.validate_root({path: broadAclRoot}), {ok: false, code: 'permissions'})
  ```
- [ ] **Step 2: Run** `npm run build:native:project --workspace @nova-audio-agent/ambient-orb` followed by the two native tests and verify failure.
- [ ] **Step 3: Implement** native operations registered under exact names:

  ```c
  DECLARE_NAPI_METHOD("validate_root", nova_validate_root),
  DECLARE_NAPI_METHOD("provision_root", nova_provision_root),
  DECLARE_NAPI_METHOD("repair_owned_root", nova_repair_owned_root),
  ```

  Use the current user SID, protected DACLs, `FILE_FLAG_OPEN_REPARSE_POINT`, handle-derived security information, and file identity comparison. Create roots with the secure descriptor in the initial creation call.
- [ ] **Step 4: Rebuild and rerun native tests**; verify pass on Windows and existing POSIX contract remains unchanged.
- [ ] **Step 5: Commit** with `feat: enforce Windows project root ACLs`.

### Task 3: Adapt `CodexProjectStore`

**Files:**
- Modify: `runtime/src/codex-project-store.ts`
- Modify: `runtime/src/codex-process-owner.ts`
- Test: `runtime/test/codex-project-store.test.ts`
- Test: `runtime/test/codex-process-owner.test.ts`

**Interfaces:**
- Consumes `ProjectFilesystemSecurity` and native descriptor-relative root-file authority.
- Produces the unchanged public Projects API and persistence schema.

- [ ] **Step 1: Add failing Windows-gated tests** for default-root provisioning, transactions, locks, atomic replace, rollback, crash recovery, and path spellings:

  ```ts
  test('Windows store uses native security instead of POSIX uid and mode', {skip: process.platform !== 'win32'},
    async () => {
      const store = await CodexProjectStore.open(options)
      await store.ensureImported({workspace: canonicalWorkspace})
      assert.equal(store.publicView().workspaces.length, 1)
    })
  ```
- [ ] **Step 2: Run the compiled focused tests** and verify Windows failures match the old UID/mode assumptions.
- [ ] **Step 3: Replace direct UID/mode checks** with an injected member and canonicalize before equality:

  ```ts
  readonly #security: ProjectFilesystemSecurity
  const canonicalConfigured = realpathSync(resolve(configured))
  if (!samePlatformPath(canonicalConfigured, canonicalCandidate, process.platform)) {
    throw new ProjectStateError('state_path')
  }
  ```

  Remove Windows `chmod` calls while keeping descriptor locks, identity pins, and poison-on-replacement behavior.
- [ ] **Step 4: Run** the full `codex-project-store`, `codex-process-owner`, and native addon tests.
- [ ] **Step 5: Commit** with `feat: support secure Codex Projects on Windows`.
