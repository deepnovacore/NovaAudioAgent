# Cross-Platform Desktop Design

## Goal

Make Nova Audio Agent's desktop client installable and usable on Windows, macOS,
and Ubuntu without a hand-written `.env`, while preserving the current security
model for Codex Projects and providing actionable connection and microphone
diagnostics.

## Product Decisions

- User-installed Codex CLI is discovered automatically. It is not bundled.
- User overrides and secrets live in the existing desktop settings store.
- Environment variables remain a developer and advanced-release fallback.
- The default application-owned layout is:

  ```text
  ~/.nova-audio-agent/
  ├── state/
  └── workspaces/
      └── default/
  ```

- The application requests microphone permission automatically once during
  first-run readiness, releases the probe stream immediately, and does not
  begin persistent listening until the user activates the orb.
- Automatic listening on launch is an opt-in setting and defaults to off.
- A failed backend or provider does not close the desktop window. The client
  supervises, diagnoses, and reconnects it.

## Configuration Resolution

The Electron main process owns one typed configuration resolver. Resolution is
performed in this order:

1. Valid desktop settings explicitly saved by the user.
2. Supported environment variables for development and managed deployments.
3. Platform-neutral product defaults derived from the user's home directory.

Paths are expanded and canonicalized once at this boundary. Downstream code
receives canonical absolute paths and never compares a user spelling directly
to a `realpath` result. Windows comparisons account for separator and case
semantics without weakening the canonical allowlist.

The settings schema is migrated to version 3 and adds:

- `codexBinaryMode`: `auto` or `manual`.
- `codexBinaryPath`: an optional absolute manual override.
- `codexProjectsEnabled`: boolean.
- `codexWorkspace`: canonical workspace selection.
- `codexManagedRoot`: canonical managed-workspace root.
- `modelBaseUrl`: validated HTTPS or explicitly permitted loopback URL.
- `startListeningOnLaunch`: boolean, default false.

Existing model, voice, provider, Tavily, and API-key settings remain. Secrets
continue to use Electron `safeStorage` and never enter a renderer or log line.
Advanced release-smoke, test-fixture, and backend-debug controls remain
environment-only.

The settings panel exposes Codex discovery status and version, login status,
rescan and manual override, Projects enablement and paths, provider connection
status and reconnect, microphone status and test controls, model configuration,
voice configuration, and API credentials. Saving a launch-affecting setting
requests a controlled backend restart rather than requiring an app restart.

## Codex CLI Discovery

Discovery is implemented as a pure, testable platform catalog followed by a
bounded version/login probe:

- Windows searches `PATH` using Windows executable resolution, including
  `codex.cmd`, and checks the standard per-user npm shim directory. The stored
  result is the invocation tuple required by Node; code must not assume a
  `codex.exe` exists.
- macOS and Ubuntu search `PATH` and the reviewed common user-local binary
  locations.
- Manual paths are canonicalized and validated through the same executable
  policy as automatic results.
- Discovery results show source, version, and readiness but never expose login
  material.
- Rescan is explicit and also occurs when a previous automatic candidate stops
  working.

The existing host catalog and process-owner boundary remains authoritative.
Discovery supplies candidates; it does not bypass sandbox probing, command
allowlisting, environment isolation, or process-tree supervision.

## Cross-Platform Projects Security

`CodexProjectStore` remains a shared state machine and persistence format. Its
filesystem authority is moved behind a platform security policy instead of
forking separate stores.

On POSIX systems, the policy retains the current guarantees:

- Current effective UID owns roots and files.
- Directories use owner-only modes and files use owner-only modes.
- Symlinks are refused.
- Descriptor-relative operations, inode identity pins, native locks, atomic
  replace, durability, and crash recovery remain mandatory.

On Windows, security is evaluated with Windows primitives rather than
`Stats.uid`, POSIX mode bits, or `chmod`:

- The existing native project addon opens roots and children with no-follow
  reparse handling.
- The current user's SID must own the object.
- DACLs must be protected and grant filesystem authority only to the reviewed
  principals required by the application; broad writable ACEs are refused.
- Root and child handle identity is retained and compared across operations to
  reject junction/reparse swaps and same-path replacements.
- Creation uses a protected owner-only security descriptor from the first
  visible handle; there is no insecure create-then-repair window.
- Native locks, descriptor-relative create/read/replace/rename/unlink, atomic
  persistence, rollback, and crash recovery remain fail-closed.

Existing unsafe user-selected directories are not silently rewritten. Settings
reports the unsafe ACL and offers an explicit repair action scoped to the exact
selected application-owned root. The default `~/.nova-audio-agent` tree is
securely provisioned on first use.

