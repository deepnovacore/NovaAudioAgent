import {hostWorkspacePath} from '../../host-paths.js'
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
} from '../../project-store.js'
import type {HostCodexHome, HostWorkspace} from './process-owner.js'
import type {
  ExecutorDispatchContext,
  ExecutorHandoff,
} from '../../causal-runtime.js'
import type {JsonValue} from '../../events.js'
import {consumeHostExecutorCapability} from '../../host-executor-capability.js'
import {USER_PRIORITY} from '../../memory.js'
import type {ApprovalWork} from '../../approval-port.js'
import type {CodexApprovalController} from './approval.js'
import {
  ProjectResolutionError,
  type CancelContext,
  type CancelResult,
  type CommittedWorkspaceEvent,
  type CoordinatorDecision,
  type IntakeTarget,
  type ProjectCommitResult,
  type ProjectExecutorAdapter,
  type ProjectRuntimeDispatch,
  type RosterEntry,
  type RunningWork,
  type TerminalWorkOrderEvent,
} from '../../coding-executor.js'
import type {
  ConfirmedProjectOperation,
  ProjectConfirmationController,
} from '../../project-confirmation.js'
import {MAX_CONCURRENT_WORK, deriveSessionTitle} from '../../work-tools.js'
import {CodexLiveAdapter} from './adapter-live.js'
import {
  createCodexAdapterSharedState,
  failureHandoff,
  failureStage,
  type CodexAdapterSharedState,
  type ValidatedCodexDisposition,
} from './common.js'

/** Coordinator input is bounded (spec 08): ≤10 roster rows, most recently used first. */
const MAX_ROSTER = 10

export interface ProjectTransportBinding {
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
  readonly work_order: string
  readonly project: string | null
  readonly session: 'latest' | 'new'
  readonly title?: string
}

export interface ProjectTransportFactory {
  create(binding: ProjectTransportBinding): CodexAppServerTransport
}

export type {CommittedWorkspaceEvent, ProjectCommitResult, ProjectRuntimeDispatch, TerminalWorkOrderEvent}

export interface ProjectCodexAdapterOptions {
  readonly store: ProjectStore
  readonly confirmation: ProjectConfirmationController
  readonly transportFactory: ProjectTransportFactory
  readonly codexApproval?: CodexApprovalController
  readonly onProjectView?: ProjectViewObserver
}

