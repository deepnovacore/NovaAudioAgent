import {basename, isAbsolute} from 'node:path'
import {z} from 'zod'
import {CODING_BACKEND_IDS, type CodingBackendId} from '../config/coding-backends.js'
import {compareCodePoints, type CanonicalJsonPath} from '../text/canonical-json.js'
import {pythonFloat} from '../text/python-number.js'
import {isPythonSpace, isWellFormed, stripLikePython} from '../text/python-text.js'
import {casefoldLikePython} from '../text/unicode-casefold.js'
import {normalizeNfkcPinned} from '../text/unicode-normalize.js'
import {isLetterCategory, isNumberCategory, isOtherCategory} from '../text/unicode-tables.js'
import {type HostWorkspace} from './host-paths.js'
import {type ProjectFileIdentity} from './project-root-file.js'

export const PROJECT_STATE_VERSION = 2
export const MAX_PROJECT_WORKSPACES = 100
export const MAX_PROJECT_SESSIONS_PER_WORKSPACE = 200
export const MAX_PROJECT_SESSIONS_TOTAL = 1000
export const MAX_PROJECT_WORKSPACE_NAME = 80
export const MAX_PROJECT_SESSION_TITLE = 120
const MAX_PUBLIC_ROSTER = 20
const MAX_PROJECT_THREAD_ID = 256
export const STORED_ID = /^[A-Za-z0-9_-]{8,80}$/u
export const MAINTENANCE_TOMBSTONE = /^\.nova-maintenance-([A-Za-z0-9_-]{8,80})-([0-9]{1,3})$/u
const MAINTENANCE_REPLACEMENT = /^\.nova-replacement-([A-Za-z0-9_-]{8,80})-([0-9]{1,3})$/u

export type ProjectStateCode =
  | 'workspace_name_invalid'
  | 'session_title_invalid'
  | 'state_lock_failed'
  | 'state_busy'
  | 'state_permissions'
  | 'state_corrupt'
  | 'state_too_large'
  | 'state_version_unsupported'
  | 'state_write_failed'
  | 'context_delivery_failed'
  | 'managed_root_unsafe'
  | 'workspace_invalid'
  | 'workspace_not_found'
  | 'workspace_name_conflict'
  | 'workspace_path_conflict'
  | 'workspace_limit'
  | 'workspace_create_failed'
  | 'workspace_boundary_changed'
  | 'session_not_found'
  | 'session_unavailable'
  | 'session_workspace_mismatch'
  | 'session_state_conflict'
  | 'session_limit'
  | 'thread_id_invalid'
  | 'id_factory_invalid'
  | 'clock_invalid'

export class ProjectStateError extends Error {
  constructor(readonly code: ProjectStateCode) {
    super(code)
    this.name = 'ProjectStateError'
  }
}

export interface NormalizedProjectText {
  readonly display: string
  readonly normalized: string
}

export interface WorkspaceRecord {
  readonly workspace_id: string
  readonly display_name: string
  readonly normalized_name: string
  readonly canonical_path: string
  readonly origin: 'managed' | 'registered'
  readonly codex_home_key: string
  readonly active_session_id: string | null
  readonly created_at: number
  readonly last_used_at: number
}

export interface SessionBackendBinding {
  readonly backend_id: CodingBackendId
  readonly backend_profile_id: string
  readonly backend_session_id: string | null
}

export interface ProjectSessionRecord extends SessionBackendBinding {
  /** Persisted independently of workspace cwd; older explicit-home records are external. */
  readonly executor_home?: string
  readonly origin?: 'nova' | 'external'

  readonly session_id: string
  readonly workspace_id: string
  readonly display_title: string
  readonly normalized_title: string
  readonly codex_thread_id: string | null
  readonly state: 'starting' | 'ready' | 'unavailable'
  readonly created_at: number
  readonly last_used_at: number
}

export interface SessionStartRollback {
  readonly activationRevision: number
  readonly previousActiveWorkspaceId: string | null
  readonly workspaceId: string
  readonly previousActiveSessionId: string | null
  readonly startedSessionId: string
}

export interface BegunSession {
  readonly session: ProjectSessionRecord
  readonly rollback: SessionStartRollback
}

