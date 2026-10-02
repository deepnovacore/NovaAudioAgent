/** Every backend a project session can bind to. Codex keeps its native app-server transport. */
export const CODING_BACKEND_IDS = Object.freeze(['codex', 'opencode', 'codebuddy', 'pi', 'deepseek'] as const)
export type CodingBackendId = typeof CODING_BACKEND_IDS[number]

/** Backends reached through the Agent Client Protocol. */
export const ACP_BACKEND_IDS = Object.freeze(['opencode', 'codebuddy', 'pi', 'deepseek'] as const)
export type AcpBackendId = typeof ACP_BACKEND_IDS[number]

export function isAcpBackend(value: CodingBackendId): value is AcpBackendId {
  return (ACP_BACKEND_IDS as readonly string[]).includes(value)
}
