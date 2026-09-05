import {lstatSync, realpathSync} from 'node:fs'
import {isAbsolute, relative, resolve, sep} from 'node:path'
import {z} from 'zod'

import {HostApprovalController, type HostApprovalControllerOptions as CodexApprovalControllerOptions, type ApprovalPort as CodexApprovalPort} from '../../approval.js'
export type {CodexApprovalControllerOptions, CodexApprovalPort}
import {
  APPROVAL_TTL_SECONDS,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalLocalDetail,
  type ApprovalView,
  type ApprovalWork,
  type FileChangeDisplay,
} from '../../approval-port.js'
import {snapshotJsonRecord} from './safe-json.js'
import {codePointLengthLikePython, isWellFormed, stripLikePython} from '../../python-text.js'

export const CODEX_APPROVAL_TTL_SECONDS = APPROVAL_TTL_SECONDS
const CODEX_APPROVAL_COMMAND_LIMIT = 4096
const CODEX_APPROVAL_PATH_LIMIT = 4096
const CODEX_APPROVAL_CHANGE_LIMIT = 64
const CODEX_APPROVAL_SUMMARY_LIMIT = 256
const CODEX_APPROVAL_PROTOCOL_ID_LIMIT = 256
const CODEX_APPROVAL_REASON_LIMIT = 1024
const CODEX_APPROVAL_DIFF_LIMIT = 65_536
const CODEX_APPROVAL_ACTIONS_LIMIT = 16_384

export type CodexApprovalDecision = ApprovalDecision
export type CodexApprovalKind = ApprovalKind

const permissionPath = z.string().min(1).max(CODEX_APPROVAL_PATH_LIMIT).refine(isWellFormed)
const specialPath = z.union([
  z.strictObject({kind: z.enum(['root', 'minimal', 'tmpdir', 'slash_tmp'])}),
  z.strictObject({kind: z.literal('project_roots'), subpath: permissionPath.nullish()}),
  z.strictObject({kind: z.literal('unknown'), path: permissionPath, subpath: permissionPath.nullish()}),
])
const fileSystemPath = z.union([
  z.strictObject({type: z.literal('path'), path: permissionPath}),
  z.strictObject({type: z.literal('glob_pattern'), pattern: permissionPath}),
  z.strictObject({type: z.literal('special'), value: specialPath}),
])
const permissionProfileSchema = z.strictObject({
  fileSystem: z.strictObject({
    entries: z.array(z.strictObject({access: z.enum(['read', 'write', 'deny']), path: fileSystemPath})).max(64).nullish(),
    read: z.array(permissionPath).max(64).nullish(),
    write: z.array(permissionPath).max(64).nullish(),
    globScanMaxDepth: z.number().int().positive().nullish(),
  }).nullish(),
  network: z.strictObject({enabled: z.boolean().nullish()}).nullish(),
})
type PermissionProfile = z.infer<typeof permissionProfileSchema>
type PermissionFileSystemPath = NonNullable<NonNullable<PermissionProfile['fileSystem']>['entries']>[number]['path']
type PermissionSpecialPath = Extract<PermissionFileSystemPath, {type: 'special'}>['value']
const SESSION_DECISIONS = Object.freeze(['accept', 'acceptForSession', 'decline'] as const)

export type CodexFileChangeDisplay = FileChangeDisplay

export type CodexApprovalLocalDetail = ApprovalLocalDetail

export interface CodexApprovalOffer {
  readonly kind: CodexApprovalKind
  readonly local_detail: CodexApprovalLocalDetail
  readonly operation_summary: string
  readonly allowed_decisions?: readonly CodexApprovalDecision[]
}

export type CodexApprovalView = ApprovalView

export interface CodexApprovalResolution {
  readonly decision: CodexApprovalDecision
}

export function isCodexApprovalPort(value: unknown): value is CodexApprovalPort {
  return typeof value === 'object' && value !== null
    && typeof (value as CodexApprovalPort).offer === 'function'
    && typeof (value as CodexApprovalPort).consume === 'function'
    && typeof (value as CodexApprovalPort).invalidate === 'function'
}

