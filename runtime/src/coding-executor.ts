/**
 * Port between the host and whichever executor carries the `coding` role.
 *
 * The host never names the executor. It resolves "the one adapter whose manifest lists
 * `roles: ['coding']`", then talks to it through these shapes: a resource that owns process
 * lifetime, an optional project adapter that owns workspace/session bookkeeping, and the events it
 * publishes back. Concrete executors live under `executors/<name>/` and implement these interfaces.
 */
import type {AgentDescriptor, AgentController, AgentRuntimeDispatchPort} from './agent-controller.js'
import type {IntakeOptions, IntakeEventPort} from './executors/coding/intake.js'
import type {ApprovalController} from './approval-port.js'
import type {ExecutorAdapter, ExecutorHandoff} from './causal-runtime.js'
import type {JsonValue} from './events.js'
import type {DelegateRequest, ExecutorManifest} from './ports.js'
import type {ConfirmedProjectOperation, ProjectAction, ProjectConfirmationController} from './project-confirmation.js'
import type {PublicProjectContext, PublicProjectView, WorkspaceRecord} from './project-store.js'
import type {WakeReason} from './slots.js'

/** Where a work order will run, as resolved by the project adapter for the intake FSM; `select` is a bare switch. */
export interface IntakeTarget {
  readonly workspace: string
  readonly action: ProjectAction
  readonly workspace_display_name: string
  readonly workspace_id: string | null
  readonly session_title: string | null
  readonly session_id: string | null
}

/** One running work as the coordinator, the desktop roster and `active_executor_context` name it. */
export interface RunningWork {
  /** The delegate id of the run. */
  readonly work_id: string
  readonly project: string
  readonly title: string
}

/** Coordinator input (spec 08): one roster entry per known project, ordered by `last_used_at`. */
export interface RosterEntry {
  readonly name: string
  readonly last_used_at: number
  readonly last_session_title: string | null
  readonly running: readonly Pick<RunningWork, 'work_id' | 'title'>[]
}

/** What `assess` decided about where an objective goes; `project` is a verbatim roster name (or the new name for `create`). */
export interface CoordinatorDecision {
  readonly kind: 'work' | 'switch' | 'create'
  readonly project: string | null
  readonly session: 'latest' | 'new'
}

export type ProjectResolutionCode = 'unknown_project' | 'ambiguous_project' | 'busy_project' | 'capacity'

/** Structured, never guessed: the voice model hears the code and the detail, not a stack. */
export class ProjectResolutionError extends Error {
  constructor(readonly code: ProjectResolutionCode, readonly detail: Readonly<Record<string, JsonValue>> = {}) {
    super(code)
    this.name = 'ProjectResolutionError'
  }
}

export type CancelResult =
  | {readonly code: 'cancelled'; readonly work: RunningWork}
  | {readonly code: 'not_running'}
  | {readonly code: 'ambiguous_work'; readonly running: readonly RunningWork[]}

export interface CancelContext {
  /** Same `surrogate_model` as `intake.assess`; `null` when the model could not pick one of `running`. */
  readonly resolveCancelTarget: (instruction: string, running: readonly RunningWork[]) => Promise<string | null>
  /** Re-checked after the model call, before any slot is aborted; `false` means the request was superseded. */
  readonly stillWanted?: () => boolean
}

/**
 * An executor the voice model reaches only through `dispatch` / `cancel` / `confirm` (spec 08).
 *
 * `openDispatch` from the spec is the coordinator itself — `IntakeController.open` in
 * `executors/coding/intake.ts`; the coding AgentController owns that instance and receives host callbacks for facts, proposals
 * and dispatch. The adapter side of the port is below.
 */
export interface AgentExecutor {
  /** ≤10 entries, most recently used first; `running` merged from the adapter's run slots. */
  roster(): readonly RosterEntry[]
  running(): readonly RunningWork[]
  /** Async: >1 running works with an instruction needs one `resolveCancelTarget` call. */
  cancel(instruction: string | undefined, context: CancelContext): Promise<CancelResult>
  /**
   * Deterministic and side-effect-free: exact roster-name match only; throws `ProjectResolutionError`.
   * Every change of the active project (`switch`, `work` elsewhere, `create`) is then confirmed by the
   * user through the project-confirmation FSM and committed by `commitConfirmed` (decision 2026-09-04).
   */
  resolveIntakeTarget(decision: CoordinatorDecision): Promise<IntakeTarget>
}

