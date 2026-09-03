/**
 * Public surface of the Codex executor package.
 *
 * Core (`runtime/src/**` outside `executors/**` and the composition roots) never imports anything
 * under `executors/codex/`; composition roots and the barrel reach Codex only through this module
 * or the registry in `../index.ts`. `scripts/check-executor-boundary.mjs` enforces that.
 */
export * from './app-server-schema.js'
export * from './app-server-transport.js'
export * from './contract.js'
export * from './version.js'
export {
  CODEX_CREDENTIAL_MARKER,
  CODEX_SAVED_LOGIN_FILES,
  CodexCredentialError,
  CredentialSnapshotter,
  MAX_CREDENTIAL_BYTES,
  MAX_CREDENTIAL_MARKER_BYTES,
  credentialSnapshotEnvironment,
  type CredentialSnapshot,
} from './credential-snapshot.js'
export * from './jsonl.js'
export * from './protocol.js'
export * from './turn-projection.js'
export * from './adapter.js'
export * from './adapter-live.js'
export * from './adapter-project.js'
export {
  WINDOWS_GUARDIAN_FRAME_LIMIT,
  WINDOWS_GUARDIAN_READY_TIMEOUT_MS,
  CodexWindowsGuardianError,
  WindowsGuardianControlParser,
  windowsGuardianForceFrame,
  type WindowsGuardianFrame,
} from './windows-guardian.js'