export interface CodexApprovalServerRequestRouteOptions {
  readonly controller: CodexApprovalPort
  readonly workspace: string
  readonly activePair: readonly [string, string] | null
  readonly fileChangeItem: (
    itemId: string,
    startedAtMs: number,
  ) => Readonly<Record<string, unknown>> | null
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
}

export interface CodexApprovalServerResponse {
  readonly result: {readonly decision: CodexApprovalDecision}
    | {readonly permissions: PermissionProfile; readonly scope: 'turn' | 'session'}
}

/** Codex display validation and redaction adapt offers into the host-owned FIFO. */
export class CodexApprovalController extends HostApprovalController {
  override async offer(input: CodexApprovalOffer, signal: AbortSignal, work: ApprovalWork | null = null): Promise<CodexApprovalResolution | null> {
    if (!(signal instanceof AbortSignal) || signal.aborted) return Promise.resolve(null)
    return await super.offer(validateAndSnapshotOffer(input), signal, work)
  }
}

/** Route only the foreground approval methods currently supported by this transport; unknown methods remain transport-owned. */
export function routeCodexApprovalServerRequest(
  options: CodexApprovalServerRequestRouteOptions,
): Promise<CodexApprovalServerResponse> | undefined {
  if (
    options.method !== 'item/fileChange/requestApproval'
    && options.method !== 'item/commandExecution/requestApproval'
    && options.method !== 'item/permissions/requestApproval'
  ) return undefined
  return routeSupportedCodexApproval(options)
}

async function routeSupportedCodexApproval(
  options: CodexApprovalServerRequestRouteOptions,
): Promise<CodexApprovalServerResponse> {
  const isPermissions = options.method === 'item/permissions/requestApproval'
  let requested: PermissionProfile = {}
  const respond = (decision: CodexApprovalDecision): CodexApprovalServerResponse => isPermissions
    ? {result: {permissions: decision === 'decline' ? {} : requested, scope: decision === 'acceptForSession' ? 'session' : 'turn'}}
    : approvalResponse(decision)
  try {
    if (isPermissions) requested = permissionProfileSchema.parse(snapshotJsonRecord(options.params).permissions)
    const offer = options.method === 'item/fileChange/requestApproval'
      ? fileChangeOffer(options)
      : isPermissions ? permissionsOffer(options, requested) : commandExecutionOffer(options)
    if (offer === null || options.signal.aborted) return respond('decline')
    const resolution = await options.controller.offer(offer, options.signal)
    if (resolution === null) return respond('decline')
    return respond(options.controller.consume(resolution))
  } catch {
    return respond('decline')
  }
}

function fileChangeOffer(options: CodexApprovalServerRequestRouteOptions): CodexApprovalOffer | null {
  const workspace = canonicalWorkspace(options.workspace)
  const params = snapshotJsonRecord(options.params)
  if (!exactKeys(params, [
    'grantRoot', 'itemId', 'reason', 'startedAtMs', 'threadId', 'turnId',
  ])) return null
  const core = approvalCore(params, options.activePair)
  if (core === null || !nullableBoundedText(params.reason, CODEX_APPROVAL_REASON_LIMIT)) return null
  if (params.grantRoot !== undefined && params.grantRoot !== null) {
    if (typeof params.grantRoot !== 'string' || !isCanonicalWorkspace(params.grantRoot, workspace)) {
      return null
    }
  }
  let rawItem: Readonly<Record<string, unknown>> | null
  try { rawItem = options.fileChangeItem(core.itemId, core.startedAtMs) } catch { return null }
  if (rawItem === null) return null
  const item = snapshotJsonRecord(rawItem)
  if (
    !exactKeys(item, ['changes', 'id', 'status', 'type'])
    || item.id !== core.itemId
    || item.type !== 'fileChange'
    || item.status !== 'inProgress'
    || !Array.isArray(item.changes)
    || item.changes.length === 0
    || item.changes.length > CODEX_APPROVAL_CHANGE_LIMIT
  ) return null
  let totalDiff = 0
  const changes: CodexFileChangeDisplay[] = []
  for (const candidate of item.changes) {
    const change = snapshotJsonRecord(candidate)
    if (!exactKeys(change, ['diff', 'kind', 'path']) || typeof change.diff !== 'string') return null
    if (!isWellFormed(change.diff)) return null
    totalDiff += codePointLengthLikePython(change.diff)
    if (totalDiff > CODEX_APPROVAL_DIFF_LIMIT) return null
    const path = redactApprovalDetail(normalizedWorkspaceRelativePath(change.path, workspace))
    const kind = snapshotJsonRecord(change.kind)
    if (kind.type === 'add' || kind.type === 'delete') {
      if (!exactKeys(kind, ['type'])) return null
      changes.push(Object.freeze({change: kind.type, path, move_path: null}))
      continue
    }
    if (kind.type !== 'update' || !exactKeys(kind, ['move_path', 'type'])) return null
    const movePath = kind.move_path === undefined || kind.move_path === null
      ? null
      : redactApprovalDetail(normalizedWorkspaceRelativePath(kind.move_path, workspace))
    changes.push(Object.freeze({change: 'update', path, move_path: movePath}))
  }
  return Object.freeze({
    kind: 'file_change',
    local_detail: Object.freeze({kind: 'file_change', changes: Object.freeze(changes)}),
    operation_summary: 'Codex 请求修改工作区文件。',
    allowed_decisions: SESSION_DECISIONS,
  })
}

