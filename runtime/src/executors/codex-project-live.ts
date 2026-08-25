import type {
  CodexAppServerTransport,
  RunInput,
  SafePreflightReport,
  SteerInput,
  SteerTransportResult,
  TransportDeadline,
  TransportObserver,
  TransportOutcome,
} from '../codex-app-server-transport.js'
import {
  CODEX_PROJECT_MANIFEST,
  validateCodexRequest,
} from '../codex-contract.js'
import {
  ProjectStateError,
  type CodexProjectStore,
  type ProjectSessionRecord,
  type PublicProjectContext,
  type PublicProjectView,
  type SessionResumeRollback,
  type WorkspaceRecord,
} from '../codex-project-store.js'
import type {HostCodexHome, HostWorkspace} from '../codex-process-owner.js'
import type {
  ExecutorAdapter,
  ExecutorDispatchContext,
  ExecutorHandoff,
} from '../causal-runtime.js'
import type {JsonValue} from '../events.js'
import {consumeHostExecutorCapability} from '../host-executor-capability.js'
import {USER_PRIORITY} from '../memory.js'
import type {DelegateRequest} from '../ports.js'
import type {
  ConfirmedProjectOperation,
  ProjectConfirmationController,
} from '../realtime/project-confirmation.js'
import type {WakeReason} from '../slots.js'
import {compareCodePoints} from '../canonical-json.js'
import {CodexLiveAdapter} from './codex-live.js'
import {
  createCodexAdapterSharedState,
  failureHandoff,
  type CodexAdapterSharedState,
  type ValidatedCodexDisposition,
} from './codex-common.js'

const MAX_PUBLIC_LISTING = 20

export interface ProjectTransportBinding {
  readonly workspace: HostWorkspace
  readonly codexHome: HostCodexHome
  readonly resumeThreadId: string | null
}

export interface ProjectTransportFactory {
  create(binding: ProjectTransportBinding): CodexAppServerTransport
}

export type ProjectRuntimeDispatch = (
  request: DelegateRequest,
  reason: WakeReason,
  hostCapability: object,
) => {
    readonly accepted: boolean
    readonly delegate_id: string | null
}

export interface ProjectCommitResult {
  readonly accepted: boolean
  readonly code: string
  readonly delegate_id?: string
}

export interface ProjectCodexAdapterOptions {
  readonly store: CodexProjectStore
  readonly confirmation: ProjectConfirmationController
  readonly transportFactory: ProjectTransportFactory
  readonly onProjectView?: ProjectViewObserver
}

export interface CommittedWorkspaceEvent {
  readonly workspace: WorkspaceRecord
}

