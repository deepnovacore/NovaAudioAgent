# Windows and Ubuntu Packaging Completion Design

**Date:** 2026-08-23

**Status:** Approved in chat; awaiting review of this written specification

## Goal

Restore one-command development startup after the extensible audio-pipeline merge, then make the repository's existing Windows and Ubuntu packaging paths produce downloadable, inspected, install-smoked unsigned artifacts on their native GitHub Actions runners.

The deliverables are:

- a source checkout that starts the default integrated Qwen client with the repository's existing compatible DashScope configuration;
- a Windows x64 per-user NSIS installer;
- an Ubuntu x64 AppImage;
- an Ubuntu x64 deb package; and
- CI evidence that each artifact was built, inspected, installed or unpacked, started with the Node backend, authenticated, exercised, stopped, and left no owned descendant processes.

Commercial Windows signing, release publication, and production-provider or hardware certification are outside this slice.

## Current Failure Evidence

The local `.env` contains a non-empty `NOVA_AUDIO_AGENT_MODEL_API_KEY`, an exact DashScope-compatible `NOVA_AUDIO_AGENT_MODEL_BASE_URL`, and `TAVILY_API_KEY`, but no `DASHSCOPE_API_KEY`. The legacy Qwen resolver accepts this configuration. The new integrated resolver rejects it with `ConfigurationError: 缺少 DASHSCOPE_API_KEY`, which is caught at the desktop ownership boundary and rendered as the observed `assembly_failed` diagnostic.

The repository already defines native Windows and Linux builder targets and release smoke scripts. They are not currently proven by CI. The latest remote Windows electron job failed before packaging because the parity audit excluded `runtime/src/unicode-tables.ts` using a POSIX-only relative spelling. The Ubuntu electron job failed on two host assumptions: immediate inode non-reuse and exact ICU-version-dependent transformation counts. Since the package job depends on the electron matrix, no Windows or Ubuntu artifact was produced.

## Scope

### In scope

- Integrated Qwen credential compatibility at the configuration boundary.
- A regression test for the exact legacy-compatible DashScope case and negative cross-endpoint cases.
- Windows path normalization in the parity audit.
- Platform-neutral project-store rollback assertions that do not depend on an allocator choosing a new inode number.
- Unicode pin tests that prove pinned behavior without fixing the host ICU's incidental mismatch count.
- Native Windows and Ubuntu CI builds using the existing repository-owned native builders.
- Strict package inspection and installed-candidate smoke for NSIS, AppImage, and deb.
- Artifact upload with stable filenames and SHA-256 sidecars.
- User documentation for downloading and running unsigned CI artifacts.

### Out of scope

- Authenticode certificates, production Windows signing, and trust-chain verification.
- Publishing a GitHub Release or changing release-channel defaults.
- macOS packaging changes except where a shared test must remain green.
- Python runtime, Python documentation, or deletion of compatibility source.
- Provider live credentials, real microphone/speaker latency, and camera hardware success.
- Cross-building Windows or Linux packages on macOS.

## Startup Compatibility

`requireIntegratedRealtime` remains the only host-owned resolver for integrated Qwen. It resolves the credential in this order:

1. A nonblank `DASHSCOPE_API_KEY` wins.
2. Otherwise, `NOVA_AUDIO_AGENT_MODEL_API_KEY` may be reused only when the normalized `NOVA_AUDIO_AGENT_MODEL_BASE_URL` is exactly `https://dashscope.aliyuncs.com/compatible-mode/v1`.
3. Any other endpoint with only a generic model key is rejected as missing `DASHSCOPE_API_KEY`.

This is a compatibility rule, not a general credential alias. It prevents a key intended for an unrelated OpenAI-compatible endpoint from being sent to DashScope. Cascaded Qwen continues to require its selected-provider credential because a cascaded graph may independently override support-model routing. Explicit provider keys are never copied into persisted settings or diagnostics.

The regression test must prove the legacy-compatible environment reaches an immutable integrated config, the explicit provider key takes precedence, and a foreign generic endpoint cannot activate the fallback. After the code gate, the actual `npm run start:client` path must be launched outside the sandbox and must reach the authenticated desktop readiness boundary. A live process without readiness is not success.

## Cross-Platform Determinism

### Parity source inventory

All repository-relative paths are normalized to `/` before filtering, sorting, hashing, and comparison. The generated manifest remains platform-independent. A behavioral test supplies Windows-style relative paths to the inventory helper and proves `runtime/src/unicode-tables.ts` is excluded exactly once while ordinary sources retain canonical spellings.

### Project-store rollback test