type CommittedWorkspaceObserver = (event: CommittedWorkspaceEvent) => void | Promise<void>
type TerminalWorkOrderObserver = (event: TerminalWorkOrderEvent) => void | Promise<void>
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
  readonly #store: ProjectStore
  readonly #confirmation: ProjectConfirmationController
  readonly #transportFactory: ProjectTransportFactory
  readonly #projectViewObservers = new Set<ProjectViewObserver>()
  readonly #projectContextObservers = new Set<ProjectContextObserver>()
  readonly #committedWorkspaceObservers = new Set<CommittedWorkspaceObserver>()
  readonly #terminalWorkOrderObservers = new Set<TerminalWorkOrderObserver>()
  // ponytail: one status snapshot shared by every run's live adapter, so `status` reports the last
  // run that touched it; per-slot status is the upgrade path once the host asks for it.
  readonly #liveState: CodexAdapterSharedState = createCodexAdapterSharedState()
  readonly #status = new CodexLiveAdapter(NULL_TRANSPORT, undefined, {sharedState: this.#liveState})
  readonly #confirmedBindings = new WeakMap<object, ConfirmedDelegateBinding>()
  readonly #retainedTransportCleanups = new Set<CodexAppServerTransport>()
  readonly #slots = new Map<string, RunSlot>()
  readonly #taskWorkspaces = new Map<string, string>()
  readonly taskPort = {
    cancelTask: (workId: string): 'cancelling' | 'not_running' => this.#cancelWork(workId) ? 'cancelling' : 'not_running',
    taskDirectory: async (workId: string): Promise<string | null> => {
      const workspaceId = this.#taskWorkspaces.get(workId)
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
    const work = this.#refreshProjectViewTolerant()
    this.#initializePromise = work
    return work
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
  async resolveIntakeTarget(decision: CoordinatorDecision): Promise<IntakeTarget> {
    if (decision.kind === 'create') {
      const name = await this.#store.validateManagedCreate(decision.project ?? '')
      return {
        workspace: name, action: 'create', workspace_display_name: name, workspace_id: null,
        session_title: null, session_id: null,
      }
    }
    const workspace = await this.#resolveProject(decision.project)
    if (decision.kind === 'work') {
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
    const session = decision.kind === 'work' && decision.session === 'latest' ? await this.#latestReadySession(workspace) : null
    return {
      workspace: workspace.canonical_path,
      action: decision.kind === 'switch' ? 'select' : session === null ? 'reuse' : 'resume',
      workspace_display_name: workspace.display_name, workspace_id: workspace.workspace_id,
      session_title: session?.display_title ?? null, session_id: session?.session_id ?? null,
    }
  }

  roster(): readonly RosterEntry[] {
    const snapshot = this.#snapshot
    return this.#publicView.roster.slice(0, MAX_ROSTER).map(entry => {
      const workspace = snapshot?.workspaces.find(record => record.display_name === entry.name)
      const session = snapshot?.sessions.find(record => record.session_id === workspace?.active_session_id)
      return {
        name: entry.name,
        last_used_at: entry.last_used_at,
        last_session_title: session?.display_title ?? null,
        running: this.#runningIn(entry.name),
      }
    })
  }

  running(): readonly RunningWork[] {
    return [...this.#slots.values()].map(slot => slot.work)
  }

  /** 0 → not_running; 1 → cancel it (no model call); >1 → one `resolveCancelTarget` call, else ambiguous. */
  async cancel(instruction: string | undefined, context: CancelContext): Promise<CancelResult> {
    const running = this.running()
    if (running.length === 0) return {code: 'not_running'}
    let target = running.length === 1 ? running[0] : undefined
    if (target === undefined && instruction !== undefined && instruction !== '') {
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
    if (workspace.active_session_id === null) return null
    let session: ProjectSessionRecord
    try {
      session = await this.#store.resolveSession(workspace.workspace_id, null)
    } catch (error) {
      if (error instanceof ProjectStateError && error.code === 'session_not_found') return null
      throw error
    }
    return session.state === 'ready' && session.codex_thread_id !== null ? session : null
  }

  observeProjectView(observer: ProjectViewObserver): () => void {
    this.#projectViewObservers.add(observer)
    return () => { this.#projectViewObservers.delete(observer) }
  }

  observeProjectContext(observer: ProjectContextObserver): () => void {
    this.#projectContextObservers.add(observer)
    return () => { this.#projectContextObservers.delete(observer) }
  }

  observeCommittedWorkspace(observer: CommittedWorkspaceObserver): () => void {
    this.#committedWorkspaceObservers.add(observer)
    return () => { this.#committedWorkspaceObservers.delete(observer) }
  }

  observeTerminalWorkOrder(observer: TerminalWorkOrderObserver): () => void {
    this.#terminalWorkOrderObservers.add(observer)
    return () => { this.#terminalWorkOrderObservers.delete(observer) }
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
      const live = this.#slots.get(workspace.workspace_id)?.live
      if (live === undefined || live === null) return projectNoActiveTurn()
      return await live.dispatch(op, {instruction: String(admitted.value.instruction)}, context)
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
      if (input.session === 'latest') resumed = await this.#latestReadySession(workspace)
    } catch (error) {
      return projectProblemHandoff(projectErrorCode(error))
    }
    const title = resumed?.display_title ?? input.title ?? deriveSessionTitle(input.work_order)
    return await this.#runInSlot(workspace, title, context, (slot, runContext) =>
      this.#runBound(slot, workspace, resumed, title, input.work_order, runContext, false))
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
    const existing = this.#slots.get(workspace.workspace_id)
    if (existing !== undefined) {
      return refusedRunHandoff('busy_project', {
        project: workspace.display_name, work_id: existing.work.work_id, title: existing.work.title,
      })
    }
    if (this.#slots.size >= MAX_CONCURRENT_WORK) {
      return refusedRunHandoff('capacity', {running: this.running().map(work => ({...work}))})
    }
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
    this.#taskWorkspaces.set(slot.work.work_id, workspace.workspace_id)
    const task = run(slot, {...context, signal: controller.signal})
    slot.task = task
    try {
      return await task
    } catch (error) {
      if (error instanceof ProjectStateError) return projectProblemHandoff(error.code)
      throw error
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      if (this.#slots.get(workspace.workspace_id) === slot) this.#slots.delete(workspace.workspace_id)
    }
  }

  async commitConfirmed(
    operation: ConfirmedProjectOperation,
    runtimeDispatch: ProjectRuntimeDispatch,
  ): Promise<ProjectCommitResult> {
    if (!this.#confirmation.ownsConfirmed(operation)) {
      return commitResult(false, 'confirmation_invalid')
    }
    if (this.#projectCommitActive) return commitResult(false, 'confirmation_in_progress')
    this.#projectCommitActive = true
    try {
      const workOrder = operation.work_order
      if (workOrder === null) {
        // Workspace-only changes have no runtime delegate admission. Claim immediately; every
        // validation or store failure after this boundary is terminal rather than retryable.
        if (!this.#confirmation.claimConfirmed(operation)) {
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
        await this.#notifyCommittedWorkspace(committedWorkspace)
        return commitResult(true, 'committed')
      }
      const normalized = validateCodexRequest('project', 'run', {work_order: workOrder})
      const busy = this.#slots.size >= MAX_CONCURRENT_WORK
        || (operation.workspace_id !== null && this.#slots.has(operation.workspace_id))
      if (!normalized.ok || normalized.value.work_order !== workOrder || busy) {
        if (busy) this.#confirmation.rollbackConfirmed(operation)
        else this.#confirmation.rejectConfirmed(operation)
        return commitResult(false, busy ? 'busy' : 'invalid_operation')
      }
      try {
        await this.#revalidateProposal(operation)
      } catch (error) {
        this.#confirmation.rejectConfirmed(operation)
        return commitResult(false, projectErrorCode(error))
      }
      const admission = runtimeDispatch(
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
      )
      if (!admission.accepted || admission.delegate_id === null) {
        this.#confirmation.rollbackConfirmed(operation)
        return commitResult(false, 'runtime_rejected')
      }
      if (!this.#confirmation.recordRuntimeAdmission(operation)) {
        return commitResult(false, 'confirmation_invalid')
      }
      if (!this.#confirmation.claimConfirmed(operation)) {
        return commitResult(false, 'confirmation_invalid')
      }
      this.#confirmedBindings.set(operation, Object.freeze({
        operation,
        delegateId: admission.delegate_id,
        originRef: operation.origin_ref,
        workOrder,
      }))
      return commitResult(true, 'accepted', admission.delegate_id)
    } finally {
      this.#projectCommitActive = false
    }
  }

  publicProjectView(pendingConfirmation: boolean): PublicProjectView {
    const base = {
      ...this.#publicView,
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
    const session = await this.#store.resolveSession(workspace.workspace_id, operation.session_title)
    if (
      session.session_id !== operation.session_id
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
          this.#runBound(slot, workspace, null, title, workOrder, runContext, true))
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
        this.#runBound(slot, workspace, null, title, workOrder, runContext, false))
    }
    if (operation.action !== 'resume' || operation.workspace_id === null || operation.session_id === null) {
      return failureHandoff('confirmation_binding_mismatch', 'run')
    }
    const workspace = await this.#store.resolveWorkspace(operation.workspace_display_name)
    if (workspace.workspace_id !== operation.workspace_id) {
      return failureHandoff('workspace_boundary_changed', 'run')
    }
    const session = await this.#store.resolveSession(workspace.workspace_id, operation.session_title)
    if (session.session_id !== operation.session_id || session.state !== 'ready') {
      return projectProblemHandoff('session_unavailable')
    }
    return await this.#runInSlot(workspace, session.display_title, context, (slot, runContext) =>
      this.#runBound(slot, workspace, session, session.display_title, workOrder, runContext, false))
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
    deferWorkspaceObservation: boolean,
  ): Promise<ExecutorHandoff> {
    try {
      await this.#drainRetainedTransportCleanups()
    } catch {
      return failureHandoff('transport_failure', 'run')
    }
    let session = resumed
    let startRollback: SessionStartRollback | null = null
    let reportedThreadId: string | null = null
    let bindingMismatch = false
    let result: ExecutorHandoff | null = null
    let resumeRollback: SessionResumeRollback | null = null
    const disposition: {value: ValidatedCodexDisposition | null} = {value: null}
    await this.#store.revalidateWorkspace(workspace.workspace_id)
    const codexHome = await this.#store.persistentHome(workspace.workspace_id)
    let inner: CodexAppServerTransport
    try {
      if (session === null) {
        const begun = await this.#store.beginSessionForRun(workspace.workspace_id, title)
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
      if (!deferWorkspaceObservation) await this.#notifyCommittedWorkspace(workspace)
      inner = this.#transportFactory.create(Object.freeze({
        workspace: approvedWorkspace,
        codexHome,
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
        await this.#notifyTerminalWorkOrder(workspace, workOrder, terminal)
        return terminal
      }
      throw error
    }
    const sessionId = session.session_id
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
      onThreadNamed: name => {
        slot.work = {...slot.work, title: name}
        void this.#store.setSessionTitle(sessionId, name).catch(() => false)
      },
    })
    const active = new CodexLiveAdapter(transport, undefined, {
      sharedState: this.#liveState,
      onValidatedOutcome: value => { disposition.value = value },
    })
    slot.live = active
    try {
      result = await active.dispatch('run', {work_order: workOrder}, context)
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
    if (deferWorkspaceObservation && terminal.outcome === 'ok') {
      await this.#notifyCommittedWorkspace(workspace)
    }
    await this.#notifyTerminalWorkOrder(workspace, workOrder, terminal)
    return terminal
  }

  async #notifyCommittedWorkspace(workspace: WorkspaceRecord): Promise<void> {
    const event = Object.freeze({workspace})
    for (const observer of [...this.#committedWorkspaceObservers]) {
      try {
        await observer(event)
      } catch {
        // Graph/telemetry observers cannot change an authoritative project outcome.
      }
    }
  }

  async #notifyTerminalWorkOrder(
    workspace: WorkspaceRecord,
    workOrder: string,
    handoff: ExecutorHandoff,
  ): Promise<void> {
    const event = Object.freeze({workspace, work_order: workOrder, handoff})
    for (const observer of [...this.#terminalWorkOrderObservers]) {
      try {
        await observer(event)
      } catch {
        // Episode projection is best-effort and cannot change executor delivery.
      }
    }
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
  readonly onThreadNamed: (name: string) => void
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
  ): Promise<TransportOutcome> {
    const {threadName, onThreadReady, onThreadNamed} = this.observation
    return this.inner.run(threadName === null ? input : {...input, threadName}, {
      ...observer,
      onThreadReady: threadId => {
        onThreadReady(threadId)
        observer.onThreadReady?.(threadId)
      },
      onThreadNamed: (threadId, name) => {
        if (name !== null) onThreadNamed(name)
        observer.onThreadNamed?.(threadId, name)
      },
    }, deadline)
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
