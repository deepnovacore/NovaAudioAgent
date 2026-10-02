/**
 * Host-authority surface of the Codex executor package: spawn factories, host config resolution,
 * the approval controller and the production host. Only composition roots (`desktop-entry.ts`,
 * `*-assembly.ts`) import this; it is deliberately absent from the package-root barrel so the
 * runtime package never exports authority bypasses (`test/codex-root-exports.test.ts`).
 */
export * from './approval-protocol.js'
export {OwnedCodexAppServerTransport} from './app-server-transport.js'
export {
  CredentialSnapshotter,
  credentialSnapshotEnvironment,
  type CredentialSnapshot,
} from './credential-snapshot.js'
export * from './factory.js'
export * from './host-config.js'
export * from './production-host.js'

export {prepareManagedCodexMcp, type ManagedCodexMcp} from './managed-mcp.js'
export {loadWindowsGuardianFactoryFromResources} from './windows-guardian.js'
/** ACP routing for non-Codex sessions, loaded through this same lazy host entry. */
export {createAcpBackendRouting} from '../acp/transport.js'