function commandExecutionOffer(
  options: CodexApprovalServerRequestRouteOptions,
): CodexApprovalOffer | null {
  const workspace = canonicalWorkspace(options.workspace)
  const params = snapshotJsonRecord(options.params)
  if (!exactKeys(params, [
    'approvalId', 'command', 'commandActions', 'cwd', 'environmentId', 'itemId', 'availableDecisions', 'additionalPermissions',
    'kind', 'networkApprovalContext', 'proposedExecpolicyAmendment',
    'proposedNetworkPolicyAmendments', 'reason', 'startedAtMs', 'threadId', 'turnId',
  ])) return null
  if (approvalCore(params, options.activePair) === null) return null
  if (
    !nullableBoundedText(params.approvalId, CODEX_APPROVAL_PROTOCOL_ID_LIMIT)
    || params.kind !== undefined && params.kind !== 'command'
    || params.environmentId !== undefined && params.environmentId !== null
    || !nullableBoundedText(params.reason, CODEX_APPROVAL_REASON_LIMIT)
    || typeof params.command !== 'string'
    || !isWellFormed(params.command)
    || stripLikePython(params.command) === ''
    || codePointLengthLikePython(params.command) > CODEX_APPROVAL_COMMAND_LIMIT
    || typeof params.cwd !== 'string'
    || !isCanonicalWorkspace(params.cwd, workspace)
  ) return null
  if (params.commandActions !== undefined && params.commandActions !== null) {
    if (!Array.isArray(params.commandActions)) return null
    if (JSON.stringify(params.commandActions).length > CODEX_APPROVAL_ACTIONS_LIMIT) return null
  }
  const network = z.strictObject({host: z.string().min(1).max(253), protocol: z.enum(['http', 'https', 'socks5Tcp', 'socks5Udp'])})
    .nullish().parse(params.networkApprovalContext)
  const amendments = z.array(z.strictObject({host: z.string().min(1).max(253), action: z.enum(['allow', 'deny'])}))
    .max(64).nullish().parse(params.proposedNetworkPolicyAmendments)
  z.array(z.string().max(4096)).max(64).nullish().parse(params.proposedExecpolicyAmendment)
  const extra = permissionProfileSchema.nullish().parse(params.additionalPermissions)
  const rawDecisions = params.availableDecisions
  if (rawDecisions != null && (!Array.isArray(rawDecisions) || rawDecisions.length > 16)) return null
  // Persistent rule amendments are intentionally never emitted, even when advertised by Codex.
  const allowed = rawDecisions == null ? ['accept', 'decline'] as const
    : SESSION_DECISIONS.filter(value => (rawDecisions as unknown[]).includes(value))
  if (!allowed.includes('decline')) return null
  const isNetwork = network != null || amendments != null
  const hosts = [...new Set([...(network ? [network.host] : []), ...(amendments ?? []).map(item => item.host)])]
  if (hosts.some(host => !/^[a-z\d.:\[\]-]+$/iu.test(host))) return null
  const networkScope = [
    ...(network ? [`网络：${network.host}（协议：${network.protocol}）`] : []),
    ...(amendments ?? [])
      .filter(item => network?.host !== item.host)
      .map(item => `网络：${item.host}（协议：未指定）`),
  ]
  const scope = [...networkScope, extra ? permissionSummary(extra, workspace) : ''].filter(Boolean).join('；')
  if (scope.length > 1024) return null
  return Object.freeze({
    kind: isNetwork ? 'network' : 'command_execution',
    local_detail: Object.freeze({
      kind: isNetwork ? 'network' : 'command_execution', command: redactApprovalDetail(params.command), cwd: workspace,
      ...(scope ? {scope} : {}),
    }),
    operation_summary: isNetwork ? 'Codex 请求访问网络。' : extra ? 'Codex 请求提升命令权限。' : 'Codex 请求执行一条工作区命令。',
    allowed_decisions: Object.freeze([...allowed]),
  })
}