The product requirement is that a failed rollback restores a safe managed directory and advances the store's retained identity to the restored object. Filesystems may legally reuse the just-unlinked inode, so numeric inequality is not the contract. The test will assert the observable authority behavior: the restored directory is owner-only, the store revalidates it, stale pre-rollback authority cannot remove or redirect it, and a later rollback succeeds. Production identity checks remain unchanged.

### Unicode pin test

The pinned Unicode result and committed vectors remain exact. The host ICU comparison proves that every transformed code point unknown to the pin is held back and that both decomposition and case-mapping mechanisms are represented. It does not assert an exact number of host divergences because that number changes with Node's ICU database. Fixed literal vectors continue to prove the security-relevant Unicode 16 examples.

## Native Build Matrix

The CI package matrix runs on native hosted runners:

| Runner | Target | Required native outputs | Installer outputs |
| --- | --- | --- | --- |
| `windows-latest` | `win32-x64` | project authority `.node`, Codex sandbox probe `.exe`, Windows job guardian `.exe` | NSIS `.exe` |
| `ubuntu-latest` | `linux-x64-gnu` | project authority `.node`, Codex sandbox probe | AppImage and deb |

Each job performs `npm ci`, `npm run check`, runtime tests, desktop tests, the workspace build, the platform package command, and the strict release-package inspector. Platform-native compilation must fail closed if MSVC or the POSIX compiler is unavailable. No downloaded prebuilt Nova native authority replaces the repository build.

The package job must be independently diagnosable per platform. A failure on one platform must not erase the successful platform's logs or artifacts. Shared source tests still gate both jobs, but the matrix retains `fail-fast: false` and uploads only after that target's own inspection succeeds.

## Installed Artifact Smoke

The existing checkout-free smoke kit is the authority. For every candidate it must:

1. verify the artifact against its SHA-256 sidecar;
2. install or extract the exact candidate using the target platform's native mechanism;
3. launch the installed application with a poisoned Python/PATH environment so only the packaged Node backend can succeed;
4. wait for the authenticated readiness channel;
5. exercise the bounded control path;
6. request graceful quit and enforce its deadline;
7. independently verify that the owned process tree is gone; and
8. remove the installed or extracted candidate and verify no application residue remains in the smoke root.

AppImage smoke runs under `xvfb-run`; deb smoke installs into or extracts beneath the job's isolated smoke root according to the existing script contract. NSIS remains a non-silent per-user installer. Camera capability may report its existing exact unavailable sentinel; unavailable is pending evidence, never a false pass for camera behavior.

## Artifact Contract

Successful jobs upload only these stable user-facing files and matching lowercase SHA-256 sidecars:

- `nova-win32-x64.exe`
- `nova-linux-x64.AppImage`
- `nova-linux-x64.deb`

The artifact collector derives them from a single inspected candidate directory and rejects missing, duplicate, or extra installer formats. CI uploads Windows and Ubuntu bundles separately so either can be downloaded without the source tree. The workflow summary records filenames and digests but no local paths, credentials, environment contents, or signing claims.

## Documentation

The English and Chinese getting-started documentation will describe:

- `npm run start:client` for source development;
- where to download the three CI artifacts;
- that these CI artifacts are unsigned development candidates;
- Windows SmartScreen and Linux executable-bit expectations without suggesting users disable OS protections globally; and
- AppImage versus deb usage.

Mainline user documentation will not introduce Python instructions.

## Error Handling and Security

- Credential values never appear in tests, diagnostics, workflow summaries, or artifact metadata.
- The credential fallback is endpoint-bound and cannot be selected by renderer input.
- Package inspection remains fail-closed for dependency closure, native resources, architecture, ABI, file mode, and unexpected unpacked files.
- Installed smoke timeouts are hard bounds and always run cleanup.
- Unsigned artifacts are labelled accurately; no job reports signing, notarization, provider-live, camera, or hardware success.

## Verification

Local verification before push:

- focused RED/GREEN tests for credential resolution and each cross-platform regression;
- `npm run check`;
- `npm run build`;
- full runtime and desktop suites;
- `git diff --check`; and
- an actual local `npm run start:client` readiness observation followed by graceful shutdown.

Remote verification after push:

- Windows electron and package jobs pass;
- Ubuntu electron and package jobs pass;
- NSIS, AppImage, and deb strict inspection pass;
- all three installed-candidate smoke jobs pass;
- Actions uploads contain exactly the stable filenames and sidecars; and
- downloaded artifact hashes match the workflow-reported values.

No cross-platform packaging completion claim is made until the native runner jobs and installed smoke finish successfully.
