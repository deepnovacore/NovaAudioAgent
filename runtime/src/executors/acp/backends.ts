import {isAbsolute} from 'node:path'

import type {AcpBackendId} from '../../config/coding-backends.js'
export type {AcpBackendId} from '../../config/coding-backends.js'

/** Launch facts for one ACP backend. Codex is not listed: it keeps the native app-server transport. */
export interface AcpBackendDefinition {
  readonly id: AcpBackendId
  readonly displayName: string
  readonly packageName: string
  /** Published launch-contract baseline, not a claim of live acceptance. */
  readonly packageVersion: string
  readonly command: string
  readonly perToolApproval: boolean
  /** ACP MCP injection is unverified or absent; any granted server refuses the run. */
  readonly mcpInjection: boolean
  readonly limitations: readonly string[]
}

const definitions: AcpBackendDefinition[] = [
  {id: 'opencode', displayName: 'OpenCode', packageName: 'opencode-ai', packageVersion: '1.18.31', command: 'opencode',
    perToolApproval: true, mcpInjection: true,
    limitations: ['Native configuration and negotiated session capabilities require live verification.']},
  {id: 'codebuddy', displayName: 'CodeBuddy', packageName: '@tencent-ai/codebuddy-code', packageVersion: '2.154.0', command: 'codebuddy',
    perToolApproval: true, mcpInjection: true,
    limitations: ['Full mode can still request confirmation for dangerous commands. Multitask is not enabled.']},
  {id: 'pi', displayName: 'Pi', packageName: 'pi-acp', packageVersion: '0.0.33', command: 'pi-acp',
    perToolApproval: false, mcpInjection: false,
    limitations: ['No per-tool approval; ask mode is unsupported.',
      'ACP MCP injection is unsupported; granted MCP servers are refused before session creation.',
      'Requires a separately installed Pi executable.']},
  {id: 'deepseek', displayName: 'DeepSeek Harness', packageName: '@deepseek-ai/dsh', packageVersion: '0.1.5-rc.2', command: 'dsh',
    perToolApproval: true, mcpInjection: true,
    limitations: ['Resume and MCP exist in the matching published ACP package; transcript replay does not.',
      'Host must enforce permission intent through ACP permission replies.']},
]

export const ACP_BACKENDS: readonly AcpBackendDefinition[] = Object.freeze(definitions.map(backend => Object.freeze({
  ...backend,
  limitations: Object.freeze(backend.limitations),
})))

export function acpBackend(id: AcpBackendId): AcpBackendDefinition {
  const backend = ACP_BACKENDS.find(candidate => candidate.id === id)
  if (backend === undefined) throw new Error('Unknown ACP backend')
  return backend
}

const PLATFORM_ENV = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'Path',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]

// No wildcard prefixes: provider keys belong only to the explicitly selected backend.
export const ACP_BACKEND_ENV: Readonly<Record<AcpBackendId, readonly string[]>> = Object.freeze({
  opencode: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'],
  codebuddy: ['CODEBUDDY_API_KEY', 'CODEBUDDY_BASE_URL'],
  pi: ['PI_CODING_AGENT_DIR', 'PI_ACP_ENABLE_EMBEDDED_CONTEXT'],
  deepseek: ['DSH_HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'],
})

export interface AcpLaunchInput {
  readonly backendId: AcpBackendId
  readonly cwd: string
  /** Already approved/discovered by the host; never a shell command or package spec. */
  readonly binaryPath?: string
  /** Native Pi executable behind its ACP adapter. */
  readonly parentExecutable?: string
  readonly permissionMode: 'ask' | 'full'
  readonly env: NodeJS.ProcessEnv
}

function assertAbsolutePath(value: string, field: string): void {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(`${field} must be an absolute path without control characters`)
  }
}

/** Caller must spawn with shell:false and cwd:input.cwd, and own permission callbacks. */
export function resolveAcpLaunch(input: AcpLaunchInput): {command: string; args: readonly string[]; env: NodeJS.ProcessEnv} {
  const backend = acpBackend(input.backendId)
  if (input.permissionMode !== 'ask' && input.permissionMode !== 'full') throw new Error('Invalid permissionMode')
  assertAbsolutePath(input.cwd, 'cwd')
  if (input.binaryPath !== undefined) assertAbsolutePath(input.binaryPath, 'binaryPath')
  if (input.parentExecutable !== undefined) {
    assertAbsolutePath(input.parentExecutable, 'parentExecutable')
    if (backend.id !== 'pi') throw new Error('parentExecutable is only supported by the Pi adapter')
  }
  if (!backend.perToolApproval && input.permissionMode === 'ask') throw new Error('Pi does not support per-tool approval')
  const result: NodeJS.ProcessEnv = {}
  for (const name of [...PLATFORM_ENV, ...ACP_BACKEND_ENV[backend.id]]) {
    const value = input.env[name]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid environment value for ${name}`)
    result[name] = value
  }
  result.PWD = input.cwd
  let args: readonly string[] = []
  switch (backend.id) {
    case 'opencode':
      args = ['acp']
      result.OPENCODE_PERMISSION = JSON.stringify({'*': input.permissionMode === 'full' ? 'allow' : 'ask'})
      break
    case 'codebuddy':
      args = ['--acp', ...(input.permissionMode === 'full' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'default'])]
      break
    case 'pi':
      if (input.parentExecutable !== undefined) result.PI_ACP_PI_COMMAND = input.parentExecutable
      break
    case 'deepseek':
      args = ['--profile', 'acp']
      break
  }
  return {command: input.binaryPath ?? backend.command, args, env: result}
}