function permissionsOffer(options: CodexApprovalServerRequestRouteOptions, requested: PermissionProfile): CodexApprovalOffer | null {
  const workspace = canonicalWorkspace(options.workspace)
  const params = snapshotJsonRecord(options.params)
  if (!exactKeys(params, ['cwd', 'environmentId', 'itemId', 'permissions', 'reason', 'startedAtMs', 'threadId', 'turnId'])
    || approvalCore(params, options.activePair) === null
    || params.environmentId != null
    || !nullableBoundedText(params.reason, CODEX_APPROVAL_REASON_LIMIT)
    || typeof params.cwd !== 'string' || !isCanonicalWorkspace(params.cwd, workspace)) return null
  return {
    kind: 'permissions', local_detail: {kind: 'permissions', scope: permissionSummary(requested, workspace)},
    operation_summary: 'Codex 请求提升文件或网络权限。', allowed_decisions: SESSION_DECISIONS,
  }
}

function permissionSummary(profile: PermissionProfile, workspace: string): string {
  const describePath = (path: string): string => {
    try { return redactApprovalDetail(normalizedWorkspaceRelativePath(path, workspace)) }
    catch { return '工作区外（路径已脱敏）' }
  }
  const describeSpecialPath = (path: PermissionSpecialPath): string => {
    if (path.kind === 'root') return '全文件系统（根目录）'
    if (path.kind === 'minimal') return '最小文件系统范围'
    if (path.kind === 'tmpdir' || path.kind === 'slash_tmp') return '临时目录'
    if (path.kind === 'project_roots') {
      return path.subpath === undefined || path.subpath === null
        ? '项目根目录'
        : `项目根目录/${redactApprovalDetail(path.subpath)}`
    }
    return '工作区外（路径已脱敏）'
  }
  const describePermissionPath = (path: PermissionFileSystemPath): string => {
    if (path.type === 'path') return describePath(path.path)
    if (path.type === 'glob_pattern') return `glob：${describeGlobPattern(path.pattern, workspace)}`
    return describeSpecialPath(path.value)
  }
  const fs = profile.fileSystem
  const entries = [
    ...(fs?.read ?? []).map(path => `read: ${describePath(path)}`),
    ...(fs?.write ?? []).map(path => `write: ${describePath(path)}`),
    ...(fs?.entries ?? []).map(entry => `${entry.access}: ${describePermissionPath(entry.path)}`),
  ]
  const summary = [...entries, `网络：${profile.network?.enabled === true ? '请求访问' : '未请求'}`].join('；')
  // Do not hide an unreviewed tail of a permission grant behind truncation.
  if (summary.length > 1024) throw new TypeError('permission summary too large')
  return summary
}

function describeGlobPattern(pattern: string, workspace: string): string {
  if (!isAbsolute(pattern)) return redactApprovalDetail(pattern)
  const displayed = relative(workspace, resolve(pattern))
  if (displayed === '' || displayed === '..' || displayed.startsWith(`..${sep}`) || isAbsolute(displayed)) {
    return '工作区外（路径已脱敏）'
  }
  return redactApprovalDetail(displayed)
}