export interface ProjectSnapshot {
  readonly version: 2
  readonly state_revision: number
  readonly active_binding_revision: number
  readonly active_workspace_id: string | null
  readonly workspaces: readonly WorkspaceRecord[]
  readonly sessions: readonly ProjectSessionRecord[]
}

export interface ProjectMaintenanceTargetSnapshot {
  readonly workspace: WorkspaceRecord
  readonly identity: ProjectFileIdentity
}

export interface ProjectMaintenanceSnapshot {
  readonly state_revision: number
  readonly active_workspace_id: string | null
  readonly managed_targets: readonly ProjectMaintenanceTargetSnapshot[]
}

export interface ExternalManagedWorkspaceReconciliation {
  readonly status: 'unchanged' | 'reconciled'
  readonly recreated_count: number
  readonly active_workspace_reset: boolean
}

export interface ManagedMaintenanceJournalEntry {
  readonly workspace_id: string
  readonly original_name: string
  readonly tombstone_name: string
  readonly replacement_name: string
  readonly identity: ProjectFileIdentity
  readonly replacement_identity: ProjectFileIdentity | null
}

export interface ManagedMaintenanceJournal {
  readonly version: 1 | 2
  readonly operation_id: string
  readonly phase: 'prepared' | 'committed'
  readonly entries: readonly ManagedMaintenanceJournalEntry[]
}

export interface ManagedReplacementInput {
  readonly expected_state_revision: number
  readonly targets: readonly {
    readonly workspace_id: string
    readonly canonical_path: string
    readonly identity: ProjectFileIdentity
    readonly tombstone_name: string
  }[]
}

/** Desktop-only roster row (spec 08): the voice model never reads this. */
export interface PublicRosterEntry {
  readonly name: string
  readonly last_used_at: number
  readonly running: readonly {readonly work_id: string; readonly title: string; readonly backend_id?: CodingBackendId}[]
}

export interface PublicProjectView {
  readonly available_sessions?: readonly {readonly project: string; readonly titles: readonly string[]}[]
  readonly workspace_display_name: string | null
  readonly session_title: string | null
  /** Known projects, most recently used first, with their running works; UI only. */
  readonly roster: readonly PublicRosterEntry[]
  readonly pending_confirmation: boolean
  readonly pending_confirmation_busy: boolean
  readonly pending_confirmation_id?: string
  /** Optional at the internal boundary so legacy store-only callers remain source compatible. */
  readonly pending_action?: 'create_workspace' | 'reuse_workspace' | 'select_workspace' | 'resume_session' | null
  readonly pending_workspace_display_name?: string | null
  readonly pending_session_title?: string | null
  readonly pending_expires_in_seconds?: number | null
}

export interface PublicProjectContext {
  readonly workspace_id: string | null
  readonly view: PublicProjectView
}

export interface SessionResumeRollback {
  readonly activationRevision: number
  readonly previousActiveWorkspaceId: string | null
  readonly workspaceId: string
  readonly previousActiveSessionId: string | null
  readonly resumedSessionId: string
}

export interface PreparedSessionResume {
  readonly workspace: HostWorkspace
  readonly rollback: SessionResumeRollback
}

export interface MutableProjectState {
  stateRevision: number
  activeBindingRevision: number
  activeWorkspaceId: string | null
  workspaces: Map<string, WorkspaceRecord>
  sessions: Map<string, ProjectSessionRecord>
}

export function requireProjectBasename(name: string, code: ProjectStateCode): void {
  if (
    typeof name !== 'string'
    || name === ''
    || !isWellFormed(name)
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
    || name.includes('://')
    || /^[A-Za-z]:/u.test(name)
    || basename(name) !== name
  ) throw new ProjectStateError(code)
}

export function normalizeProjectWorkspaceName(value: unknown): NormalizedProjectText {
  const result = normalizePublicText(value, MAX_PROJECT_WORKSPACE_NAME, 'workspace_name_invalid')
  if (
    result.display.includes('/')
    || result.display.includes('\\')
    || result.display.includes('://')
    || /^[A-Za-z]:/u.test(result.display)
    || result.display === '.'
    || result.display === '..'
  ) throw new ProjectStateError('workspace_name_invalid')
  return result
}

