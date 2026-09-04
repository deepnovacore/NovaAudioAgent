import {lstatSync, realpathSync} from 'node:fs'
import {isAbsolute, relative, resolve, sep} from 'node:path'
import {z} from 'zod'

import type {Clock} from '../../clock.js'
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
import {MAX_CONCURRENT_WORK} from '../../work-tools.js'

export const CODEX_APPROVAL_TTL_SECONDS = APPROVAL_TTL_SECONDS
const CODEX_APPROVAL_ID_LIMIT = 128
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

interface PendingApproval {
  readonly id: string
  readonly offer: CodexApprovalOffer
  readonly work: ApprovalWork | null
  /** Armed when the entry becomes head (spec 08): queue position has no deadline of its own. */
  expiresAt: number
  readonly signal: AbortSignal
  readonly resolve: (resolution: CodexApprovalResolution) => void
  /** Replaced by `release`, which re-arms the head with a fresh deadline. */
  expiryAbort: AbortController
  /** Parked by `hold` behind a project confirmation: the deadline is stale and must not drop the entry. */
  held: boolean
  onSignalAbort: (() => void) | null
  state: 'pending' | 'responding'
  resolution: CodexApprovalResolution | null
}

export interface CodexApprovalControllerOptions {
  readonly clock: Clock
  readonly idFactory: () => string
}

/** What a transport needs from the approval FIFO; `forWork` binds it to one running work. */
export type CodexApprovalPort = Pick<CodexApprovalController, 'offer' | 'consume' | 'invalidate'>

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

/**
 * Owns the Codex permission FIFO (spec 08): exactly one approval is voice-visible (the head); later
 * offers queue with their server request still open and get a full TTL once they become head.
 */
export class CodexApprovalController {
  readonly #clock: Clock
  readonly #idFactory: () => string
  readonly #observers: ((view: CodexApprovalView) => void)[] = []
  #current: PendingApproval | null = null
  readonly #queue: PendingApproval[] = []

  constructor(options: CodexApprovalControllerOptions) {
    this.#clock = options.clock
    this.#idFactory = options.idFactory
  }

  get view(): CodexApprovalView {
    const current = this.#current
    if (current === null) return emptyView()
    return {
      pending_approval: true,
      pending_approval_busy: current.state === 'responding',
      pending_approval_id: current.id,
      kind: current.offer.kind,
      local_detail: current.offer.local_detail,
      operation_summary: current.offer.operation_summary,
      expires_at: current.expiresAt,
      ...(current.offer.allowed_decisions === undefined ? {} : {allowed_decisions: current.offer.allowed_decisions}),
      work: current.work,
      queued: this.#queue.length,
      ...(current.held ? {held: true} : {}),
    }
  }

  /** The same surface bound to one running work: its offers carry `work`, its invalidations touch only its own entries. */
  forWork(work: ApprovalWork): CodexApprovalPort {
    return {
      offer: (input, signal) => this.offer(input, signal, work),
      consume: resolution => this.consume(resolution),
      invalidate: reason => this.invalidateWork(work.work_id, reason),
    }
  }

  get pending(): boolean {
    return this.#current?.state === 'pending' && (this.#current.held || this.#clock.now() < this.#current.expiresAt)
  }

  /** Park the head (spec 08: it waits behind a project confirmation). The timer stops; a renderer click still decides. */
  hold(): boolean {
    const current = this.#current
    if (current?.state !== 'pending' || current.held) return false
    current.held = true
    current.expiryAbort.abort()
    this.#publish()
    return true
  }

  /** Un-park the head with a fresh full TTL, exactly as if it had just been promoted. */
  release(): boolean {
    const current = this.#current
    if (current?.state !== 'pending' || !current.held) return false
    current.held = false
    current.expiryAbort = new AbortController()
    this.#arm(current)
    this.#publish()
    return true
  }

  observe(observer: (view: CodexApprovalView) => void): () => void {
    this.#observers.push(observer)
    return (): void => {
      const index = this.#observers.indexOf(observer)
      if (index !== -1) this.#observers.splice(index, 1)
    }
  }

