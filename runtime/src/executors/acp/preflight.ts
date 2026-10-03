/**
 * An ACP handshake report. It proves only that a protocol connection was negotiated; unlike the
 * Codex app-server certification it makes no claim about sandbox, mount or network enforcement.
 * Kept free of SDK imports so shared Codex contract code can validate it cheaply.
 */
export interface AcpPreflightReport extends Readonly<Record<string, unknown>> {
  readonly protocol: 'acp'
  readonly version: string
  readonly backend: string
  readonly connected: true
  /** Agent-reported release, distinct from the ACP protocol version and not an attestation. */
  readonly agent_version?: string
  readonly tested_version?: string
}

const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,79}$/u

/** Input must already be a data-only snapshot, not an object with accessors. */
export function sanitizeAcpPreflightReport(value: Readonly<Record<string, unknown>>): AcpPreflightReport | null {
  const metadata = Object.hasOwn(value, 'agent_version') || Object.hasOwn(value, 'tested_version')
  if (metadata && [value.agent_version, value.tested_version].some(version =>
    typeof version !== 'string' || !VERSION.test(version))) return null
  if (Object.keys(value).length !== (metadata ? 6 : 4) || value.protocol !== 'acp' || value.connected !== true
    || typeof value.version !== 'string' || !VERSION.test(value.version)
    || typeof value.backend !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value.backend)) return null
  return Object.freeze({protocol: 'acp', version: value.version, backend: value.backend, connected: true,
    ...(metadata ? {agent_version: value.agent_version as string, tested_version: value.tested_version as string} : {})})
}