export function normalizeProjectSessionTitle(value: unknown): NormalizedProjectText {
  return normalizePublicText(value, MAX_PROJECT_SESSION_TITLE, 'session_title_invalid')
}

function normalizePublicText(
  value: unknown,
  limit: number,
  code: 'workspace_name_invalid' | 'session_title_invalid',
): NormalizedProjectText {
  if (typeof value !== 'string' || !isWellFormed(value)) throw new ProjectStateError(code)
  const stripped = stripLikePython(normalizeNfkcPinned(value))
  const pieces: string[] = []
  let current = ''
  for (const character of stripped) {
    if (isPythonSpace(character)) {
      if (current !== '') {
        pieces.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current !== '') pieces.push(current)
  const display = pieces.join(' ')
  if (
    display === ''
    || [...display].length > limit
    || [...display].some(character => {
      const codePoint = character.codePointAt(0)
      return codePoint === undefined || isOtherCategory(codePoint)
    })
  ) throw new ProjectStateError(code)
  return Object.freeze({display, normalized: casefoldLikePython(display)})
}

export function emptyState(): MutableProjectState {
  return {
    stateRevision: 0,
    activeBindingRevision: 0,
    activeWorkspaceId: null,
    workspaces: new Map(),
    sessions: new Map(),
  }
}

export function snapshotState(state: MutableProjectState): ProjectSnapshot {
  return Object.freeze({
    version: PROJECT_STATE_VERSION,
    state_revision: state.stateRevision,
    active_binding_revision: state.activeBindingRevision,
    active_workspace_id: state.activeWorkspaceId,
    workspaces: Object.freeze([...state.workspaces.values()].sort(compareCreated)),
    sessions: Object.freeze([...state.sessions.values()].sort(compareCreated)),
  })
}

export function compareCreated(
  left: {readonly created_at: number; readonly workspace_id?: string; readonly session_id?: string},
  right: {readonly created_at: number; readonly workspace_id?: string; readonly session_id?: string},
): number {
  return left.created_at - right.created_at
    || compareCodePoints(left.workspace_id ?? left.session_id ?? '', right.workspace_id ?? right.session_id ?? '')
}

/** Desktop roster order: most recently used first, capped like the other public listings. */
export function recentWorkspaces(workspaces: readonly WorkspaceRecord[]): readonly WorkspaceRecord[] {
  return [...workspaces].sort((left, right) =>
    right.last_used_at - left.last_used_at
    || right.created_at - left.created_at
    || compareCodePoints(right.workspace_id, left.workspace_id),
  ).slice(0, MAX_PUBLIC_ROSTER)
}

export function mostRecentlyUsed<T extends {
  readonly last_used_at: number
  readonly created_at: number
  readonly workspace_id: string
}>(
  values: Iterable<T>,
): T | undefined {
  return [...values].sort((left, right) =>
    right.last_used_at - left.last_used_at
    || right.created_at - left.created_at
    || compareCodePoints(right.workspace_id, left.workspace_id),
  )[0]
}

export function requireWorkspaceCapacity(state: MutableProjectState): void {
  if (state.workspaces.size >= MAX_PROJECT_WORKSPACES) throw new ProjectStateError('workspace_limit')
}

export function requireUniqueWorkspaceName(state: MutableProjectState, normalized: string): void {
  if ([...state.workspaces.values()].some(record => record.normalized_name === normalized)) {
    throw new ProjectStateError('workspace_name_conflict')
  }
}

export function uniqueWorkspaceName(state: MutableProjectState, base: string): string {
  if (![...state.workspaces.values()].some(
    record => record.normalized_name === normalizeProjectWorkspaceName(base).normalized,
  )) return base
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const ending = ` (${suffix})`
    const clipped = stripLikePython([...base].slice(0, Math.max(1, MAX_PROJECT_WORKSPACE_NAME - [...ending].length)).join(''))
    const candidate = `${clipped}${ending}`
    if (![...state.workspaces.values()].some(
      record => record.normalized_name === normalizeProjectWorkspaceName(candidate).normalized,
    )) return candidate
  }
  throw new ProjectStateError('workspace_limit')
}

export function uniqueSessionTitle(state: MutableProjectState, workspaceId: string, base: string): string {
  const exists = (candidate: string): boolean => {
    const normalized = normalizeProjectSessionTitle(candidate).normalized
    return [...state.sessions.values()].some(
      session => session.workspace_id === workspaceId && session.normalized_title === normalized,
    )
  }
  if (!exists(base)) return base
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const ending = ` (${suffix})`
    const clipped = stripLikePython([...base].slice(0, Math.max(1, MAX_PROJECT_SESSION_TITLE - [...ending].length)).join(''))
    const candidate = `${clipped}${ending}`
    if (!exists(candidate)) return candidate
  }
  throw new ProjectStateError('session_limit')
}