function redactApprovalDetail(value: string): string {
  return value
    .replace(/((?:[a-z][a-z\d+.-]*):\/\/[^/\s:@]+:)[^/\s@]+(@)/giu, '$1[REDACTED]$2')
    .replace(/((?:proxy-)?authorization\s*:\s*basic\s+)[^\s"';&]+/giu, '$1[REDACTED]')
    .replace(/((?:^|[\s;&])(?:-u|--user|--username)\s+)(?:"[^"]*"|'[^']*'|[^\s;&]+)/giu, '$1[REDACTED]')
    .replace(/((?:^|[\s;&?#,{\\/])["']?(?:--?|\/)?(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:token|password|passwd|pwd|api[_-]?key|access[_-]?key(?:[_-]?(?:id|secret))?|secret(?:[_-]?key)?|client[_-]?secret|private[_-]?key|authorization|auth|credential(?:s)?)\b["']?\s*(?:=|:)\s*)(?!(?:basic|bearer)\s+)(?:"[^"]*"|'[^']*'|[^\s;&]+)/giu, '$1[REDACTED]')
    .replace(/((?:^|[\s;&])(?:--?|\/)?(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:token|password|passwd|pwd|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|authorization)\b\s+)(?!(?:basic|bearer)\s+)(?:"[^"]*"|'[^']*'|[^\s;&]+)/giu, '$1[REDACTED]')
    .replace(/(?:bearer\s+\S+|(?:sk|rk|pk)-[A-Za-z0-9_./+=-]{8,})/giu, '[REDACTED]')
}

function approvalCore(
  params: Readonly<Record<string, unknown>>,
  activePair: readonly [string, string] | null,
): {readonly itemId: string; readonly startedAtMs: number} | null {
  if (
    activePair === null
    || !boundedProtocolId(params.threadId)
    || !boundedProtocolId(params.turnId)
    || !boundedProtocolId(params.itemId)
    || params.threadId !== activePair[0]
    || params.turnId !== activePair[1]
    || typeof params.startedAtMs !== 'number'
    || !Number.isSafeInteger(params.startedAtMs)
    || params.startedAtMs < 0
  ) return null
  return Object.freeze({itemId: params.itemId, startedAtMs: params.startedAtMs})
}

function boundedProtocolId(value: unknown): value is string {
  return typeof value === 'string'
    && isWellFormed(value)
    && value !== ''
    && codePointLengthLikePython(value) <= CODEX_APPROVAL_PROTOCOL_ID_LIMIT
}

function nullableBoundedText(value: unknown, limit: number): boolean {
  return value === undefined || value === null || (
    typeof value === 'string'
    && isWellFormed(value)
    && codePointLengthLikePython(value) <= limit
  )
}

function canonicalWorkspace(value: string): string {
  if (typeof value !== 'string' || !isWellFormed(value) || !isAbsolute(value)) {
    throw new TypeError('invalid workspace')
  }
  const canonical = realpathSync(value)
  if (resolve(value) !== canonical) throw new TypeError('non-canonical workspace')
  return canonical
}

function isCanonicalWorkspace(value: string, workspace: string): boolean {
  try {
    return isWellFormed(value)
      && isAbsolute(value)
      && resolve(value) === workspace
      && realpathSync(value) === workspace
  } catch {
    return false
  }
}

function normalizedWorkspaceRelativePath(value: unknown, workspace: string): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || value === ''
    || codePointLengthLikePython(value) > CODEX_APPROVAL_PATH_LIMIT
  ) throw new TypeError('invalid path')
  const absolute = isAbsolute(value) ? resolve(value) : resolve(workspace, value)
  const displayed = relative(workspace, absolute)
  if (displayed === '' || displayed === '..' || displayed.startsWith(`..${sep}`)
    || isAbsolute(displayed)) throw new TypeError('path outside workspace')
  let componentPath = workspace
  for (const component of displayed.split(sep)) {
    componentPath = resolve(componentPath, component)
    let isReparsePoint: boolean
    try { isReparsePoint = lstatSync(componentPath).isSymbolicLink() }
    catch (error) {
      if (isNodeError(error, 'ENOENT')) return displayed
      throw new TypeError('unreadable workspace path')
    }
    let canonicalComponent: string
    try { canonicalComponent = realpathSync(componentPath) }
    catch { throw new TypeError('unresolvable workspace path') }
    const fromWorkspace = relative(workspace, canonicalComponent)
    if (fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`)
      || isAbsolute(fromWorkspace)) {
      throw new TypeError(isReparsePoint ? 'linked path outside workspace' : 'path outside workspace')
    }
  }
  return displayed
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed)
  return Object.keys(value).every(key => accepted.has(key))
}

function approvalResponse(decision: CodexApprovalDecision): CodexApprovalServerResponse {
  return Object.freeze({result: Object.freeze({decision})})
}

function validateAndSnapshotOffer(input: CodexApprovalOffer): CodexApprovalOffer {
  const summary = boundedText(input.operation_summary, CODEX_APPROVAL_SUMMARY_LIMIT)
  const allowed = input.allowed_decisions
  if (allowed !== undefined && (allowed.length > 3 || allowed.length === 0
    || allowed.some(value => !SESSION_DECISIONS.includes(value)) || !allowed.includes('decline'))) throw new TypeError('invalid approval decisions')
  const decisions = allowed === undefined ? {} : {allowed_decisions: Object.freeze([...new Set(allowed)])}
  if (input.kind === 'permissions' && input.local_detail.kind === 'permissions') {
    return Object.freeze({kind: input.kind, local_detail: Object.freeze({kind: input.kind, scope: boundedText(input.local_detail.scope, 1024)}), operation_summary: summary, ...decisions})
  }
  if ((input.kind === 'command_execution' || input.kind === 'network') && input.local_detail.kind === input.kind) {
    return Object.freeze({
      kind: input.kind,
      local_detail: Object.freeze({
        kind: input.local_detail.kind,
        command: boundedText(input.local_detail.command, CODEX_APPROVAL_COMMAND_LIMIT, false),
        cwd: boundedText(input.local_detail.cwd, CODEX_APPROVAL_PATH_LIMIT, false),
        ...(input.local_detail.scope === undefined ? {} : {scope: boundedText(input.local_detail.scope, 1024)}),
      }),
      operation_summary: summary,
      ...decisions,
    })
  }
  const rawChanges: unknown = input.local_detail.kind === 'file_change'
    ? input.local_detail.changes
    : null
  if (
    input.kind !== 'file_change'
    || input.local_detail.kind !== 'file_change'
    || !Array.isArray(rawChanges)
    || rawChanges.length === 0
    || rawChanges.length > CODEX_APPROVAL_CHANGE_LIMIT
  ) throw new TypeError('invalid Codex approval offer')
  const changes = rawChanges.map((candidate: unknown) => {
    const change = snapshotJsonRecord(candidate)
    if (
      !exactKeys(change, ['change', 'move_path', 'path'])
      || change.change !== 'add' && change.change !== 'delete' && change.change !== 'update'
      || typeof change.path !== 'string'
      || change.move_path !== null && typeof change.move_path !== 'string'
    ) {
      throw new TypeError('invalid Codex approval offer')
    }
    return Object.freeze({
      change: change.change,
      path: redactApprovalDetail(boundedText(change.path, CODEX_APPROVAL_PATH_LIMIT, false)),
      move_path: change.move_path === null
        ? null
        : redactApprovalDetail(boundedText(change.move_path, CODEX_APPROVAL_PATH_LIMIT, false)),
    })
  })
  return Object.freeze({
    kind: input.kind,
    local_detail: Object.freeze({kind: input.local_detail.kind, changes: Object.freeze(changes)}),
    operation_summary: summary,
    ...decisions,
  })
}

function boundedText(value: string, limit: number, strip = true): string {
  if (typeof value !== 'string' || !isWellFormed(value)) {
    throw new TypeError('invalid Codex approval offer')
  }
  const bounded = strip ? stripLikePython(value) : value
  if (
    stripLikePython(bounded) === ''
    || codePointLengthLikePython(bounded) > limit
  ) throw new TypeError('invalid Codex approval offer')
  return bounded
}