Windows tests cover protected DACLs, broad ACE refusal, reparse points and
junctions, handle replacement, lock exclusion, crash recovery, rollback, path
case/separator variants, and default-root provisioning. POSIX tests continue to
cover UID/mode and symlink behavior.

## Backend and Provider Supervision

Electron main owns a persistent backend supervisor with explicit states:

- `starting`
- `connected`
- `reconnecting`
- `configuration_required`
- `authentication_failed`
- `unavailable`
- `stopped`

Spawn errors, early exits, provider authentication failures, and transport
closures are classified into bounded credential-free diagnostics. Recoverable
failures use capped exponential backoff with jitter. Only one generation can
own a process and WebSocket endpoint; stale generation callbacks cannot mutate
the current state. Settings changes cancel the current generation, drain it,
and start a new generation.

The orb remains visible while disconnected and shows the current diagnostic and
retry action. Renderer WebSocket reconnection follows supervisor endpoint
updates rather than treating the first close as terminal. Application quit is
the only ordinary path that permanently stops supervision.

## Microphone Permission and Capture

Permission discovery and active capture are separate concepts.

After the orb is shown and its renderer is ready, a first-run permission
preflight requests an audio-only `getUserMedia` stream. If granted, every track
is stopped immediately. This creates the system decision without beginning a
listening session. The preflight is idempotent and is not repeated after a
definitive decision unless requested from Settings.

Platform behavior is:

- macOS checks `getMediaAccessStatus('microphone')`, calls
  `askForMediaAccess('microphone')` when undetermined, and then verifies browser
  capture. Packaged metadata retains `NSMicrophoneUsageDescription` and the
  required entitlements.
- Windows checks `getMediaAccessStatus('microphone')`; Chromium
  `getUserMedia` performs the actual device request. If the global Win32
  microphone control is denied, Settings offers the exact
  `ms-settings:privacy-microphone` link. The app never claims it can grant this
  OS setting itself.
- Ubuntu uses Chromium `getUserMedia` and reports portal, PipeWire/PulseAudio,
  and device availability failures through the same public taxonomy.

Capture failures preserve their real category:

- `not_determined`
- `prompting`
- `granted`
- `permission_denied`
- `permission_restricted`
- `no_input_device`
- `device_busy`
- `capture_unavailable`
- `audio_pipeline_error`

Only `NotAllowedError` or a denied/restricted system status renders a permission
denial. `NotFoundError`, `NotReadableError`, missing media APIs, AudioContext
failure, AudioWorklet failure, and native-audio fallback failure keep distinct
diagnostics. Raw exception text, device identifiers, and host paths never enter
the UI or logs.

Clicking the orb starts active capture after preflight. An optional
`startListeningOnLaunch` setting starts active capture after readiness only when
the user has explicitly enabled it. Deactivation releases all browser and
native resources and does not erase the remembered permission status.

## Packaging and First Run

Packaged applications contain the Node runtime backend and reviewed native
helpers for their target, but not Codex CLI or user secrets. Default paths are
derived at runtime from the actual user home, never the build machine.

The first-run experience keeps the orb open and leads the user through:

1. Microphone permission status.
2. Codex discovery and login readiness.
3. Provider credentials and connectivity.
4. Optional Projects enablement and workspace selection.

The app is usable for settings and diagnostics even when any optional provider
or Codex capability is unavailable. A packaged Windows EXE therefore needs no
manual `.env`; normal user configuration is stored through Settings.

## Verification

Verification is layered:

- Unit tests for configuration precedence, migration, discovery, canonical
  paths, microphone classification, and supervisor transitions.
- Runtime Projects tests on Windows and POSIX, including native security and
  race cases.
- Desktop integration tests for preload IPC sender validation, secret
  non-disclosure, settings-triggered restart, permission preflight, reconnect,
  and renderer state labels.
- `npm run check`, targeted native builds, and full `npm test` on the host.
- Windows packaged smoke test from a clean settings state, including microphone
  preflight, Settings configuration, Codex discovery through `codex.cmd`,
  backend reconnect, and Projects default-root creation.
- CI package/test matrix for Windows, macOS, and Ubuntu. Platform-native
  permission and ACL tests run only on their owning OS; shared contract tests
  run everywhere.

## Baseline Note

Before implementation, `npm test` on Windows produced many failures in tests
that assume POSIX ownership/mode behavior for credential, Projects, and graph
state roots, then stopped making progress with retained Node subprocesses. This
is recorded as the pre-change Windows baseline and is part of the cross-platform
work rather than a newly introduced regression.