export interface CommittedWorkspaceEvent {
  readonly workspace: WorkspaceRecord
}

export interface TerminalWorkOrderEvent {
  readonly workspace: WorkspaceRecord
  readonly work_order: string
  readonly handoff: ExecutorHandoff
}

export type ProjectRuntimeDispatch = (
  request: DelegateRequest,
  reason: WakeReason,
  hostCapability: object,
  launchAuthorized: () => boolean,
) => {readonly accepted: boolean; readonly delegate_id: string | null}
  | Promise<{readonly accepted: boolean; readonly delegate_id: string | null}>

export interface ProjectCommitResult {
  readonly accepted: boolean
  readonly code: string
  readonly delegate_id?: string
}

/** Optional exact host action surface, independent of voice cancellation resolution. */
export interface CodingTaskPort {
  cancelTask(workId: string): 'cancelling' | 'not_running'
  taskDirectory(workId: string): Promise<string | null>
}

/** A coding executor that also owns project (workspace + session) bookkeeping. */
export interface ProjectExecutorAdapter extends ExecutorAdapter, AgentExecutor {
  readonly taskPort?: CodingTaskPort
  readonly confirmationController: ProjectConfirmationController
  initialize(): Promise<void>
  activeCommittedWorkspace(): Promise<WorkspaceRecord | null>
  observeProjectView(observer: (view: PublicProjectView) => void | Promise<void>): () => void
  observeProjectContext(observer: (context: PublicProjectContext) => void | Promise<void>): () => void
  observeCommittedWorkspace(observer: (event: CommittedWorkspaceEvent) => void | Promise<void>): () => void
  observeTerminalWorkOrder(observer: (event: TerminalWorkOrderEvent) => void | Promise<void>): () => void
  commitConfirmed(operation: ConfirmedProjectOperation, dispatch: ProjectRuntimeDispatch): Promise<ProjectCommitResult>
  publicProjectView(pendingConfirmation: boolean): PublicProjectView
  publicProjectContext(pendingConfirmation: boolean): PublicProjectContext
  close(): Promise<void>
}

/** Host-owned lifetime wrapper around a coding executor and its optional approval surface. */
export interface CodingExecutorResource {
  readonly agentDescriptor?: AgentDescriptor
  readonly agentControllerFactory?: CodingAgentControllerFactory
  readonly adapter: ExecutorAdapter
  readonly mode: 'ordinary' | 'live' | 'project'
  readonly projectView: PublicProjectView | null
  readonly approvalController: ApprovalController | null
  start(): Promise<void>
  close(): Promise<void>
}

/** The single executor carrying `role`, or `null`; throws when more than one claims it. */
export function executorWithRole(
  manifests: Iterable<ExecutorManifest>,
  role: ExecutorManifest['roles'][number],
): ExecutorManifest | null {
  const matches = [...manifests].filter(manifest => manifest.roles.includes(role))
  if (matches.length > 1) {
    throw new Error(`multiple executors with role ${role}: ${matches.map(manifest => manifest.name).join(', ')}`)
  }
  return matches[0] ?? null
}

export function executorDisplayName(manifest: Pick<ExecutorManifest, 'name' | 'display_name'>): string {
  return manifest.display_name ?? manifest.name
}

/** Composition-supplied constructor for the controller behind the sole coding role. */
export interface CodingAgentControllerFactory {
  create(context: {
    readonly channel: string
    readonly intake: IntakeOptions | undefined
    readonly dispatchPort: AgentRuntimeDispatchPort
    readonly executor: Pick<AgentExecutor, 'cancel'> | undefined
    readonly resolveCancelTarget: CancelContext['resolveCancelTarget']
  }): AgentController & {readonly intake?: IntakeEventPort | undefined}
}