export function pruneForSessionInsert(state: MutableProjectState, workspaceId: string): void {
  const workspaceCount = (): number => [...state.sessions.values()].filter(
    session => session.workspace_id === workspaceId,
  ).length
  while (
    workspaceCount() >= MAX_PROJECT_SESSIONS_PER_WORKSPACE
    || state.sessions.size >= MAX_PROJECT_SESSIONS_TOTAL
  ) {
    const activeIds = new Set([...state.workspaces.values()].flatMap(
      workspace => workspace.active_session_id === null ? [] : [workspace.active_session_id],
    ))
    const targetOnly = workspaceCount() >= MAX_PROJECT_SESSIONS_PER_WORKSPACE
    const candidates = [...state.sessions.values()].filter(session =>
      session.state !== 'starting'
      && !activeIds.has(session.session_id)
      && (!targetOnly || session.workspace_id === workspaceId),
    ).sort((left, right) =>
      (left.state === 'unavailable' ? 0 : 1) - (right.state === 'unavailable' ? 0 : 1)
      || left.last_used_at - right.last_used_at
      || left.created_at - right.created_at
      || compareCodePoints(left.session_id, right.session_id),
    )
    const candidate = candidates[0]
    if (candidate === undefined) throw new ProjectStateError('session_limit')
    state.sessions.delete(candidate.session_id)
  }
}

export function newestReadySession(
  state: MutableProjectState,
  workspaceId: string,
): ProjectSessionRecord | undefined {
  return [...state.sessions.values()].filter(
    session => session.workspace_id === workspaceId && session.state === 'ready',
  ).sort((left, right) =>
    right.last_used_at - left.last_used_at
    || right.created_at - left.created_at
    || compareCodePoints(right.session_id, left.session_id),
  )[0]
}

export function slugPrefix(display: string): string {
  const pieces: string[] = []
  for (const character of casefoldLikePython(display)) {
    const codePoint = character.codePointAt(0)
    const alphanumeric = codePoint !== undefined
      && (isLetterCategory(codePoint) || isNumberCategory(codePoint))
    if (alphanumeric) pieces.push(character)
    else if ((isPythonSpace(character) || character === '-' || character === '_') && pieces.at(-1) !== '-') {
      if (pieces.length > 0) pieces.push('-')
    }
  }
  const prefix = [...stripLikePython(pieces.join('').replace(/^-+|-+$/gu, ''))].slice(0, 32).join('').replace(/-+$/gu, '')
  return prefix === '' ? 'workspace' : prefix
}

export function validateThreadId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || [...value].length < 1
    || [...value].length > MAX_PROJECT_THREAD_ID
    || [...value].some(character => {
      const codePoint = character.codePointAt(0)
      return codePoint === undefined || isOtherCategory(codePoint)
    })
  ) throw new ProjectStateError('thread_id_invalid')
  return value
}

export function encodeState(state: MutableProjectState): Readonly<Record<string, unknown>> {
  return {
    version: PROJECT_STATE_VERSION,
    state_revision: state.stateRevision,
    active_binding_revision: state.activeBindingRevision,
    active_workspace_id: state.activeWorkspaceId,
    workspaces: Object.fromEntries([...state.workspaces].map(([key, value]) => [key, {...value}])),
    sessions: Object.fromEntries([...state.sessions].map(([key, value]) => [key, {...value}])),
  }
}

