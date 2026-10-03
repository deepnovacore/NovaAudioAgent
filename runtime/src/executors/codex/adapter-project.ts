import {taskGrantService} from '../../personal-agent/tasks.js'
import type {TaskDispatchContext} from '../../core/task-tools.js'
import {acquireTaskResources,taskResourcesBusy,quarantineTaskResources,taskResourcesUncertain} from '../task-resources.js'
import {managedMcpResources,type ManagedCodexMcp} from './managed-mcp.js'
import type {CodingTarget, CodingTargetPort, CodingTargetSelection} from '../../personal-agent/coding-targets.js'
import {basename} from 'node:path'
import {compareCodePoints} from '../../text/canonical-json.js'
import {stripLikePython} from '../../text/python-text.js'
import {realpath} from 'node:fs/promises'
import {readLocalCodexSessions, readLocalCodexProjects, type LocalCodexProject, localRolloutAvailable} from './local-sessions.js'
import {hostPersistentHomeFromConfig, hostWorkspaceFromConfig} from '../../projects/host-paths.js'
import {hostWorkspacePath} from '../../projects/host-paths.js'
import {MAX_PROJECT_SESSION_TITLE, normalizeProjectSessionTitle} from '../../projects/project-state.js'
import type {
  CodexAppServerTransport,
  RunInput,
  SafePreflightReport,
  SteerInput,
  SteerTransportResult,
  TransportDeadline,
  TransportObserver,
  TransportOutcome,
} from './app-server-transport.js'
import {CodexTransportError} from './app-server-transport.js'
import {
  CODEX_PROJECT_APPROVAL_MANIFEST,
  CODEX_PROJECT_MANIFEST,
  validateCodexRequest,
} from './contract.js'
import {
  ProjectStateError,
  type ProjectSnapshot,
  type ProjectStore,
  type ProjectSessionRecord,
  type PublicProjectContext,
  type PublicProjectView,
  type SessionResumeRollback,
  type SessionStartRollback,
  type WorkspaceRecord,
} from '../../projects/project-store.js'
import type {HostCodexHome, HostWorkspace} from './process-owner.js'
import type {
  ExecutorDispatchContext,
  ExecutorHandoff,
} from '../../core/causal-runtime.js'
import type {JsonValue} from '../../core/events.js'
import {consumeHostExecutorCapability} from '../host-executor-capability.js'
import {USER_PRIORITY} from '../../core/memory.js'
import type {ApprovalWork} from '../../core/approval-port.js'
import type {HostApprovalController} from '../../core/approval.js'
import {
  ProjectResolutionError,
  type CancelContext,
  type CancelResult,
  type CoordinatorDecision,
  type IntakeTarget,
  type ProjectCommitResult,
  type ProjectExecutorAdapter,
  type ProjectRuntimeDispatch,
  type RosterEntry,
  type RunningWork,
} from '../coding-executor.js'
import type {
  ConfirmedProjectOperation,
  ProjectConfirmationController,
} from '../../projects/project-confirmation.js'
import {MAX_CONCURRENT_WORK, deriveSessionTitle} from '../../core/work-tools.js'
import {CodexLiveAdapter} from './adapter-live.js'
import {
  createCodexAdapterSharedState,
  failureHandoff,
  failureStage,
  type CodexAdapterSharedState,
  type ValidatedCodexDisposition,
} from './common.js'

/** Recent-project budget for display, local discovery and rich session history. */
const MAX_ROSTER = 10

/** Whether a stored title is what importing `catalogTitle` produces: normalized, or normalized plus a ` (n)` uniqueness suffix. */
function sameSessionTitle(stored: string, catalogTitle: string): boolean {
  try {
    const expected = normalizeProjectSessionTitle([...catalogTitle].slice(0, MAX_PROJECT_SESSION_TITLE).join('')).display
    if (stored === expected) return true
    const suffixed = /^(.+) \((\d+)\)$/u.exec(stored)
    if (suffixed === null) return false
    const room = Math.max(1, MAX_PROJECT_SESSION_TITLE - [...` (${suffixed[2]})`].length)
    return suffixed[1] === stripLikePython([...expected].slice(0, room).join(''))
  } catch { return false }
}

export interface ProjectTransportBinding {
  readonly preserveHome?: boolean

  readonly workspace: HostWorkspace
  readonly codexHome: HostCodexHome
  readonly resumeThreadId: string | null
  /** The work this child serves; the factory scopes the shared approval FIFO to it. */
  readonly work: ApprovalWork
}

/** One running work per workspace (spec 08 Concurrency); `work` is mutable only for its title. */
interface RunSlot {
  work: RunningWork
  readonly controller: AbortController
  live: CodexLiveAdapter | null
  task: Promise<ExecutorHandoff> | null
  cancelled: boolean
}

interface ProjectRunInput {
  readonly session_id?: string

  readonly work_order: string
  readonly project: string | null
  readonly session: 'latest' | 'new'
  readonly title?: string
}

export interface ProjectTransportFactory {
  create(binding: ProjectTransportBinding): CodexAppServerTransport
}

export type {ProjectCommitResult, ProjectRuntimeDispatch}

export interface ProjectCodexAdapterOptions {
  readonly managedMcp?:ManagedCodexMcp
  readonly localCodexHome?: string

  readonly store: ProjectStore
  readonly confirmation: ProjectConfirmationController
  readonly transportFactory: ProjectTransportFactory
  readonly codexApproval?: HostApprovalController
  readonly onProjectView?: ProjectViewObserver
}

type ProjectViewObserver = (view: PublicProjectView) => void | Promise<void>
type ProjectContextObserver = (context: PublicProjectContext) => void | Promise<void>

interface ConfirmedDelegateBinding {
  readonly operation: ConfirmedProjectOperation
  readonly delegateId: string
  readonly originRef: string
  readonly workOrder: string
}

