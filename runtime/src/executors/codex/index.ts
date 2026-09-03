/**
 * Public surface of the Codex executor package.
 *
 * Core (`runtime/src/**` outside `executors/**` and the composition roots) never imports anything
 * under `executors/codex/`; composition roots and the barrel reach Codex only through this module
 * or the registry in `../index.ts`. `scripts/check-executor-boundary.mjs` enforces that.
 */
export * from './app-server-schema.js'
export {
  CODEX_DEVELOPER_INSTRUCTIONS_LIMIT,
  CODEX_FINAL_TEXT_LIMIT,
  CODEX_INTERRUPT_GRACE_MS,
  CODEX_PREFLIGHT_LIMIT_MS,
  CODEX_STDERR_LIMIT,
  CODEX_THREAD_ID_LIMIT,
  CODEX_TREE_GRACE_MS,
  CODEX_WORK_ORDER_LIMIT,
  CodexTransportError,
  type CodexAppServerLaunchConfig,
  type CodexAppServerTransport,
  type CodexHostPreflightRunner,
  type CodexLiveSchemaProbe,
  type CodexTransportCode,
  type RunInput,
  type SafePreflightReport,
  type SteerInput,
  type SteerTransportResult,
  type TransportDeadline,
  type TransportObserver,
  type TransportOutcome,
} from './app-server-transport.js'
export * from './contract.js'
export * from './version.js'
export {
  CODEX_CREDENTIAL_MARKER,
  CODEX_SAVED_LOGIN_FILES,
  CodexCredentialError,
  MAX_CREDENTIAL_BYTES,
  MAX_CREDENTIAL_MARKER_BYTES,
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