export function encodeMaintenanceJournal(journal: ManagedMaintenanceJournal): Readonly<Record<string, unknown>> {
  return {
    entries: journal.entries.map(entry => {
      const encoded = {
        identity: {
          device: entry.identity.device.toString(10),
          inode: entry.identity.inode.toString(10),
        },
        original_name: entry.original_name,
        replacement_identity: entry.replacement_identity === null ? null : {
          device: entry.replacement_identity.device.toString(10),
          inode: entry.replacement_identity.inode.toString(10),
        },
        tombstone_name: entry.tombstone_name,
        workspace_id: entry.workspace_id,
      }
      return journal.version === 1
        ? encoded
        : {...encoded, replacement_name: entry.replacement_name}
    }),
    operation_id: journal.operation_id,
    phase: journal.phase,
    version: journal.version,
  }
}

export function decodeMaintenanceJournal(value: unknown): ManagedMaintenanceJournal {
  const root = exactRecord(value, ['entries', 'operation_id', 'phase', 'version'])
  if (
    (root.version !== 1 && root.version !== 2)
    || !Array.isArray(root.entries)
    || root.entries.length > MAX_PROJECT_WORKSPACES
  ) {
    throw new ProjectStateError('state_corrupt')
  }
  const operationId = storedId(root.operation_id)
  if (root.phase !== 'prepared' && root.phase !== 'committed') {
    throw new ProjectStateError('state_corrupt')
  }
  const entries = root.entries.map(raw => {
    const entry = exactRecord(raw, root.version === 1
      ? ['identity', 'original_name', 'replacement_identity', 'tombstone_name', 'workspace_id']
      : [
          'identity', 'original_name', 'replacement_identity', 'replacement_name',
          'tombstone_name', 'workspace_id',
        ])
    const identity = exactRecord(entry.identity, ['device', 'inode'])
    const replacementIdentity = entry.replacement_identity === null
      ? null
      : exactRecord(entry.replacement_identity, ['device', 'inode'])
    if (typeof entry.original_name !== 'string') throw new ProjectStateError('state_corrupt')
    requireProjectBasename(entry.original_name, 'state_corrupt')
    if (
      typeof entry.tombstone_name !== 'string'
      || MAINTENANCE_TOMBSTONE.exec(entry.tombstone_name)?.[1] !== operationId
    ) throw new ProjectStateError('state_corrupt')
    const replacementName = root.version === 1 ? entry.original_name : entry.replacement_name
    if (
      typeof replacementName !== 'string'
      || (root.version === 2
        && (
          MAINTENANCE_REPLACEMENT.exec(replacementName)?.[1] !== operationId
          || replacementName !== entry.tombstone_name.replace(
            '.nova-maintenance-',
            '.nova-replacement-',
          )
        ))
    ) throw new ProjectStateError('state_corrupt')
    return Object.freeze({
      workspace_id: storedId(entry.workspace_id),
      original_name: entry.original_name,
      tombstone_name: entry.tombstone_name,
      replacement_name: replacementName,
      identity: Object.freeze({
        device: decimalIdentity(identity.device),
        inode: decimalIdentity(identity.inode),
      }),
      replacement_identity: replacementIdentity === null ? null : Object.freeze({
        device: decimalIdentity(replacementIdentity.device),
        inode: decimalIdentity(replacementIdentity.inode),
      }),
    })
  })
  if (
    entries.length === 0
    || new Set(entries.map(entry => entry.workspace_id)).size !== entries.length
    || new Set(entries.map(entry => entry.original_name)).size !== entries.length
    || new Set(entries.map(entry => entry.tombstone_name)).size !== entries.length
    || new Set(entries.map(entry => entry.replacement_name)).size !== entries.length
  ) {
    throw new ProjectStateError('state_corrupt')
  }
  if (root.phase === 'committed' && entries.some(entry => entry.replacement_identity === null)) {
    throw new ProjectStateError('state_corrupt')
  }
  return Object.freeze({
    version: root.version,
    operation_id: operationId,
    phase: root.phase,
    entries: Object.freeze(entries),
  })
}

function decimalIdentity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,39})$/u.test(value)) {
    throw new ProjectStateError('state_corrupt')
  }
  const parsed = BigInt(value)
  if (parsed > 18_446_744_073_709_551_615n) throw new ProjectStateError('state_corrupt')
  return parsed
}

export function projectTimestampNumber(value: number, path: CanonicalJsonPath): string | undefined {
  if (path.length !== 3) return undefined
  const [collection, recordId, field] = path
  if (
    (collection !== 'workspaces' && collection !== 'sessions')
    || typeof recordId !== 'string'
    || (field !== 'created_at' && field !== 'last_used_at')
  ) return undefined
  return pythonFloat(value)
}

