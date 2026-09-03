/**
 * Port between the host and whichever executor carries the `coding` role.
 *
 * The host never names the executor. It resolves "the one adapter whose manifest lists
 * `roles: ['coding']`", then talks to it through these shapes: a resource that owns process
 * lifetime, an optional project adapter that owns workspace/session bookkeeping, and the events it
 * publishes back. Concrete executors live under `executors/<name>/` and implement these interfaces.
 */
import type {ApprovalController} from './approval-port.js'
import type {ExecutorAdapter, ExecutorHandoff} from './causal-runtime.js'
import type {JsonValue} from './events.js'
import type {DelegateRequest, ExecutorManifest} from './ports.js'
import type {ConfirmedProjectOperation, ProjectConfirmationController} from './project-confirmation.js'
import type {PublicProjectContext, PublicProjectView, WorkspaceRecord} from './project-store.js'
import type {WakeReason} from './slots.js'

/** Where a work order will run, as resolved by the project adapter for the intake FSM. */
export interface IntakeTarget {
  readonly workspace: string
  readonly action: 'create' | 'reuse' | 'resume'
  readonly workspace_display_name: string
  readonly workspace_id: string | null
  readonly session_title: string | null
  readonly session_id: string | null
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
) => {
  readonly accepted: boolean
  readonly delegate_id: string | null
}

export interface ProjectCommitResult {
  readonly accepted: boolean
  readonly code: string
  readonly delegate_id?: string
}

/** A coding executor that also owns project (workspace + session) bookkeeping. */
export interface ProjectExecutorAdapter extends ExecutorAdapter {
  readonly confirmationController: ProjectConfirmationController
  initialize(): Promise<void>
  activeCommittedWorkspace(): Promise<WorkspaceRecord | null>
  resolveIntakeTarget(request: Readonly<Record<string, JsonValue>>): Promise<IntakeTarget>
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