  /** Offer only host-sanitized display facts. A concurrent offer queues behind the head. */
  async offer(
    input: CodexApprovalOffer,
    signal: AbortSignal,
    work: ApprovalWork | null = null,
  ): Promise<CodexApprovalResolution | null> {
    if (!(signal instanceof AbortSignal) || signal.aborted) return null
    const offer = validateAndSnapshotOffer(input)
    // ponytail: the FIFO holds at most MAX_CONCURRENT_WORK entries and one per work. A Codex turn blocks
    // on its pending approval, so a second request from the same work is a protocol anomaly, and there
    // are never more asking works than run slots. An over-cap offer is declined at once (the shape the
    // transport already handles) and publishes nothing; a per-work sub-queue is the upgrade path if a
    // transport ever legitimately pipelines approvals.
    const pending = this.#current === null ? this.#queue : [this.#current, ...this.#queue]
    if (
      pending.length >= MAX_CONCURRENT_WORK
      || (work !== null && pending.some(entry => entry.work?.work_id === work.work_id))
    ) return Object.freeze({decision: 'decline'})
    const id = validateApprovalId(this.#idFactory())
    let resolve!: (resolution: CodexApprovalResolution) => void
    const decision = new Promise<CodexApprovalResolution>(done => { resolve = done })
    const entry: PendingApproval = {
      id,
      offer,
      work,
      expiresAt: 0,
      signal,
      resolve,
      expiryAbort: new AbortController(),
      held: false,
      onSignalAbort: null,
      state: 'pending',
      resolution: null,
    }
    entry.onSignalAbort = () => { this.#drop(entry) }
    signal.addEventListener('abort', entry.onSignalAbort, {once: true})
    if (this.#current === null) this.#promote(entry)
    else this.#queue.push(entry)
    this.#publish()
    return await decision
  }

  /** Accept exactly one structured decision for the current Nova-generated public ID. */
  acceptDecision(input: {
    readonly approvalId: string
    readonly decision: CodexApprovalDecision
  }): boolean {
    const current = this.#current
    if (
      current?.state !== 'pending'
      || typeof input.approvalId !== 'string'
      || input.approvalId !== current.id
      || !(current.offer.allowed_decisions ?? ['accept', 'decline']).includes(input.decision)
    ) return false
    if ((!current.held && this.#clock.now() >= current.expiresAt) || current.signal.aborted) {
      this.#drop(current)
      return false
    }
    const resolution = Object.freeze({decision: input.decision})
    current.state = 'responding'
    current.resolution = resolution
    current.expiryAbort.abort()
    current.resolve(resolution)
    this.#publish()
    return true
  }

  /** Spend a returned resolution once; stale or invalidated resolutions become decline. */
  consume(resolution: CodexApprovalResolution): CodexApprovalDecision {
    const current = this.#current
    if (
      current?.state !== 'responding'
      || current.resolution !== resolution
      || current.signal.aborted
    ) return 'decline'
    const decision = resolution.decision
    this.#detach(current)
    this.#current = null
    this.#promoteNext()
    this.#publish()
    return decision
  }

  /** Drop the head (expiry, epoch change, carrier loss); the next queued entry becomes visible. */
  invalidate(reason: string): boolean {
    void reason
    const current = this.#current
    if (current === null) return false
    this.#drop(current)
    return true
  }

  /** Drop every entry of one work (its turn ended or its transport closed) without touching other works. */
  invalidateWork(workId: string, reason: string): boolean {
    void reason
    const owned = [this.#current, ...this.#queue].filter(
      (entry): entry is PendingApproval => entry?.work?.work_id === workId,
    )
    for (const entry of owned) this.#drop(entry)
    return owned.length > 0
  }

  async #expireAtDeadline(current: PendingApproval): Promise<void> {
    try {
      await this.#clock.sleep(
        Math.max(0, current.expiresAt - this.#clock.now()),
        current.expiryAbort.signal,
      )
    } catch {
      return
    }
    if (this.#current !== current || current.held || this.#clock.now() < current.expiresAt) return
    this.#drop(current)
  }

  #promote(entry: PendingApproval): void {
    this.#current = entry
    this.#arm(entry)
  }

  #arm(entry: PendingApproval): void {
    entry.expiresAt = this.#clock.now() + CODEX_APPROVAL_TTL_SECONDS
    void this.#expireAtDeadline(entry)
  }

  #promoteNext(): void {
    const next = this.#queue.shift()
    if (next !== undefined) this.#promote(next)
  }

  /** Remove one entry wherever it sits, declining it if still undecided; a dropped head promotes the next. */
  #drop(entry: PendingApproval): void {
    if (this.#current === entry) {
      this.#current = null
      this.#promoteNext()
    } else {
      const index = this.#queue.indexOf(entry)
      if (index === -1) return
      this.#queue.splice(index, 1)
    }
    this.#detach(entry)
    if (entry.state === 'pending') entry.resolve(Object.freeze({decision: 'decline' as const}))
    this.#publish()
  }

  #detach(entry: PendingApproval): void {
    entry.expiryAbort.abort()
    if (entry.onSignalAbort !== null) {
      entry.signal.removeEventListener('abort', entry.onSignalAbort)
      entry.onSignalAbort = null
    }
  }

  #publish(): void {
    const view = this.view
    for (const observer of [...this.#observers]) {
      try { observer(view) } catch { /* observers never own approval state */ }
    }
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

function emptyView(): CodexApprovalView {
  return {
    pending_approval: false,
    pending_approval_busy: false,
    kind: null,
    local_detail: null,
    operation_summary: null,
    expires_at: null,
    work: null,
    queued: 0,
  }
}

function validateApprovalId(value: string): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || value === ''
    || codePointLengthLikePython(value) > CODEX_APPROVAL_ID_LIMIT
  ) throw new TypeError('invalid Codex approval id')
  return value
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