export class ProjectCodexAdapter implements ProjectExecutorAdapter {
  readonly manifest
  readonly #localCodexHome: string | undefined
  #localSessionIds = new Set<string>()
  #localProjects: readonly LocalCodexProject[] | null = null
  #sessionProjectPaths = new Map<string, string>()
  #catalogHealthy = false
  #catalogTimer: ReturnType<typeof setInterval> | null = null
  #catalogRefresh: Promise<void> | null = null
  readonly #store: ProjectStore
  readonly #confirmation: ProjectConfirmationController
  readonly #transportFactory: ProjectTransportFactory
  readonly #projectViewObservers = new Set<ProjectViewObserver>()
  readonly #projectContextObservers = new Set<ProjectContextObserver>()
  // ponytail: one status snapshot shared by every run's live adapter, so `status` reports the last
  // run that touched it; per-slot status is the upgrade path once the host asks for it.
  readonly #liveState: CodexAdapterSharedState = createCodexAdapterSharedState()
  readonly #status = new CodexLiveAdapter(NULL_TRANSPORT, undefined, {sharedState: this.#liveState})
  readonly #confirmedBindings = new WeakMap<object, ConfirmedDelegateBinding>()
  readonly #retainedTransportCleanups = new Set<CodexAppServerTransport>()
  readonly #resourceKeys:readonly string[]|null
  readonly #slotWaiters=new Set<()=>void>()
  taskResource():string|null{return this.#resourceKeys?.length===1?this.#resourceKeys[0]!:null}
  readonly #slots = new Map<string, RunSlot>()
  readonly #taskWorkspaces = new Map<string, {readonly workspace_id: string; readonly session_id?: string}>()
  readonly taskPort = {
    quarantineResources:()=>{quarantineTaskResources(this.#resourceKeys??[])},
    inspectSession:async(sessionId:string):Promise<string|null>=>{
      const snapshot=await this.#store.snapshot(),session=snapshot.sessions.find(item=>item.session_id===sessionId);
      if(!session)return 'task_session_not_found';if(session.state!=='ready')return 'task_session_'+session.state;
      try{await this.#store.revalidateWorkspace(session.workspace_id);if(!await this.#rolloutAvailable(session))return 'task_session_resume_unavailable'}catch{return 'task_session_resume_unavailable'}
      if(this.#slots.has(session.workspace_id))return 'task_session_running';return null
    },
    resolveSession:async(sessionId:string)=>{
      const snapshot=await this.#store.snapshot(),session=snapshot.sessions.find(item=>item.session_id===sessionId)
      const workspace=snapshot.workspaces.find(item=>item.workspace_id===session?.workspace_id)
      if(!session||!workspace)throw Error('session_not_found')
      const activeSlot=this.#slots.get(workspace.workspace_id)
      const activeBinding=activeSlot===undefined?undefined:this.#taskWorkspaces.get(activeSlot.work.work_id)
      const liveStartingSession=session.state==='starting'&&activeSlot!==undefined&&activeSlot.live!==null
        &&activeBinding?.workspace_id===workspace.workspace_id&&activeBinding.session_id===sessionId
      if(session.state!=='ready'&&!liveStartingSession)throw Error('session_not_found')
      await this.#store.revalidateWorkspace(workspace.workspace_id)
      if(activeSlot&&this.#taskWorkspaces.get(activeSlot.work.work_id)?.session_id!==sessionId)throw Error('session_active')
      return {project:workspace.display_name,session_id:sessionId,active:!!activeSlot,...(activeSlot?{work_id:activeSlot.work.work_id}:{})}
    },
    cancelTask: (workId: string): 'cancelling' | 'not_running' => this.#cancelWork(workId) ? 'cancelling' : 'not_running',
    taskDirectory: async (workId: string): Promise<string | null> => {
      const workspaceId = this.#taskWorkspaces.get(workId)?.workspace_id
      return workspaceId === undefined ? null : hostWorkspacePath(await this.#store.revalidateWorkspace(workspaceId))
    },
  }
  #snapshot: ProjectSnapshot | null = null
  #publicView: PublicProjectView = Object.freeze({
    workspace_display_name: null,
    session_title: null,
    roster: [],
    pending_confirmation: false,
    pending_confirmation_busy: false,
  })
  #publicWorkspaceId: string | null = null
  #refreshSequence = 0
  #initializePromise: Promise<void> | null = null
  #projectCommitActive = false
  #closed = false
  #closePromise: Promise<void> | null = null

  constructor(options: ProjectCodexAdapterOptions) {
    this.manifest = options.codexApproval === undefined
      ? CODEX_PROJECT_MANIFEST
      : CODEX_PROJECT_APPROVAL_MANIFEST
    this.#resourceKeys=managedMcpResources(options.managedMcp)
    this.#localCodexHome = options.localCodexHome
    this.#store = options.store
    this.#confirmation = options.confirmation
    this.#transportFactory = options.transportFactory
    if (options.onProjectView !== undefined) this.#projectViewObservers.add(options.onProjectView)
  }

  /** Exact controller owned by this adapter; host assembly uses it for spoken confirmation. */
  get confirmationController(): ProjectConfirmationController {
    return this.#confirmation
  }

  initialize(): Promise<void> {
    if (this.#initializePromise !== null) return this.#initializePromise
    const work = this.#refreshLocalSessions().then(async () => {
      await this.#refreshProjectViewTolerant()
      if (this.#localCodexHome && !this.#closed) {
        this.#catalogTimer = setInterval(() => { void this.#refreshLocalSessions().then(() => this.#refreshProjectViewTolerant()).catch(() => undefined) }, 30_000)
        this.#catalogTimer.unref()
      }
    })
    this.#initializePromise = work
    return work
  }

  #refreshLocalSessions(): Promise<void> {
    if (!this.#localCodexHome || this.#closed) return Promise.resolve()
    if (this.#catalogRefresh) return this.#catalogRefresh
    const refresh = (async () => {
      const ids = new Set<string>()
      try {
        const home = await realpath(this.#localCodexHome!)
        this.#localProjects = await readLocalCodexProjects(home)
        const projectPaths = new Map<string, string>()
        const registeredPaths = new Set((await this.#store.snapshot()).workspaces.map(workspace => workspace.canonical_path))
        for (const project of this.#localProjects ?? []) {
          if (registeredPaths.has(project.path)) continue
          try { await this.#store.ensureImported(project.name, hostWorkspaceFromConfig(project.path, [project.path])) }
          catch { /* One unavailable project must not hide the remaining roots. */ }
        }
        const catalog = await readLocalCodexSessions(home)
        const projectFor = (item: typeof catalog[number]) => this.#localProjects?.find(project => project.path === item.cwd && project.threadIds.includes(item.threadId))
          ?? this.#localProjects?.find(project => project.threadIds.includes(item.threadId))
          ?? this.#localProjects?.find(project => project.path === item.cwd)
        const paths = new Set<string>()
        for (const item of catalog) {
          if (this.#localProjects !== null ? projectFor(item) !== undefined : paths.size < MAX_ROSTER) paths.add(item.cwd)
        }
        // Each import is a locked read-parse-validate-write transaction (~50 ms on a real store), so only
        // entries the store does not already hold identically go through one.
        let workspacesByPath = new Map<string, WorkspaceRecord>()
        let sessionsByThread = new Map<string, ProjectSessionRecord>()
        let stale = true
        for (const item of [...catalog].reverse()) {
          if (this.#closed) return
          if (!paths.has(item.cwd)) continue
          // An import can evict other sessions at capacity, so re-read the store after one before trusting a skip.
          if (stale) {
            const held = await this.#store.snapshot()
            workspacesByPath = new Map(held.workspaces.map(workspace => [workspace.canonical_path, workspace]))
            sessionsByThread = new Map(held.sessions.flatMap(session => session.codex_thread_id === null ? [] : [[`${session.executor_home ?? ''}\0${session.codex_thread_id}`, session] as const]))
            stale = false
          }
          const workspace = workspacesByPath.get(item.cwd)
          const existing = workspace === undefined ? undefined : sessionsByThread.get(`${home}\0${item.threadId}`)
          if (workspace !== undefined && existing?.workspace_id === workspace.workspace_id && existing.state === 'ready'
            && (existing.origin === 'nova' || (existing.last_used_at >= item.updatedAt && workspace.last_used_at >= item.updatedAt
              && sameSessionTitle(existing.display_title, item.title)))) {
            ids.add(existing.session_id)
            const project = projectFor(item)
            if (project) projectPaths.set(existing.session_id, project.path)
            continue
          }
          stale = true
          try {
            const workspace = await this.#store.ensureImported([...basename(item.cwd)].slice(0, 80).join('') || 'workspace', hostWorkspaceFromConfig(item.cwd, [item.cwd]))
            const session = await this.#store.importSession(workspace.workspace_id, {
              threadId: item.threadId, title: item.title, home: home, updatedAt: item.updatedAt,
            })
            ids.add(session.session_id)
            const project = projectFor(item)
            if (project) projectPaths.set(session.session_id, project.path)
          } catch { /* An unavailable directory or full store must not hide other sessions. */ }
        }
        this.#localSessionIds = ids
        this.#sessionProjectPaths = projectPaths
        this.#catalogHealthy = true
      } catch { this.#catalogHealthy = false }
    })()
    this.#catalogRefresh = refresh.finally(() => { this.#catalogRefresh = null })
    return this.#catalogRefresh
  }

  readonly targetPort: CodingTargetPort = {
    list: () => this.#listCodingTargets(),
    forWork: async workId => {
      const binding = this.#taskWorkspaces.get(workId)
      if (binding?.session_id === undefined) return null
      try { return await this.#validateCodingTarget({workspace_id: binding.workspace_id, session_id: binding.session_id}) }
      catch (error) { if (error instanceof ProjectResolutionError) return null; throw error }
    },
    validate: selection => this.#validateCodingTarget(selection),
    resolve: (decision, selection,taskContext) => this.resolveIntakeTarget(decision, selection,taskContext),
  }

  async #listCodingTargets(): ReturnType<CodingTargetPort['list']> {
    await this.#refreshLocalSessions()
    const snapshot = await this.#store.snapshot()
    const targets: Awaited<ReturnType<CodingTargetPort['list']>>[number][] = []
    const savedRoots = this.#localProjects === null ? null : new Map(this.#localProjects.map(project => [project.path, project]))
    const workspaces = [...snapshot.workspaces].sort((a, b) => b.last_used_at - a.last_used_at)
    for (const workspace of savedRoots === null ? workspaces.slice(0, MAX_ROSTER) : workspaces) {
      if (savedRoots !== null && !savedRoots.has(workspace.canonical_path)
        && !snapshot.sessions.some(session => session.workspace_id === workspace.workspace_id && this.#sessionProjectPaths.has(session.session_id))) continue
      try { await this.#store.revalidateWorkspace(workspace.workspace_id) } catch { continue }
      // Exclusive workspace concurrency: a running work blocks every session of its workspace.
      const holder = this.#slots.get(workspace.workspace_id)?.work.title
      const base = {workspace_id: workspace.workspace_id, project: workspace.display_name, executor: 'codex' as const, directory: workspace.canonical_path, ...(holder === undefined ? {} : {running: holder})}
      const saved = savedRoots?.get(workspace.canonical_path)
      if (savedRoots === null || saved) targets.push({...base, session_id: null, title: workspace.display_name,
        ...(saved ? {group_project:saved.name} : {})})
      for (const session of snapshot.sessions.filter(item => item.workspace_id === workspace.workspace_id
        && item.state === 'ready' && item.codex_thread_id !== null
        && (!item.executor_home || item.origin === 'nova' || (this.#catalogHealthy && this.#localSessionIds.has(item.session_id))))
        .sort((a, b) => b.last_used_at - a.last_used_at).slice(0, 20)) {
        const projectPath = this.#sessionProjectPaths.get(session.session_id) ?? workspace.canonical_path
        if (savedRoots !== null && !savedRoots.has(projectPath)) continue
        const group = snapshot.workspaces.find(item => item.canonical_path === projectPath)
        if (savedRoots !== null && !group) continue
        if (await this.#rolloutAvailable(session)) targets.push({...base, session_id: session.session_id, title: session.display_title, last_active: session.last_used_at,
          ...(group && savedRoots ? {group_workspace_id:group.workspace_id,group_project:savedRoots.get(projectPath)!.name,group_directory:group.canonical_path} : {})})
      }
    }
    return targets
  }

  async #validateCodingTarget(selection: CodingTargetSelection): Promise<CodingTarget> {
    const snapshot = await this.#store.snapshot()
    const workspace = snapshot.workspaces.find(item => item.workspace_id === selection.workspace_id)
    if (!workspace) throw new ProjectResolutionError('unknown_project', {reason: 'target_unavailable'})
    try { await this.#store.revalidateWorkspace(workspace.workspace_id) }
    catch (error) {
      if (error instanceof ProjectStateError && ['workspace_invalid', 'workspace_not_found', 'workspace_boundary_changed'].includes(error.code)) {
        throw new ProjectResolutionError('unknown_project', {reason: 'target_unavailable'})
      }
      throw error
    }
    const base = {workspace_id: workspace.workspace_id, project: workspace.display_name, executor: 'codex' as const}
    if (selection.session_id === null) return {...base, session_id: null, title: workspace.display_name}
    const session = snapshot.sessions.find(item => item.workspace_id === workspace.workspace_id && item.session_id === selection.session_id)
    if (session?.state !== 'ready' || session.codex_thread_id === null
      || !await this.#externalSessionAvailable(workspace, session) || !await this.#rolloutAvailable(session)) {
      throw new ProjectResolutionError('unknown_session', {reason: 'target_unavailable'})
    }
    return {...base, session_id: session.session_id, title: session.display_title}
  }

  async activeCommittedWorkspace(): Promise<WorkspaceRecord | null> {
    const snapshot = await this.#store.snapshot()
    if (snapshot.active_workspace_id === null) return null
    return snapshot.workspaces.find(
      workspace => workspace.workspace_id === snapshot.active_workspace_id,
    ) ?? null
  }

  /**
   * Deterministic coordinator sink (spec 08): exact roster-name match, `work` refuses busy/capacity.
   * Resolve only — no directory, session, proposal, dispatch, or active-project change; a `switch`
   * resolves to `select` and, like every other change of the active project, is committed only by
   * `commitConfirmed` after the user confirmed it.
   */
  async resolveIntakeTarget(decision: CoordinatorDecision, selection?: CodingTargetSelection,taskContext?:TaskDispatchContext): Promise<IntakeTarget> {
    if(taskContext)taskGrantService(taskContext)
    if (decision.kind === 'create') {
      const name = await this.#store.validateManagedCreate(decision.project ?? '')
      return {
        workspace: name, action: 'create', workspace_display_name: name, workspace_id: null,
        session_title: null, session_id: null,
      }
    }
    const selected = selection === undefined ? undefined : await this.#validateCodingTarget(selection)
    const workspace = await this.#resolveProject(selected?.project ?? decision.project)
    if (selected && (workspace.workspace_id !== selected.workspace_id
      || (decision.project !== null && workspace.display_name.toLowerCase() !== decision.project.toLowerCase()))) {
      throw new ProjectResolutionError('unknown_project', {reason: 'target_mismatch'})
    }
    if (decision.kind === 'work'&&!taskContext) {
      const slot = this.#slots.get(workspace.workspace_id)
      if (slot !== undefined) {
        throw new ProjectResolutionError('busy_project', {
          project: workspace.display_name, work_id: slot.work.work_id, title: slot.work.title,
          options: ['steer', 'cancel'],
        })
      }
      if (this.#slots.size >= MAX_CONCURRENT_WORK) {
        throw new ProjectResolutionError('capacity', {running: this.running().map(work => ({...work}))})
      }
    }
    await this.#store.revalidateWorkspace(workspace.workspace_id)
    let session: ProjectSessionRecord | null = null
    if (decision.kind === 'work' && decision.session === 'latest') {
      try {
        session = decision.session_title ? await this.#store.resolveSession(workspace.workspace_id, decision.session_title)
          : selected === undefined ? await this.#latestReadySession(workspace)
          : selected.session_id === null ? null
          : (await this.#store.listSessions(workspace)).find(item => item.session_id === selected.session_id && item.state === 'ready') ?? null
        if (selected?.session_id && !decision.session_title && session === null) throw new Error('session_unavailable')
      }
      catch { throw new ProjectResolutionError('unknown_session', {project: workspace.display_name, title: decision.session_title ?? ''}) }
      if (session !== null && !(await this.#rolloutAvailable(session))) throw new ProjectResolutionError('unknown_session', {project: workspace.display_name, title: session.display_title})
      if (session !== null && !await this.#externalSessionAvailable(workspace, session)) throw new ProjectResolutionError('unknown_session', {project: workspace.display_name, title: session.display_title})
    }
    return {
      workspace: workspace.canonical_path,
      action: decision.kind === 'switch' ? 'select' : session === null ? 'reuse' : 'resume',
      workspace_display_name: workspace.display_name, workspace_id: workspace.workspace_id,
      session_title: session?.display_title ?? null, session_id: session?.session_id ?? null,
    }
  }

  roster(): readonly RosterEntry[] {
    const snapshot = this.#snapshot
    // Display limits must not hide valid project evidence in the bounded registry.
    return [...(snapshot?.workspaces ?? [])].sort((left, right) =>
      right.last_used_at - left.last_used_at || right.created_at - left.created_at
      || compareCodePoints(right.workspace_id, left.workspace_id),
    ).map((workspace, index) => {
      const session = index < MAX_ROSTER ? snapshot?.sessions.find(record => record.session_id === workspace.active_session_id) : undefined
      return {
        name: workspace.display_name,
        last_used_at: workspace.last_used_at,
        last_session_title: session?.display_title ?? null,
        ...(this.#localCodexHome && index < MAX_ROSTER ? {sessions: (snapshot?.sessions ?? [])
          .filter(item => item.workspace_id === workspace.workspace_id && item.state === 'ready' && (!item.executor_home || item.origin === 'nova' || this.#localSessionIds.has(item.session_id)))
          .sort((a, b) => b.last_used_at - a.last_used_at).slice(0, 20).map(item => item.display_title)} : {}),
        running: this.#runningIn(workspace.display_name),
      }
    })
  }

  running(): readonly RunningWork[] {
    return [...this.#slots.values()].map(slot => slot.work)
  }

  /** Exact target id cancels only that work; otherwise 0 → not_running, 1 → cancel, >1 → model target. */
  async cancel(instruction: string | undefined, context: CancelContext): Promise<CancelResult> {
    const running = this.running().filter(work => context.workIds === undefined || context.workIds.has(work.work_id))
    if (running.length === 0) return {code: 'not_running'}
    let target = context.targetWorkId === undefined
      ? running.length === 1 ? running[0] : undefined
      : running.find(work => work.work_id === context.targetWorkId)
    if (context.targetWorkId !== undefined && context.stillWanted?.() === false) return {code: 'ambiguous_work', running}
    if (target === undefined && context.targetWorkId === undefined && instruction !== undefined && instruction !== ''
      && context.resolveCancelTarget !== undefined) {
      const id = await context.resolveCancelTarget(instruction, running)
      // The user may have corrected themselves during the model call: a stale cancel stops nothing.
      if (context.stillWanted?.() === false) return {code: 'ambiguous_work', running}
      target = running.find(work => work.work_id === id)
    }
    if (target === undefined || !this.#cancelWork(target.work_id)) return {code: 'ambiguous_work', running}
    return {code: 'cancelled', work: target}
  }

  #cancelWork(workId: string): boolean {
    for (const slot of this.#slots.values()) {
      if (slot.work.work_id !== workId) continue
      slot.cancelled = true
      slot.controller.abort()
      return true
    }
    return false
  }

  #runningIn(project: string): readonly Pick<RunningWork, 'work_id' | 'title'>[] {
    return [...this.#slots.values()]
      .filter(slot => slot.work.project === project)
      .map(slot => ({work_id: slot.work.work_id, title: slot.work.title}))
  }

  async #resolveProject(project: string | null): Promise<WorkspaceRecord> {
    try {
      return await this.#store.resolveWorkspace(project)
    } catch (error) {
      if (
        !(error instanceof ProjectStateError)
        || (error.code !== 'workspace_not_found' && error.code !== 'workspace_name_invalid')
      ) throw error
      const names = this.#publicView.roster.map(entry => entry.name)
      const needle = (project ?? '').toLowerCase()
      const related = needle === ''
        ? []
        : names.filter(name => name.toLowerCase().includes(needle) || needle.includes(name.toLowerCase()))
      throw new ProjectResolutionError('unknown_project', {
        project, suggestions: (related.length > 0 ? related : names).slice(0, 3), hint: 'create',
      })
    }
  }

  /** The workspace's active session when it can be resumed (ready with a thread), else `null`. */
  async #latestReadySession(workspace: WorkspaceRecord): Promise<ProjectSessionRecord | null> {
    if (workspace.active_session_id === null) return this.#localCodexHome
      ? (await this.#store.listSessions(workspace)).filter(item => item.state === 'ready' && this.#localSessionIds.has(item.session_id))
        .sort((a, b) => b.last_used_at - a.last_used_at)[0] ?? null : null
    let session: ProjectSessionRecord
    try {
      session = await this.#store.resolveSession(workspace.workspace_id, null)
    } catch (error) {
      if (error instanceof ProjectStateError && error.code === 'session_not_found') return null
      throw error
    }
    return session.state === 'ready' && session.codex_thread_id !== null && await this.#rolloutAvailable(session) ? session : null
  }

  /** Exact resume authority cannot depend on the discovery catalog's UI page limit. */
  async #externalSessionAvailable(workspace: WorkspaceRecord, session: ProjectSessionRecord): Promise<boolean> {
    if (!session.executor_home || session.origin === 'nova') return true
    if (!this.#localCodexHome || !session.codex_thread_id) return false
    try {
      const home = await realpath(this.#localCodexHome)
      if (home !== session.executor_home) return false
      return (await readLocalCodexSessions(home, session.codex_thread_id)).some(item => item.cwd === workspace.canonical_path)
    } catch { return false }
  }

  async #rolloutAvailable(session: ProjectSessionRecord): Promise<boolean> {
    if (session.executor_home && session.codex_thread_id
      && await localRolloutAvailable(session.executor_home, session.codex_thread_id) === false) {
      await this.#store.markSessionUnavailable(session.session_id, {wait: true})
      return false
    }
    return true
  }

  observeProjectView(observer: ProjectViewObserver): () => void {
    this.#projectViewObservers.add(observer)
    return () => { this.#projectViewObservers.delete(observer) }
  }

  observeProjectContext(observer: ProjectContextObserver): () => void {
    this.#projectContextObservers.add(observer)
    return () => { this.#projectContextObservers.delete(observer) }
  }

  async dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    const privateValue = consumeHostExecutorCapability(context)
    if (privateValue !== undefined) {
      if (
        op !== 'run'
        || Object.keys(request).length !== 1
        || typeof request.work_order !== 'string'
      ) return failureHandoff('invalid_operation', op)
      const binding = this.#confirmedBindings.get(privateValue)
      if (
        binding?.operation !== privateValue
        || binding.delegateId !== context.delegate.delegate_id
        || binding.originRef !== context.delegate.origin_ref
      ) return failureHandoff('confirmation_binding_mismatch', op)
      this.#confirmedBindings.delete(privateValue)
      if (this.#closed) return failureHandoff('closed', 'run')
      try {
        return await this.#runConfirmed(binding.operation, binding.workOrder, context)
      } catch (error) {
        if (error instanceof ProjectStateError) return projectProblemHandoff(error.code)
        throw error
      }
    }
    const admitted = validateCodexRequest('project', op, request)
    if (!admitted.ok) return failureHandoff(admitted.error, admitted.op)
    if (op === 'status') return await this.#status.dispatch(op, request, context)
    if (op === 'cancel') {
      const workId = String(admitted.value.work_id)
      return {
        outcome: 'ok', trust: 'trusted_system',
        content: {op: 'cancel', code: this.#cancelWork(workId) ? 'cancelled' : 'not_running', work_id: workId},
      }
    }
    if (op !== 'run' && op !== 'steer') return failureHandoff('invalid_operation', op)
    if (this.#closed) return failureHandoff('closed', op)
    let workspace: WorkspaceRecord
    try {
      workspace = await this.#store.resolveWorkspace(admitted.value.project as string | null)
    } catch (error) {
      return projectProblemHandoff(projectErrorCode(error), op)
    }
    if (op === 'steer') {
      const slot = this.#slots.get(workspace.workspace_id),live=slot?.live
      if (!slot || !live) return projectNoActiveTurn()
      const wanted=()=>this.#slots.get(workspace.workspace_id)===slot&&slot.live===live
        &&(admitted.value.work_id===undefined||admitted.value.work_id===slot.work.work_id)
        &&(admitted.value.session_id===undefined||admitted.value.session_id===this.#taskWorkspaces.get(slot.work.work_id)?.session_id)
      if(!wanted())return failureHandoff('superseded',op)
      return await live.dispatch(op, {instruction: String(admitted.value.instruction)}, {...context,beforeWrite:()=>{context.beforeWrite?.();if(!wanted())throw Error('superseded')}})
    }
    return await this.#dispatchRun(workspace, admitted.value as unknown as ProjectRunInput, context)
  }

  /** Public `run` (spec 08): `latest` resumes the active ready session, otherwise a new titled thread. */
  async #dispatchRun(
    workspace: WorkspaceRecord,
    input: ProjectRunInput,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    let resumed: ProjectSessionRecord | null = null
    try {
      if (input.session_id) {
        resumed = (await this.#store.listSessions(workspace)).find(item => item.session_id === input.session_id && item.state === 'ready') ?? null
        if (resumed === null) return failureHandoff('resume_unavailable', 'run')
      } else if (input.session === 'latest') resumed = await this.#latestReadySession(workspace)
    } catch (error) {
      return projectProblemHandoff(projectErrorCode(error))
    }
    const title = resumed?.display_title ?? input.title ?? deriveSessionTitle(input.work_order)
    return await this.#runInSlot(workspace, title, context, (slot, runContext) =>
      this.#runBound(slot, workspace, resumed, title, input.work_order, runContext))
  }

  /**
   * Own one run slot for the workspace: a second run on a live slot is `busy_project`, the global cap
   * is `capacity`. The slot's controller is the one `cancel` aborts; the runtime signal chains into it.
   */
  async #runInSlot(
    workspace: WorkspaceRecord,
    title: string,
    context: ExecutorDispatchContext,
    run: (slot: RunSlot, runContext: ExecutorDispatchContext) => Promise<ExecutorHandoff>,
  ): Promise<ExecutorHandoff> {
    if (this.#closed) return failureHandoff('closed', 'run')
    if(this.#resourceKeys===null)return failureHandoff('computer_resource_unavailable','run')
    const busy=()=>this.#slots.has(workspace.workspace_id)?'busy_project':this.#slots.size>=MAX_CONCURRENT_WORK?'capacity':null
    if(!context.resourceWaiting&&busy()){const existing=this.#slots.get(workspace.workspace_id);return existing?refusedRunHandoff('busy_project',{project:workspace.display_name,work_id:existing.work.work_id,title:existing.work.title}):refusedRunHandoff('capacity',{running:this.running().map(work=>({...work}))})}
    let release:(()=>void)|undefined
    if(this.#resourceKeys.length){
      if(taskResourcesBusy(this.#resourceKeys))await context.resourceWaiting?.(taskResourcesUncertain(this.#resourceKeys)?'computer_resource_uncertain':'computer_resource_busy')
      release=await acquireTaskResources(this.#resourceKeys,context.signal)
    }
    try{
      while(busy()){
        if(!context.resourceWaiting){release?.();return refusedRunHandoff(busy()!,{running:this.running().map(work=>({...work}))})}
        await context.resourceWaiting(busy())
        await new Promise<void>((resolve,reject)=>{
          const changed=()=>{if(!busy()||this.#closed){cleanup();resolve()}},abort=()=>{cleanup();reject(context.signal.reason instanceof Error?context.signal.reason:new Error('aborted'))},cleanup=()=>{this.#slotWaiters.delete(changed);context.signal.removeEventListener('abort',abort)}
          this.#slotWaiters.add(changed);context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();else changed()
        })
        if(this.#closed)throw Error('closed')
      }
      context.signal.throwIfAborted();context.beforeWrite?.()
    }catch(error){release?.();throw error}
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    if (context.signal.aborted) controller.abort()
    else context.signal.addEventListener('abort', onAbort, {once: true})
    const slot: RunSlot = {
      work: {work_id: context.delegate.delegate_id, project: workspace.display_name, title},
      controller,
      live: null,
      task: null,
      cancelled: false,
    }
    this.#slots.set(workspace.workspace_id, slot)
    if (this.#taskWorkspaces.size >= 64) {
      const oldest = [...this.#taskWorkspaces.keys()].find(id => !this.running().some(work => work.work_id === id))
      if (oldest !== undefined) this.#taskWorkspaces.delete(oldest)
    }
    this.#taskWorkspaces.set(slot.work.work_id, {workspace_id: workspace.workspace_id})
    const task = Promise.resolve().then(async()=>{await context.resourceWaiting?.(null);controller.signal.throwIfAborted();context.beforeWrite?.();return run(slot, {...context, signal: controller.signal})})
    slot.task = task
    try {
      const result=await task
      if(result.outcome==='unknown'||this.#retainedTransportCleanups.size){quarantineTaskResources(this.#resourceKeys);release=undefined}
      return result
    } catch (error) {
      if (error instanceof ProjectStateError) return projectProblemHandoff(error.code)
      quarantineTaskResources(this.#resourceKeys);release=undefined
      throw error
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      if (this.#slots.get(workspace.workspace_id) === slot) this.#slots.delete(workspace.workspace_id)
      release?.();for(const changed of this.#slotWaiters)changed()
    }
  }

  async commitConfirmed(
    operation: ConfirmedProjectOperation,
    runtimeDispatch: ProjectRuntimeDispatch,
    confirmation: ProjectConfirmationController = this.#confirmation,
  ): Promise<ProjectCommitResult> {
    if (!confirmation.ownsConfirmed(operation)) {
      return commitResult(false, 'confirmation_invalid')
    }
    if (this.#projectCommitActive) return commitResult(false, 'confirmation_in_progress')
    this.#projectCommitActive = true
    try {
      const workOrder = operation.work_order
      if (workOrder === null) {
        // Workspace-only changes have no runtime delegate admission. Claim immediately; every
        // validation or store failure after this boundary is terminal rather than retryable.
        if (!confirmation.claimConfirmed(operation)) {
          return commitResult(false, 'confirmation_invalid')
        }
        let committedWorkspace: WorkspaceRecord
        let previousWorkspace: WorkspaceRecord | null = null
        try {
          previousWorkspace = await this.activeCommittedWorkspace()
          if (operation.action === 'create') {
            await this.#store.validateManagedCreate(operation.workspace_display_name)
            committedWorkspace = await this.#store.createManaged(operation.workspace_display_name)
          } else if (operation.action === 'select' && operation.workspace_id !== null) {
            committedWorkspace = await this.#store.selectWorkspaceExact(
              operation.workspace_display_name,
              operation.workspace_id,
            )
          } else {
            return commitResult(false, 'invalid_operation')
          }
        } catch (error) {
          return commitResult(false, projectErrorCode(error))
        }
        try {
          await this.#refreshProjectContextBarrier()
        } catch (error) {
          if (operation.action === 'create') {
            await this.#store.rollbackManagedCreate(
              committedWorkspace.workspace_id, {wait: true, previousWorkspaceId: previousWorkspace?.workspace_id ?? null},
            ).catch(() => false)
          } else if (previousWorkspace !== null) {
            await this.#store.selectWorkspaceExact(
              previousWorkspace.display_name, previousWorkspace.workspace_id,
            ).catch(() => undefined)
          }
          try {
            await this.#refreshProjectContextBarrier()
          } catch (recoveryError) {
            return commitResult(false, projectErrorCode(recoveryError))
          }
          return commitResult(false, projectErrorCode(error))
        }
        return commitResult(true, 'committed')
      }
      const normalized = validateCodexRequest('project', 'run', {work_order: workOrder})
      const busy = this.#slots.size >= MAX_CONCURRENT_WORK
        || (operation.workspace_id !== null && this.#slots.has(operation.workspace_id))
      if (!normalized.ok || normalized.value.work_order !== workOrder || busy) {
        if (busy) confirmation.rollbackConfirmed(operation)
        else confirmation.rejectConfirmed(operation)
        return commitResult(false, busy ? 'busy' : 'invalid_operation')
      }
      try {
        await this.#revalidateProposal(operation)
      } catch (error) {
        confirmation.rejectConfirmed(operation)
        return commitResult(false, projectErrorCode(error))
      }
      let launchAuthorized = false
      const admission = await runtimeDispatch(
        {
          executor: 'codex',
          op: 'run',
          request: {work_order: workOrder},
          origin_ref: operation.origin_ref,
        },
        {
          kind: 'realtime_tool',
          priority: USER_PRIORITY,
          routing_class: 'user_awaited',
          origin: null,
          selected_suggestion: null,
        },
        operation,
        () => launchAuthorized,
      )
      if (!admission.accepted || admission.delegate_id === null) {
        confirmation.rollbackConfirmed(operation)
        return commitResult(false, 'runtime_rejected')
      }
      if (!confirmation.recordRuntimeAdmission(operation)) {
        return commitResult(false, 'confirmation_invalid')
      }
      if (!confirmation.claimConfirmed(operation)) {
        return commitResult(false, 'confirmation_invalid')
      }
      this.#confirmedBindings.set(operation, Object.freeze({
        operation,
        delegateId: admission.delegate_id,
        originRef: operation.origin_ref,
        workOrder,
      }))
      launchAuthorized = true
      return commitResult(true, 'accepted', admission.delegate_id)
    } finally {
      this.#projectCommitActive = false
    }
  }

  publicProjectView(pendingConfirmation: boolean): PublicProjectView {
    const available = this.#localCodexHome ? this.roster().filter(entry => entry.sessions?.length).map(entry => ({project: entry.name, titles: entry.sessions!})) : []
    const base = {
      ...this.#publicView,
      ...(available.length ? {available_sessions: available} : {}),
      roster: this.#publicView.roster.slice(0, MAX_ROSTER).map(entry => ({...entry, running: this.#runningIn(entry.name)})),
    }
    if (!pendingConfirmation) {
      return Object.freeze({
        ...base,
        pending_confirmation: false,
        pending_confirmation_busy: false,
      })
    }
    const confirmation = pendingConfirmation ? this.#confirmation.view : null
    return Object.freeze({
      ...base,
      pending_confirmation: true,
      pending_confirmation_busy: confirmation?.pending_confirmation_busy ?? false,
      ...(confirmation?.pending_confirmation_id === undefined
        ? {}
        : {pending_confirmation_id: confirmation.pending_confirmation_id}),
      pending_action: confirmation?.pending_action ?? null,
      pending_workspace_display_name: confirmation?.pending_workspace_display_name ?? null,
      pending_session_title: confirmation?.pending_session_title ?? null,
      pending_expires_in_seconds: confirmation?.pending_expires_in_seconds ?? null,
    })
  }

  publicProjectContext(pendingConfirmation: boolean): {
    readonly workspace_id: string | null
    readonly view: PublicProjectView
  } {
    return Object.freeze({
      workspace_id: this.#publicWorkspaceId,
      view: this.publicProjectView(pendingConfirmation),
    })
  }

  close(): Promise<void> {
    if (this.#catalogTimer) { clearInterval(this.#catalogTimer); this.#catalogTimer = null }
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    const work = this.#close()
    const exposed = work.catch(error => {
      if (this.#closePromise === exposed && this.#retainedTransportCleanups.size > 0) {
        this.#closePromise = null
      }
      throw error
    })
    this.#closePromise = exposed
    return exposed
  }

  async #close(): Promise<void> {
    for(const changed of this.#slotWaiters)changed()
    await this.#catalogRefresh
    const slots = [...this.#slots.values()]
    for (const slot of slots) slot.controller.abort()
    let closeFailure: Error | null = null
    try {
      await this.#status.close()
    } catch (error) {
      closeFailure = projectCloseError(error)
    }
    for (const slot of slots) {
      await slot.task?.catch(() => undefined)
      try {
        await slot.live?.close()
      } catch (error) {
        closeFailure ??= projectCloseError(error)
      }
    }
    try {
      await this.#drainRetainedTransportCleanups()
    } catch (error) {
      closeFailure ??= projectCloseError(error)
    }
    if (closeFailure !== null && this.#retainedTransportCleanups.size > 0) throw closeFailure
    await this.#store.close()
    if (closeFailure !== null) throw closeFailure
  }

  async #revalidateProposal(operation: ConfirmedProjectOperation): Promise<void> {
    if (operation.action === 'create') {
      if (operation.workspace_id !== null || operation.session_id !== null) {
        throw new ProjectStateError('workspace_boundary_changed')
      }
      await this.#store.validateManagedCreate(operation.workspace_display_name)
      return
    }
    if (operation.action === 'reuse') {
      if (operation.workspace_id === null || operation.session_id !== null) {
        throw new ProjectStateError('workspace_boundary_changed')
      }
      const workspace = await this.#store.resolveWorkspace(operation.workspace_display_name)
      if (workspace.workspace_id !== operation.workspace_id) {
        throw new ProjectStateError('workspace_boundary_changed')
      }
      await this.#store.revalidateWorkspace(workspace.workspace_id)
      return
    }
    if (operation.action !== 'resume' || operation.workspace_id === null || operation.session_id === null) {
      throw new ProjectStateError('session_workspace_mismatch')
    }
    const workspace = await this.#store.resolveWorkspace(operation.workspace_display_name)
    if (workspace.workspace_id !== operation.workspace_id) {
      throw new ProjectStateError('workspace_boundary_changed')
    }
    const session = (await this.#store.listSessions(workspace)).find(item => item.session_id === operation.session_id)
    if (
      session?.session_id !== operation.session_id
      || session.state !== 'ready'
      || session.codex_thread_id === null
    ) throw new ProjectStateError('session_unavailable')
    await this.#store.revalidateWorkspace(workspace.workspace_id)
  }

  async #runConfirmed(
    operation: ConfirmedProjectOperation,
    workOrder: string,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    const title = operation.session_title ?? deriveSessionTitle(workOrder)
    if (operation.action === 'create') {
      const previousWorkspace = await this.activeCommittedWorkspace()
      const workspace = await this.#store.createManaged(operation.workspace_display_name)
      let result: ExecutorHandoff
      try {
        result = await this.#runInSlot(workspace, title, context, (slot, runContext) =>
          this.#runBound(slot, workspace, null, title, workOrder, runContext))
      } catch (error) {
        const rolledBack = await this.#store.rollbackManagedCreate(
          workspace.workspace_id, {wait: true, previousWorkspaceId: previousWorkspace?.workspace_id ?? null},
        ).catch(() => false)
        if (rolledBack) await this.#refreshProjectContextBarrier()
        throw error
      }
      if (result.outcome !== 'ok') {
        const rolledBack = await this.#store.rollbackManagedCreate(
          workspace.workspace_id, {wait: true, previousWorkspaceId: previousWorkspace?.workspace_id ?? null},
        ).catch(() => false)
        if (rolledBack) await this.#refreshProjectContextBarrier()
      }
      return result
    }
    if (operation.action === 'reuse') {
      if (operation.workspace_id === null || operation.session_id !== null) {
        return failureHandoff('confirmation_binding_mismatch', 'run')
      }
      const workspace = await this.#store.resolveWorkspace(operation.workspace_display_name)
      if (workspace.workspace_id !== operation.workspace_id) {
        return failureHandoff('workspace_boundary_changed', 'run')
      }
      return await this.#runInSlot(workspace, title, context, (slot, runContext) =>
        this.#runBound(slot, workspace, null, title, workOrder, runContext))
    }
    if (operation.action !== 'resume' || operation.workspace_id === null || operation.session_id === null) {
      return failureHandoff('confirmation_binding_mismatch', 'run')
    }
    const workspace = await this.#store.resolveWorkspace(operation.workspace_display_name)
    if (workspace.workspace_id !== operation.workspace_id) {
      return failureHandoff('workspace_boundary_changed', 'run')
    }
    const session = (await this.#store.listSessions(workspace)).find(item => item.session_id === operation.session_id)
    if (session?.session_id !== operation.session_id || session.state !== 'ready') {
      return projectProblemHandoff('session_unavailable')
    }
    return await this.#runInSlot(workspace, session.display_title, context, (slot, runContext) =>
      this.#runBound(slot, workspace, session, session.display_title, workOrder, runContext))
  }

  /**
   * Run one work order against a workspace inside its slot. `title` names the new thread (and the
   * provisional session) when `resumed` is null; a user cancel surfaces as a `cancelled` handoff.
   */
  async #runBound(
    slot: RunSlot,
    workspace: WorkspaceRecord,
    resumed: ProjectSessionRecord | null,
    title: string,
    workOrder: string,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    try {
      await this.#drainRetainedTransportCleanups()
    } catch {
      return failureHandoff('transport_failure', 'run')
    }
    let session = resumed
    let startRollback: SessionStartRollback | null = null
    let titleUpdates = Promise.resolve()
    let reportedThreadId: string | null = null
    let bindingMismatch = false
    let result: ExecutorHandoff | null = null
    let resumeRollback: SessionResumeRollback | null = null
    const disposition: {value: ValidatedCodexDisposition | null} = {value: null}
    await this.#store.revalidateWorkspace(workspace.workspace_id)
    if (resumed !== null && !(await this.#rolloutAvailable(resumed))) return failureHandoff('resume_unavailable', 'run', 'thread_start')
    if (resumed?.executor_home && resumed.origin !== 'nova') {
      await this.#refreshLocalSessions()
      if (!await this.#externalSessionAvailable(workspace, resumed)) return failureHandoff('resume_unavailable', 'run')
    }
    let codexHome: HostCodexHome
    let canonicalHome: string | undefined
    try {
      const executorHome = resumed === null ? this.#localCodexHome : resumed.executor_home
      canonicalHome = executorHome === undefined ? undefined : await realpath(executorHome)
      if (resumed?.executor_home && canonicalHome !== resumed.executor_home) return failureHandoff('resume_unavailable', 'run')
      codexHome = canonicalHome === undefined
        ? await this.#store.persistentHome(workspace.workspace_id, {create: resumed === null})
        : hostPersistentHomeFromConfig(canonicalHome, [canonicalHome])
    } catch (error) {
      if (resumed !== null) return failureHandoff('resume_unavailable', 'run')
      throw error
    }
    let inner: CodexAppServerTransport
    try {
      if (session === null) {
        const begun = await this.#store.beginSessionForRun(workspace.workspace_id, title, canonicalHome)
        session = begun.session
        startRollback = begun.rollback
      }
      // Persistent-home setup and session persistence both cross await boundaries. Revalidate the
      // exact approved workspace again immediately before host process construction.
      let approvedWorkspace: HostWorkspace
      if (resumed === null) {
        approvedWorkspace = await this.#store.revalidateWorkspace(workspace.workspace_id)
      } else {
        const prepared = await this.#store.prepareSessionResumeForRun(
          workspace.workspace_id,
          resumed.session_id,
          resumed.codex_thread_id ?? '',
        )
        approvedWorkspace = prepared.workspace
        resumeRollback = prepared.rollback
      }
      // The provider-facing active view must observe the exact session binding before any
      // transport can run against it. This also keeps a resumed session from inheriting the
      // prior display title during the process-construction window.
      await this.#refreshProjectContextBarrier()
      inner = this.#transportFactory.create(Object.freeze({
        workspace: approvedWorkspace,
        codexHome,
        preserveHome: true,
        resumeThreadId: resumed?.codex_thread_id ?? null,
        work: slot.work,
      }))
    } catch (error) {
      if (startRollback !== null) {
        await this.#store.rollbackSessionStartForRun(
          startRollback,
          {wait: true},
        ).catch(() => false)
        await this.#refreshProjectContextBarrier()
      } else if (resumeRollback !== null) {
        await this.#store.rollbackSessionResume(
          resumeRollback,
          {wait: true},
        ).catch(() => false)
        await this.#refreshProjectContextBarrier()
      }
      if (error instanceof CodexTransportError) {
        const terminal = failureHandoff(
          error.code, 'run', failureStage(error.code, 'thread_start'),
        )
        return terminal
      }
      throw error
    }
    const sessionId = session.session_id
    this.#taskWorkspaces.set(slot.work.work_id, {workspace_id: workspace.workspace_id, session_id: sessionId})
    const transport = new ThreadObservingTransport(inner, {
      threadName: resumed === null ? title : null,
      onThreadReady: threadId => {
        if (reportedThreadId !== null && reportedThreadId !== threadId) bindingMismatch = true
        reportedThreadId ??= threadId
        if (resumed?.codex_thread_id !== undefined && resumed.codex_thread_id !== null) {
          if (threadId !== resumed.codex_thread_id) bindingMismatch = true
        }
      },
      // Codex may rename the thread; mirror it into the running work and the session title
      // (advisory: the store may still disambiguate against a sibling session).
      onThreadNamed: (threadId, name) => {
        if (threadId !== reportedThreadId || bindingMismatch) return
        titleUpdates = titleUpdates.then(async () => {
          if (!await this.#store.setSessionTitle(sessionId, name)) return
          const saved = (await this.#store.snapshot()).sessions.find(item => item.session_id === sessionId)
          if (saved) slot.work = {...slot.work, title: saved.display_title}
          await this.#refreshProjectContextBarrier()
        }).catch(() => undefined)
      },
    })
    const active = new CodexLiveAdapter(transport, undefined, {
      sharedState: this.#liveState,
      onValidatedOutcome: value => { disposition.value = value },
    })
    slot.live = active
    let sessionBound=false
    try {
      await context.bindSession?.(sessionId)
      sessionBound=true
      result = await active.dispatch('run', {work_order: workOrder}, context)
      await titleUpdates
    } catch (error) {
      if (!slot.cancelled || !(error instanceof Error && error.name === 'AbortError')) throw error
      result = {
        outcome: 'cancelled', trust: 'trusted_system',
        content: {reason: 'user_cancelled', work_id: slot.work.work_id},
      }
    } finally {
      slot.live = null
      try {
        await active.close()
      } catch {
        // Completion evidence is already terminal. Retain cleanup ownership and fence the next
        // process until the transport's retryable close path succeeds.
        this.#retainedTransportCleanups.add(transport)
      }
      if (resumed === null) {
        if (reportedThreadId !== null && !bindingMismatch) {
          try {
            await this.#store.markSessionReady(
              session.session_id,
              reportedThreadId,
              {wait: true},
            )
          } catch (error) {
            if (startRollback === null) throw new ProjectStateError('state_corrupt')
            await this.#store.rollbackSessionStartForRun(
              startRollback,
              {wait: true},
            ).catch(() => false)
            if (!(error instanceof ProjectStateError && error.code === 'state_busy')) {
              reportedThreadId = null
            }
          }
        } else {
          if (startRollback === null) throw new ProjectStateError('state_corrupt')
          await this.#store.rollbackSessionStartForRun(
            startRollback,
            {wait: true},
          ).catch(() => false)
        }
      } else if(!sessionBound&&resumeRollback!==null){
        await this.#store.rollbackSessionResume(resumeRollback,{wait:true}).catch(()=>false)
      } else if (
        bindingMismatch
        || disposition.value?.code === 'resume_unavailable'
      ) {
        await this.#store.markSessionUnavailable(
          session.session_id,
          {wait: true},
        ).catch(() => undefined)
      }
      await this.#refreshProjectViewTolerant()
    }
    const transportResult = result ?? failureHandoff('transport_failure', 'run', 'thread_start')
    const terminal = bindingMismatch
      ? failureHandoff('session_thread_mismatch', 'run', 'thread_start')
      : resumed === null && reportedThreadId === null && transportResult.outcome === 'ok'
        ? failureHandoff('thread_id_invalid', 'run', 'thread_start')
        : transportResult
    return terminal
  }

  async #loadProjectContext(): Promise<PublicProjectContext | null> {
    this.#refreshSequence += 1
    const sequence = this.#refreshSequence
    const [stored, snapshot] = await Promise.all([this.#store.publicContext(false), this.#store.snapshot()])
    if (sequence !== this.#refreshSequence) return null
    this.#publicWorkspaceId = stored.workspace_id
    this.#publicView = stored.view
    this.#snapshot = snapshot
    return Object.freeze({
      workspace_id: stored.workspace_id,
      view: this.publicProjectView(this.#confirmation.pending),
    })
  }

  async #publishAdvisoryProjectView(context: PublicProjectContext): Promise<void> {
    for (const observer of this.#projectViewObservers) {
      try { await observer(context.view) } catch { /* public rendering is advisory */ }
    }
  }

  async #refreshProjectView(): Promise<void> {
    const context = await this.#loadProjectContext()
    if (context !== null) await this.#publishAdvisoryProjectView(context)
  }

  async #refreshProjectContextBarrier(): Promise<void> {
    const context = await this.#loadProjectContext()
    if (context === null) throw new ProjectStateError('context_delivery_failed')
    await this.#publishAdvisoryProjectView(context)
    for (const observer of this.#projectContextObservers) {
      try {
        await observer(context)
      } catch {
        throw new ProjectStateError('context_delivery_failed')
      }
    }
  }

  async #refreshProjectViewTolerant(): Promise<void> {
    try {
      await this.#refreshProjectView()
    } catch (error) {
      if (!(error instanceof ProjectStateError) || error.code !== 'state_busy') throw error
      await this.#publishAdvisoryProjectView(Object.freeze({
        workspace_id: this.#publicWorkspaceId,
        view: this.publicProjectView(this.#confirmation.pending),
      }))
    }
  }

  async #drainRetainedTransportCleanups(): Promise<void> {
    let firstFailure: Error | null = null
    for (const transport of [...this.#retainedTransportCleanups]) {
      try {
        await transport.close('shutdown')
        this.#retainedTransportCleanups.delete(transport)
      } catch (error) {
        firstFailure ??= projectCloseError(error)
      }
    }
    if (firstFailure !== null) throw firstFailure
  }
}

interface ThreadObservation {
  /** Host-derived title for a NEW thread; null when resuming (Codex already owns the name). */
  readonly threadName: string | null
  readonly onThreadReady: (threadId: string) => void
  readonly onThreadNamed: (threadId: string, name: string) => void
}

class ThreadObservingTransport implements CodexAppServerTransport {
  constructor(
    readonly inner: CodexAppServerTransport,
    readonly observation: ThreadObservation,
  ) {}

  preflight(deadline: TransportDeadline): Promise<SafePreflightReport> {
    return this.inner.preflight(deadline)
  }

  prewarm(deadline: TransportDeadline): Promise<SafePreflightReport | null> {
    return this.inner.prewarm(deadline)
  }

  run(
    input: RunInput,
    observer: TransportObserver,
    deadline: TransportDeadline,
    completionDeadline?: TransportDeadline | null,
  ): Promise<TransportOutcome> {
    const {threadName, onThreadReady, onThreadNamed} = this.observation
    return this.inner.run(threadName === null ? input : {...input, threadName}, {
      ...observer,
      onThreadReady: threadId => {
        onThreadReady(threadId)
        observer.onThreadReady?.(threadId)
      },
      onThreadNamed: (threadId, name) => {
        if (name !== null) onThreadNamed(threadId, name)
        observer.onThreadNamed?.(threadId, name)
      },
    }, deadline, completionDeadline)
  }

  steer(input: SteerInput, deadline: TransportDeadline): Promise<SteerTransportResult> {
    return this.inner.steer(input, deadline)
  }

  close(reason?: 'shutdown' | 'cancel' | 'failure'): Promise<void> {
    return this.inner.close(reason)
  }
}

const NULL_TRANSPORT: CodexAppServerTransport = Object.freeze({
  preflight: (): Promise<SafePreflightReport> => Promise.reject(new Error('project transport absent')),
  prewarm: (): Promise<null> => Promise.resolve(null),
  run: (): Promise<TransportOutcome> => Promise.reject(new Error('project transport absent')),
  steer: (): Promise<SteerTransportResult> => Promise.resolve({code: 'no_active_turn', written: false}),
  close: (): Promise<void> => Promise.resolve(),
})

/** Spec 08 run refusals (`busy_project`, `capacity`): recoverable, the host re-plans. */
function refusedRunHandoff(
  code: 'busy_project' | 'capacity',
  content: Readonly<Record<string, JsonValue>>,
): ExecutorHandoff {
  return {
    outcome: 'refused',
    trust: 'trusted_system',
    content: {op: 'run', code, ...content, recoverable: true},
  }
}

const PROJECT_REFUSAL_CODES = new Set([
  'workspace_name_conflict',
  'workspace_not_found',
  'session_not_found',
  'session_unavailable',
  'workspace_name_invalid',
  'workspace_limit',
  'session_limit',
])

function projectProblemHandoff(code: string, op: 'run' | 'steer' = 'run'): ExecutorHandoff {
  if (PROJECT_REFUSAL_CODES.has(code)) {
    return {
      outcome: 'refused',
      trust: 'trusted_system',
      content: {op, code, recoverable: true},
    }
  }
  return failureHandoff(code, op)
}

function projectNoActiveTurn(): ExecutorHandoff {
  return {
    outcome: 'failed',
    trust: 'trusted_system',
    content: {op: 'steer', worker: 'codex', code: 'no_active_turn'},
  }
}

function projectErrorCode(error: unknown): string {
  return error instanceof ProjectStateError ? error.code : 'state_corrupt'
}

function projectCloseError(error: unknown): Error {
  return error instanceof Error ? error : new Error('project close failed')
}

function commitResult(
  accepted: boolean,
  code: string,
  delegateId?: string,
): ProjectCommitResult {
  return Object.freeze({accepted, code, ...(delegateId === undefined ? {} : {delegate_id: delegateId})})
}