export interface TerminalWorkOrderEvent {
  readonly workspace: WorkspaceRecord
  readonly work_order: string
  readonly handoff: ExecutorHandoff
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

export class ProjectCodexAdapter implements ExecutorAdapter {
  readonly manifest = CODEX_PROJECT_MANIFEST
  readonly #store: CodexProjectStore
  readonly #confirmation: ProjectConfirmationController
  readonly #transportFactory: ProjectTransportFactory
  readonly #projectViewObservers = new Set<ProjectViewObserver>()
  readonly #projectContextObservers = new Set<ProjectContextObserver>()
  readonly #committedWorkspaceObservers = new Set<CommittedWorkspaceObserver>()
  readonly #terminalWorkOrderObservers = new Set<TerminalWorkOrderObserver>()
  readonly #liveState: CodexAdapterSharedState = createCodexAdapterSharedState()
  readonly #confirmedBindings = new WeakMap<object, ConfirmedDelegateBinding>()
  readonly #retainedTransportCleanups = new Set<CodexAppServerTransport>()
  #current = new CodexLiveAdapter(NULL_TRANSPORT, undefined, {sharedState: this.#liveState})
  #publicView: PublicProjectView = Object.freeze({
    workspace_display_name: null,
    session_title: null,
    pending_confirmation: false,
  })
  #publicWorkspaceId: string | null = null
  #refreshSequence = 0
  #initializePromise: Promise<void> | null = null
  #runActive = false
  #runController: AbortController | null = null
  #runTask: Promise<ExecutorHandoff> | null = null
  #closed = false
  #closePromise: Promise<void> | null = null

  constructor(options: ProjectCodexAdapterOptions) {
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
        op !== 'project'
        || request.action !== 'execute_confirmed'
        || Object.keys(request).length !== 1
      ) return failureHandoff('invalid_operation', op)
      const binding = this.#confirmedBindings.get(privateValue)
      if (
        binding?.operation !== privateValue
        || binding.delegateId !== context.delegate.delegate_id
        || binding.originRef !== context.delegate.origin_ref
      ) return failureHandoff('confirmation_binding_mismatch', op)
      this.#confirmedBindings.delete(privateValue)
      return await this.#dispatchRun(binding.operation, null, binding.workOrder, context)
    }
    const admitted = validateCodexRequest('project', op, request)
    if (!admitted.ok) return failureHandoff(admitted.error, admitted.op)
    if (op === 'project') {
      if (admitted.value.action === 'start_session') {
        return await this.#dispatchRun(
          null,
          typeof admitted.value.session === 'string' ? admitted.value.session : null,
          String(admitted.value.work_order),
          context,
        )
      }
      const result = await this.#dispatchProject(admitted.value, context)
      await this.#refreshProjectViewTolerant()
      return result
    }
    if (op === 'status' || op === 'steer') {
      if (op === 'steer' && !this.#runActive) return projectNoActiveTurn()
      return await this.#current.dispatch(op, request, context)
    }
    return failureHandoff('invalid_operation', op)
  }

  async #dispatchRun(
    confirmed: ConfirmedProjectOperation | null,
    sessionTitle: string | null,
    workOrder: string,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    if (this.#closed) return failureHandoff('closed', 'project')
    if (this.#runActive) return failureHandoff('busy', 'project')
    this.#runActive = true
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    if (context.signal.aborted) controller.abort()
    else context.signal.addEventListener('abort', onAbort, {once: true})
    this.#runController = controller
    const runContext: ExecutorDispatchContext = {...context, signal: controller.signal}
    const work = confirmed !== null
      ? this.#runConfirmed(confirmed, workOrder, runContext)
      : this.#runDefault(sessionTitle, workOrder, runContext)
    this.#runTask = work
    try {
      return await work
    } catch (error) {
      if (error instanceof ProjectStateError) return failureHandoff(error.code, 'run')
      throw error
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      if (this.#runController === controller) this.#runController = null
      if (this.#runTask === work) this.#runTask = null
      this.#runActive = false
    }
  }

  async commitConfirmed(
    operation: ConfirmedProjectOperation,
    originRef: string,
    runtimeDispatch: ProjectRuntimeDispatch,
  ): Promise<ProjectCommitResult> {
    if (!this.#confirmation.claimConfirmed(operation)) return commitResult(false, 'confirmation_invalid')
    const workOrder = operation.work_order
    if (workOrder === null) {
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
          const rolledBack = await this.#store.rollbackManagedCreate(
            committedWorkspace.workspace_id, {wait: true},
          ).catch(() => false)
          if (rolledBack && previousWorkspace !== null) {
            await this.#store.selectWorkspaceExact(
              previousWorkspace.display_name, previousWorkspace.workspace_id,
            ).catch(() => undefined)
          }
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
    const normalized = validateCodexRequest('project', 'project', {
      action: 'start_session', work_order: workOrder,
    })
    if (!normalized.ok || normalized.value.work_order !== workOrder || this.#runActive) {
      return commitResult(false, this.#runActive ? 'busy' : 'invalid_operation')
    }
    try {
      await this.#revalidateProposal(operation)
    } catch (error) {
      return commitResult(false, projectErrorCode(error))
    }
    const admission = runtimeDispatch(
      {
        executor: 'codex',
        op: 'project',
        request: {action: 'execute_confirmed'},
        origin_ref: originRef,
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
      return commitResult(false, 'runtime_rejected')
    }
    this.#confirmedBindings.set(operation, Object.freeze({
      operation,
      delegateId: admission.delegate_id,
      originRef,
      workOrder,
    }))
    return commitResult(true, 'accepted', admission.delegate_id)
  }

  publicProjectView(pendingConfirmation: boolean): PublicProjectView {
    return Object.freeze({...this.#publicView, pending_confirmation: pendingConfirmation})
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
    this.#runController?.abort()
    const initial = this.#current
    let closeFailure: Error | null = null
    try {
      await initial.close()
    } catch (error) {
      closeFailure = projectCloseError(error)
    }
    await this.#runTask?.catch(() => undefined)
    if (this.#current !== initial) {
      try {
        await this.#current.close()
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

  async #runDefault(
    sessionTitle: string | null,
    workOrder: string,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    const workspace = await this.#store.resolveWorkspace(null)
    return await this.#runBound(workspace, null, sessionTitle, workOrder, context, false)
  }

  async #dispatchProject(
    request: Readonly<Record<string, unknown>>,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    const action = request.action
    try {
      if (action === 'list_workspaces') {
        const snapshot = await this.#store.snapshot()
        return projectHandoff('listed', {
          workspaces: recent(snapshot.workspaces).map(workspace => ({
            workspace: workspace.display_name,
            active: workspace.workspace_id === snapshot.active_workspace_id,
          })),
        })
      }
      if (action === 'list_sessions') {
        const workspace = await this.#store.resolveWorkspace(
          typeof request.workspace === 'string' ? request.workspace : null,
        )
        const sessions = await this.#store.listSessions(workspace)
        return projectHandoff('sessions_listed', {
          workspace: workspace.display_name,
          sessions: recent(sessions).map(session => ({
            session: session.display_title,
            state: session.state,
            active: session.session_id === workspace.active_session_id,
          })),
        })
      }
      let workspace: WorkspaceRecord | null = null
      let session: ProjectSessionRecord | null = null
      if (action === 'create_workspace') {
        if (typeof request.workspace !== 'string') return failureHandoff('invalid_params', 'project')
        await this.#store.validateManagedCreate(request.workspace)
      } else {
        workspace = await this.#store.resolveWorkspace(
          typeof request.workspace === 'string' ? request.workspace : null,
        )
        if (action === 'resume_session') {
          session = await this.#store.resolveSession(
            workspace.workspace_id,
            typeof request.session === 'string' ? request.session : null,
          )
          if (session.state !== 'ready' || session.codex_thread_id === null) {
            throw new ProjectStateError('session_unavailable')
          }
        }
      }
      if (
        action !== 'create_workspace'
        && action !== 'select_workspace'
        && action !== 'resume_session'
      ) {
        return failureHandoff('invalid_params', 'project')
      }
      const proposal = this.#confirmation.prepare({
        action: action === 'create_workspace'
          ? 'create'
          : action === 'select_workspace' ? 'select' : 'resume',
        workspace_display_name: workspace?.display_name ?? String(request.workspace),
        workspace_id: workspace?.workspace_id ?? null,
        session_title: session?.display_title
          ?? (typeof request.session === 'string' ? request.session : null),
        session_id: session?.session_id ?? null,
        work_order: typeof request.work_order === 'string' ? request.work_order : null,
        origin_ref: context.delegate.origin_ref,
      })
      return projectHandoff('confirmation_required', {
        proposal_id: proposal.proposal_id,
        expires_at: proposal.expires_at,
        action,
        workspace: proposal.workspace_display_name,
        session: proposal.session_title,
        confirmation_prompt: proposal.confirmation_prompt,
      })
    } catch (error) {
      return await this.#lookupFailure(projectErrorCode(error))
    }
  }

  async #lookupFailure(code: string): Promise<ExecutorHandoff> {
    const content: Record<string, JsonValue> = {op: 'project', code}
    if (code === 'workspace_not_found') {
      try {
        content.candidates = recent(await this.#store.listWorkspaces()).map(item => item.display_name)
      } catch {
        content.candidates = []
      }
    }
    return {outcome: 'failed', trust: 'trusted_system', content}
  }

  async #revalidateProposal(operation: ConfirmedProjectOperation): Promise<void> {
    if (operation.action === 'create') {
      if (operation.workspace_id !== null || operation.session_id !== null) {
        throw new ProjectStateError('workspace_boundary_changed')
      }
      await this.#store.validateManagedCreate(operation.workspace_display_name)
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
    if (operation.action === 'create') {
      const previousWorkspace = await this.activeCommittedWorkspace()
      const workspace = await this.#store.createManaged(operation.workspace_display_name)
      let result: ExecutorHandoff
      try {
        result = await this.#runBound(workspace, null, operation.session_title, workOrder, context, true)
      } catch (error) {
        const rolledBack = await this.#store.rollbackManagedCreate(
          workspace.workspace_id, {wait: true},
        ).catch(() => false)
        if (rolledBack && previousWorkspace !== null) {
          await this.#store.selectWorkspaceExact(
            previousWorkspace.display_name, previousWorkspace.workspace_id,
          ).catch(() => undefined)
        }
        if (rolledBack) await this.#refreshProjectContextBarrier()
        throw error
      }
      if (result.outcome !== 'ok') {
        const rolledBack = await this.#store.rollbackManagedCreate(
          workspace.workspace_id, {wait: true},
        ).catch(() => false)
        if (rolledBack && previousWorkspace !== null) {
          await this.#store.selectWorkspaceExact(
            previousWorkspace.display_name, previousWorkspace.workspace_id,
          ).catch(() => undefined)
        }
        if (rolledBack) await this.#refreshProjectContextBarrier()
      }
      return result
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
      return failureHandoff('session_unavailable', 'run')
    }
    return await this.#runBound(workspace, session, null, workOrder, context, false)
  }

  async #runBound(
    workspace: WorkspaceRecord,
    resumed: ProjectSessionRecord | null,
    sessionTitle: string | null,
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
    let provisionalSessionId: string | null = null
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
        session = await this.#store.beginSession(workspace.workspace_id, sessionTitle)
        provisionalSessionId = session.session_id
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
      }))
    } catch (error) {
      if (provisionalSessionId !== null) {
        await this.#store.rollbackSessionStart(
          provisionalSessionId,
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
      throw error
    }
    const transport = new ThreadObservingTransport(inner, threadId => {
      if (reportedThreadId !== null && reportedThreadId !== threadId) bindingMismatch = true
      reportedThreadId ??= threadId
      if (resumed?.codex_thread_id !== undefined && resumed.codex_thread_id !== null) {
        if (threadId !== resumed.codex_thread_id) bindingMismatch = true
      }
    })
    const previous = this.#current
    const active = new CodexLiveAdapter(transport, undefined, {
      sharedState: this.#liveState,
      onValidatedOutcome: value => { disposition.value = value },
    })
    this.#current = active
    await previous.close().catch(() => undefined)
    try {
      result = await active.dispatch('run', {work_order: workOrder}, context)
    } finally {
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
          } catch {
            await this.#store.rollbackSessionStart(
              session.session_id,
              {wait: true},
            ).catch(() => false)
            reportedThreadId = null
          }
        } else {
          await this.#store.rollbackSessionStart(
            session.session_id,
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
    const terminal = bindingMismatch
      ? failureHandoff('session_thread_mismatch', 'run')
      : resumed === null && reportedThreadId === null
        ? failureHandoff('thread_id_invalid', 'run')
        : result ?? failureHandoff('transport_failure', 'run')
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
    const context = await this.#store.publicContext(this.#confirmation.pending)
    if (sequence !== this.#refreshSequence) return null
    this.#publicWorkspaceId = context.workspace_id
    this.#publicView = context.view
    return context
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

class ThreadObservingTransport implements CodexAppServerTransport {
  constructor(
    readonly inner: CodexAppServerTransport,
    readonly observeThread: (threadId: string) => void,
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
    return this.inner.run(input, {
      ...observer,
      onThreadReady: threadId => {
        this.observeThread(threadId)
        observer.onThreadReady?.(threadId)
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

function recent<T extends {readonly last_used_at: number; readonly created_at: number}>(
  items: readonly T[],
): readonly T[] {
  return [...items].sort((left, right) =>
    right.last_used_at - left.last_used_at
    || left.created_at - right.created_at
    || compareCodePoints(JSON.stringify(left), JSON.stringify(right)),
  ).slice(0, MAX_PUBLIC_LISTING)
}

function projectHandoff(code: string, content: Readonly<Record<string, JsonValue>>): ExecutorHandoff {
  return {outcome: 'ok', trust: 'trusted_system', content: {op: 'project', code, ...content}}
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
