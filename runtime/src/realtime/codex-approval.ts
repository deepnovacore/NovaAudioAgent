import {lstatSync, realpathSync} from 'node:fs'
import {isAbsolute, relative, resolve, sep} from 'node:path'

import type {Clock} from '../clock.js'
import {snapshotJsonRecord} from '../codex-safe-json.js'
import {codePointLengthLikePython, isWellFormed, stripLikePython} from '../python-text.js'

export const CODEX_APPROVAL_TTL_SECONDS = 60
const CODEX_APPROVAL_ID_LIMIT = 128
const CODEX_APPROVAL_COMMAND_LIMIT = 4096
const CODEX_APPROVAL_PATH_LIMIT = 4096
const CODEX_APPROVAL_CHANGE_LIMIT = 64
const CODEX_APPROVAL_SUMMARY_LIMIT = 256
const CODEX_APPROVAL_PROTOCOL_ID_LIMIT = 256
const CODEX_APPROVAL_REASON_LIMIT = 1024
const CODEX_APPROVAL_DIFF_LIMIT = 65_536
const CODEX_APPROVAL_ACTIONS_LIMIT = 16_384

export type CodexApprovalDecision = 'accept' | 'decline'
export type CodexApprovalKind = 'file_change' | 'command_execution'

export interface CodexFileChangeDisplay {
  readonly change: 'add' | 'delete' | 'update'
  readonly path: string
  readonly move_path: string | null
}

export type CodexApprovalLocalDetail =
  | {
    readonly kind: 'file_change'
    readonly changes: readonly CodexFileChangeDisplay[]
  }
  | {
    readonly kind: 'command_execution'
    readonly command: string
    readonly cwd: string
  }

export interface CodexApprovalOffer {
  readonly kind: CodexApprovalKind
  readonly local_detail: CodexApprovalLocalDetail
  readonly operation_summary: string
}

export interface CodexApprovalView {
  readonly pending_approval: boolean
  readonly pending_approval_busy: boolean
  readonly pending_approval_id?: string
  readonly kind: CodexApprovalKind | null
  readonly local_detail: CodexApprovalLocalDetail | null
  readonly operation_summary: string | null
  readonly expires_at: number | null
}

export interface CodexApprovalResolution {
  readonly decision: CodexApprovalDecision
}

interface PendingApproval {
  readonly id: string
  readonly offer: CodexApprovalOffer
  readonly expiresAt: number
  readonly signal: AbortSignal
  readonly resolve: (resolution: CodexApprovalResolution) => void
  readonly expiryAbort: AbortController
  onSignalAbort: (() => void) | null
  state: 'pending' | 'responding'
  resolution: CodexApprovalResolution | null
}

export interface CodexApprovalControllerOptions {
  readonly clock: Clock
  readonly idFactory: () => string
}

export interface CodexApprovalServerRequestRouteOptions {
  readonly controller: CodexApprovalController
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
}