const persistedId = z.string().regex(STORED_ID)

// Keep JSON dictionary keys verbatim; z.record drops the valid stored ID '__proto__'.
const persistedObject = z.custom<Record<string, unknown>>(
  value => value !== null && typeof value === 'object' && !Array.isArray(value),
)

const persistedState = z.object({
  version: z.unknown().nonoptional(),
  active_workspace_id: z.unknown().nonoptional(),
  workspaces: z.unknown().nonoptional(),
  sessions: z.unknown().nonoptional(),
  state_revision: z.unknown().optional(),
  active_binding_revision: z.unknown().optional(),
}).strict()

const persistedWorkspace = z.object({
  workspace_id: persistedId,
  display_name: z.unknown().nonoptional(),
  normalized_name: z.string(),
  canonical_path: z.string().refine(path => isWellFormed(path) && isAbsolute(path)),
  origin: z.enum(['managed', 'registered']),
  codex_home_key: z.string(),
  active_session_id: persistedId.nullable(),
  created_at: z.number(),
  last_used_at: z.number(),
}).strict().transform(raw => {
  const name = normalizeProjectWorkspaceName(raw.display_name)
  if (raw.normalized_name !== name.normalized || raw.codex_home_key !== `home-${raw.workspace_id}`) {
    throw new ProjectStateError('state_corrupt')
  }
  return Object.freeze({...raw, display_name: name.display})
})

const persistedSession = z.object({
  session_id: persistedId,
  workspace_id: persistedId,
  display_title: z.unknown().nonoptional(),
  normalized_title: z.string(),
  codex_thread_id: z.unknown().nonoptional(),
  backend_id: z.enum(CODING_BACKEND_IDS).optional(),
  backend_profile_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,255}$/u).optional(),
  backend_session_id: z.unknown().optional(),
  state: z.enum(['starting', 'ready', 'unavailable']),
  created_at: z.number(),
  last_used_at: z.number(),
  executor_home: z.string().refine(isAbsolute).optional(),
  origin: z.enum(['nova', 'external']).optional(),
}).strict().transform(raw => {
  if (raw.origin === 'external' && raw.executor_home === undefined) throw new ProjectStateError('state_corrupt')
  const title = normalizeProjectSessionTitle(raw.display_title)
  if (raw.normalized_title !== title.normalized) throw new ProjectStateError('state_corrupt')
  const threadId = raw.codex_thread_id === null ? null : validateThreadId(raw.codex_thread_id)
  const backend = raw.backend_id ?? 'codex'
  const sessionId = raw.backend_id === undefined ? threadId
    : raw.backend_session_id === null ? null : validateThreadId(raw.backend_session_id)
  if ((backend === 'codex' ? threadId !== sessionId : threadId !== null)
    || ((raw.origin ?? (raw.executor_home === undefined ? 'nova' : 'external')) === 'external' && backend !== 'codex')
    || (raw.state === 'ready' && sessionId === null) || (raw.state === 'starting' && sessionId !== null)) {
    throw new ProjectStateError('state_corrupt')
  }
  const {origin, executor_home: executorHome, ...record} = raw
  return Object.freeze({
    ...record,
    ...(executorHome === undefined ? {} : {executor_home: executorHome}),
    ...(origin === undefined && executorHome === undefined ? {} : {origin: origin ?? 'external'}),
    display_title: title.display,
    codex_thread_id: threadId,
    backend_id: backend,
    backend_profile_id: raw.backend_profile_id ?? 'codex:legacy',
    backend_session_id: sessionId,
  })
})

