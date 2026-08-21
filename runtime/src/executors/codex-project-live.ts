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
  type PublicProjectView,
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
  readonly onProjectView?: (view: PublicProjectView) => void
}

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
  readonly #projectViewObservers = new Set<(view: PublicProjectView) => void>()
  readonly #liveState: CodexAdapterSharedState = createCodexAdapterSharedState()
  readonly #confirmedBindings = new WeakMap<object, ConfirmedDelegateBinding>()
  readonly #retainedTransportCleanups = new Set<CodexAppServerTransport>()
  #current = new CodexLiveAdapter(NULL_TRANSPORT, undefined, {sharedState: this.#liveState})
  #publicView: PublicProjectView = Object.freeze({
    workspace_display_name: null,
    session_title: null,
    pending_confirmation: false,
  })
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

  observeProjectView(observer: (view: PublicProjectView) => void): () => void {
    this.#projectViewObservers.add(observer)
    return () => { this.#projectViewObservers.delete(observer) }
  }

  async dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    const admitted = validateCodexRequest('project', op, request)
    if (!admitted.ok) return failureHandoff(admitted.error, admitted.op)
    if (op === 'project') {
      const result = await this.#dispatchProject(admitted.value, context)
      await this.#refreshProjectViewTolerant()
      return result
    }
    if (op === 'status' || op === 'steer') {
      if (op === 'steer' && !this.#runActive) return projectNoActiveTurn()
      return await this.#current.dispatch(op, request, context)
    }
    if (this.#closed) return failureHandoff('closed', op)
    const workOrder = admitted.value.work_order
    const sessionTitle = admitted.value.session
    if (
      typeof workOrder !== 'string'
      || (sessionTitle !== undefined && typeof sessionTitle !== 'string')
    ) return failureHandoff('invalid_params', op)
    const privateValue = consumeHostExecutorCapability(context)
    let confirmed: ConfirmedProjectOperation | null = null
    if (privateValue !== undefined) {
      if (typeof privateValue !== 'object' || privateValue === null) {
        return failureHandoff('confirmation_binding_mismatch', op)
      }
      const binding = this.#confirmedBindings.get(privateValue)
      if (
        binding?.operation !== privateValue
        || binding.workOrder !== workOrder
        || binding.delegateId !== context.delegate.delegate_id
        || binding.originRef !== context.delegate.origin_ref
        || sessionTitle !== undefined
      ) return failureHandoff('confirmation_binding_mismatch', op)
      this.#confirmedBindings.delete(privateValue)
      confirmed = binding.operation
    }
    if (this.#runActive) return failureHandoff('busy', 'run')
    this.#runActive = true
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    if (context.signal.aborted) controller.abort()
    else context.signal.addEventListener('abort', onAbort, {once: true})
    this.#runController = controller
    const runContext: ExecutorDispatchContext = {...context, signal: controller.signal}
    const work = confirmed !== null
      ? this.#runConfirmed(confirmed, workOrder, runContext)
      : this.#runDefault(sessionTitle ?? null, workOrder, runContext)
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
      try {
        if (operation.action === 'create') {
          await this.#store.validateManagedCreate(operation.workspace_display_name)
          await this.#store.createManaged(operation.workspace_display_name)
        } else if (operation.action === 'select' && operation.workspace_id !== null) {
          await this.#store.selectWorkspaceExact(
            operation.workspace_display_name,
            operation.workspace_id,
          )
        } else {
          return commitResult(false, 'invalid_operation')
        }
      } catch (error) {
        return commitResult(false, projectErrorCode(error))
      }
      await this.#refreshProjectViewTolerant()
      return commitResult(true, 'committed')
    }
    const normalized = validateCodexRequest('project', 'run', {work_order: workOrder})
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
        op: 'run',
        request: {work_order: workOrder},
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
    return await this.#runBound(workspace, null, sessionTitle, workOrder, context)
  }

  async #dispatchProject(
    request: Readonly<Record<string, unknown>>,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    const action = request.action
    try {
      if (action === 'list') {
        const snapshot = await this.#store.snapshot()
        return projectHandoff('listed', {
          workspaces: recent(snapshot.workspaces).map(workspace => ({
            workspace: workspace.display_name,
            active: workspace.workspace_id === snapshot.active_workspace_id,
          })),
        })
      }
      if (action === 'sessions') {
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
      if (action === 'create') {
        if (typeof request.workspace !== 'string') return failureHandoff('invalid_params', 'project')
        await this.#store.validateManagedCreate(request.workspace)
      } else {
        workspace = await this.#store.resolveWorkspace(
          typeof request.workspace === 'string' ? request.workspace : null,
        )
        if (action === 'resume') {
          session = await this.#store.resolveSession(
            workspace.workspace_id,
            typeof request.session === 'string' ? request.session : null,
          )
          if (session.state !== 'ready' || session.codex_thread_id === null) {
            throw new ProjectStateError('session_unavailable')
          }
        }
      }
      if (action !== 'create' && action !== 'select' && action !== 'resume') {
        return failureHandoff('invalid_params', 'project')
      }
      const proposal = this.#confirmation.prepare({
        action,
        workspace_display_name: workspace?.display_name ?? String(request.workspace),
        workspace_id: workspace?.workspace_id ?? null,
        session_title: session?.display_title ?? null,
        session_id: session?.session_id ?? null,
        work_order: typeof request.work_order === 'string' ? request.work_order : null,
        origin_ref: context.delegate.origin_ref,
      })
      return projectHandoff('confirmation_required', {
        action: proposal.action,
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
      const workspace = await this.#store.createManaged(operation.workspace_display_name)
      let result: ExecutorHandoff
      try {
        result = await this.#runBound(workspace, null, operation.session_title, workOrder, context)
      } catch (error) {
        await this.#store.rollbackManagedCreate(workspace.workspace_id, {wait: true}).catch(() => false)
        await this.#refreshProjectViewTolerant()
        throw error
      }
      if (result.outcome !== 'ok') {
        await this.#store.rollbackManagedCreate(workspace.workspace_id, {wait: true}).catch(() => false)
        await this.#refreshProjectViewTolerant()
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
    return await this.#runBound(workspace, session, null, workOrder, context)
  }

  async #runBound(
    workspace: WorkspaceRecord,
    resumed: ProjectSessionRecord | null,
    sessionTitle: string | null,
    workOrder: string,
    context: ExecutorDispatchContext,
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
      const approvedWorkspace = resumed === null
        ? await this.#store.revalidateWorkspace(workspace.workspace_id)
        : await this.#store.prepareSessionResume(
            workspace.workspace_id,
            resumed.session_id,
            resumed.codex_thread_id ?? '',
          )
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
    if (bindingMismatch) return failureHandoff('session_thread_mismatch', 'run')
    if (resumed === null && reportedThreadId === null) return failureHandoff('thread_id_invalid', 'run')
    return result ?? failureHandoff('transport_failure', 'run')
  }

  async #refreshProjectView(): Promise<void> {
    this.#refreshSequence += 1
    const sequence = this.#refreshSequence
    const view = await this.#store.publicView(this.#confirmation.pending)
    if (sequence !== this.#refreshSequence) return
    this.#publicView = view
    for (const observer of this.#projectViewObservers) {
      try { observer(view) } catch { /* public rendering is advisory */ }
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