/** Owns one short-lived, request-bound Codex permission decision. */
export class CodexApprovalController {
  readonly #clock: Clock
  readonly #idFactory: () => string
  readonly #observers: ((view: CodexApprovalView) => void)[] = []
  #current: PendingApproval | null = null

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
    }
  }

  get pending(): boolean {
    return this.#current?.state === 'pending' && this.#clock.now() < this.#current.expiresAt
  }

  observe(observer: (view: CodexApprovalView) => void): () => void {
    this.#observers.push(observer)
    return (): void => {
      const index = this.#observers.indexOf(observer)
      if (index !== -1) this.#observers.splice(index, 1)
    }
  }

  /** Offer only host-sanitized display facts. A second concurrent offer is declined by the caller. */
  async offer(
    input: CodexApprovalOffer,
    signal: AbortSignal,
  ): Promise<CodexApprovalResolution | null> {
    if (!(signal instanceof AbortSignal) || signal.aborted || this.#current !== null) return null
    const offer = validateAndSnapshotOffer(input)
    const id = validateApprovalId(this.#idFactory())
    let resolve!: (resolution: CodexApprovalResolution) => void
    const decision = new Promise<CodexApprovalResolution>(done => { resolve = done })
    const current: PendingApproval = {
      id,
      offer,
      expiresAt: this.#clock.now() + CODEX_APPROVAL_TTL_SECONDS,
      signal,
      resolve,
      expiryAbort: new AbortController(),
      onSignalAbort: null,
      state: 'pending',
      resolution: null,
    }
    current.onSignalAbort = () => { this.#invalidateCurrent(current) }
    signal.addEventListener('abort', current.onSignalAbort, {once: true})
    this.#current = current
    this.#publish()
    void this.#expireAtDeadline(current)
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
      || (input.decision !== 'accept' && input.decision !== 'decline')
    ) return false
    if (this.#clock.now() >= current.expiresAt || current.signal.aborted) {
      this.#invalidateCurrent(current)
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
    this.#clearCurrent(current)
    this.#publish()
    return decision
  }

  invalidate(reason: string): boolean {
    void reason
    const current = this.#current
    if (current === null) return false
    this.#invalidateCurrent(current)
    return true
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
    if (this.#current !== current || this.#clock.now() < current.expiresAt) return
    this.#invalidateCurrent(current)
  }

  #invalidateCurrent(current: PendingApproval): void {
    if (this.#current !== current) return
    const decline = Object.freeze({decision: 'decline' as const})
    this.#clearCurrent(current)
    if (current.state === 'pending') current.resolve(decline)
    this.#publish()
  }

  #clearCurrent(current: PendingApproval): void {
    if (this.#current !== current) return
    this.#current = null
    current.expiryAbort.abort()
    if (current.onSignalAbort !== null) {
      current.signal.removeEventListener('abort', current.onSignalAbort)
      current.onSignalAbort = null
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
  ) return undefined
  return routeSupportedCodexApproval(options)
}

async function routeSupportedCodexApproval(
  options: CodexApprovalServerRequestRouteOptions,
): Promise<CodexApprovalServerResponse> {
  try {
    const offer = options.method === 'item/fileChange/requestApproval'
      ? fileChangeOffer(options)
      : commandExecutionOffer(options)
    if (offer === null || options.signal.aborted) return approvalResponse('decline')
    const resolution = await options.controller.offer(offer, options.signal)
    if (resolution === null) return approvalResponse('decline')
    return approvalResponse(options.controller.consume(resolution))
  } catch {
    return approvalResponse('decline')
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
    const path = normalizedWorkspaceRelativePath(change.path, workspace)
    const kind = snapshotJsonRecord(change.kind)
    if (kind.type === 'add' || kind.type === 'delete') {
      if (!exactKeys(kind, ['type'])) return null
      changes.push(Object.freeze({change: kind.type, path, move_path: null}))
      continue
    }
    if (kind.type !== 'update' || !exactKeys(kind, ['move_path', 'type'])) return null
    const movePath = kind.move_path === undefined || kind.move_path === null
      ? null
      : normalizedWorkspaceRelativePath(kind.move_path, workspace)
    changes.push(Object.freeze({change: 'update', path, move_path: movePath}))
  }
  return Object.freeze({
    kind: 'file_change',
    local_detail: Object.freeze({kind: 'file_change', changes: Object.freeze(changes)}),
    operation_summary: 'Codex 请求修改工作区文件。',
  })
}

function commandExecutionOffer(
  options: CodexApprovalServerRequestRouteOptions,
): CodexApprovalOffer | null {
  const workspace = canonicalWorkspace(options.workspace)
  const params = snapshotJsonRecord(options.params)
  if (!exactKeys(params, [
    'approvalId', 'command', 'commandActions', 'cwd', 'environmentId', 'itemId',
    'kind', 'networkApprovalContext', 'proposedExecpolicyAmendment',
    'proposedNetworkPolicyAmendments', 'reason', 'startedAtMs', 'threadId', 'turnId',
  ])) return null
  if (approvalCore(params, options.activePair) === null) return null
  if (
    params.approvalId !== undefined && params.approvalId !== null
    || params.kind !== undefined && params.kind !== 'command'
    || params.environmentId !== undefined && params.environmentId !== null
    || params.networkApprovalContext !== undefined && params.networkApprovalContext !== null
    || params.proposedExecpolicyAmendment !== undefined
      && params.proposedExecpolicyAmendment !== null
    || params.proposedNetworkPolicyAmendments !== undefined
      && params.proposedNetworkPolicyAmendments !== null
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
  return Object.freeze({
    kind: 'command_execution',
    local_detail: Object.freeze({
      kind: 'command_execution', command: params.command, cwd: workspace,
    }),
    operation_summary: 'Codex 请求执行一条工作区命令。',
  })
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
  if (input.kind === 'command_execution' && input.local_detail.kind === 'command_execution') {
    return Object.freeze({
      kind: input.kind,
      local_detail: Object.freeze({
        kind: input.local_detail.kind,
        command: boundedText(input.local_detail.command, CODEX_APPROVAL_COMMAND_LIMIT, false),
        cwd: boundedText(input.local_detail.cwd, CODEX_APPROVAL_PATH_LIMIT, false),
      }),
      operation_summary: summary,
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
      path: boundedText(change.path, CODEX_APPROVAL_PATH_LIMIT, false),
      move_path: change.move_path === null
        ? null
        : boundedText(change.move_path, CODEX_APPROVAL_PATH_LIMIT, false),
    })
  })
  return Object.freeze({
    kind: input.kind,
    local_detail: Object.freeze({kind: input.local_detail.kind, changes: Object.freeze(changes)}),
    operation_summary: summary,
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