export function decodeState(value: unknown): MutableProjectState {
  const root = persistedState.parse(value)
  if (root.version !== 1 && root.version !== PROJECT_STATE_VERSION) throw new ProjectStateError('state_version_unsupported')
  const rawWorkspaces = persistedObject.parse(root.workspaces)
  const rawSessions = persistedObject.parse(root.sessions)
  if (Object.keys(rawWorkspaces).length > MAX_PROJECT_WORKSPACES
    || Object.keys(rawSessions).length > MAX_PROJECT_SESSIONS_TOTAL) throw new ProjectStateError('state_corrupt')
  const state = emptyState()
  state.stateRevision = Object.hasOwn(root, 'state_revision') ? stateRevision(root.state_revision) : 0
  state.activeBindingRevision = Object.hasOwn(root, 'active_binding_revision') ? stateRevision(root.active_binding_revision) : 0
  for (const [key, raw] of Object.entries(rawWorkspaces)) state.workspaces.set(key, persistedWorkspace.parse(raw))
  for (const [key, raw] of Object.entries(rawSessions)) {
    const record = persistedObject.parse(raw)
    const bindingKeys = ['backend_id', 'backend_profile_id', 'backend_session_id']
    if (root.version === 1 ? bindingKeys.some(field => Object.hasOwn(record, field))
      : bindingKeys.some(field => !Object.hasOwn(record, field))) throw new ProjectStateError('state_corrupt')
    state.sessions.set(key, persistedSession.parse(raw))
  }
  const active = root.active_workspace_id
  if (active !== null && typeof active !== 'string') throw new ProjectStateError('state_corrupt')
  state.activeWorkspaceId = active
  validateState(state)
  return state
}

export function validateState(state: MutableProjectState): void {
  stateRevision(state.stateRevision)
  stateRevision(state.activeBindingRevision)
  if (state.workspaces.size > MAX_PROJECT_WORKSPACES || state.sessions.size > MAX_PROJECT_SESSIONS_TOTAL) {
    throw new ProjectStateError('state_corrupt')
  }
  if (state.activeWorkspaceId !== null && !state.workspaces.has(state.activeWorkspaceId)) {
    throw new ProjectStateError('state_corrupt')
  }
  const workspaceNames = new Set<string>()
  const sessionTitles = new Set<string>()
  for (const [workspaceId, workspace] of state.workspaces) {
    if (workspaceId !== workspace.workspace_id) throw new ProjectStateError('state_corrupt')
    if (workspaceNames.has(workspace.normalized_name)) throw new ProjectStateError('state_corrupt')
    workspaceNames.add(workspace.normalized_name)
    if (workspace.active_session_id !== null) {
      const session = state.sessions.get(workspace.active_session_id)
      if (session?.workspace_id !== workspace.workspace_id) throw new ProjectStateError('state_corrupt')
    }
  }
  const sessionCounts = new Map<string, number>()
  for (const [sessionId, session] of state.sessions) {
    if (sessionId !== session.session_id || !state.workspaces.has(session.workspace_id)) {
      throw new ProjectStateError('state_corrupt')
    }
    const count = (sessionCounts.get(session.workspace_id) ?? 0) + 1
    if (count > MAX_PROJECT_SESSIONS_PER_WORKSPACE) throw new ProjectStateError('state_corrupt')
    sessionCounts.set(session.workspace_id, count)
    const key = `${session.workspace_id}\u0000${session.normalized_title}`
    if (sessionTitles.has(key)) throw new ProjectStateError('state_corrupt')
    sessionTitles.add(key)
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectStateError('state_corrupt')
  }
  const record = value as Readonly<Record<string, unknown>>
  const actual = Object.keys(record)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new ProjectStateError('state_corrupt')
  }
  return record
}

function storedId(value: unknown): string {
  if (typeof value !== 'string' || !STORED_ID.test(value)) throw new ProjectStateError('state_corrupt')
  return value
}

export function stateRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProjectStateError('state_corrupt')
  }
  return value
}

export function bumpStateRevision(state: MutableProjectState): number {
  if (!Number.isSafeInteger(state.stateRevision) || state.stateRevision < 0
    || state.stateRevision >= Number.MAX_SAFE_INTEGER) {
    throw new ProjectStateError('state_corrupt')
  }
  state.stateRevision += 1
  return state.stateRevision
}

export function bumpActiveBindingRevision(state: MutableProjectState): number {
  if (!Number.isSafeInteger(state.activeBindingRevision) || state.activeBindingRevision < 0
    || state.activeBindingRevision >= Number.MAX_SAFE_INTEGER) {
    throw new ProjectStateError('state_corrupt')
  }
  state.activeBindingRevision += 1
  return state.activeBindingRevision
}
