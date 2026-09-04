/**
 * Executor-agnostic approval surface.
 *
 * An executor that needs the user to approve an operation mid-run exposes an `ApprovalController`;
 * the host owns the confirmation state machine, the desktop banner and the voice tool that resolve
 * it. Nothing here names a concrete executor: the types are the contract between the two sides.
 */

export const APPROVAL_TTL_SECONDS = 60

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline'
export type ApprovalKind = 'file_change' | 'command_execution' | 'network' | 'permissions'

export interface FileChangeDisplay {
  readonly change: 'add' | 'delete' | 'update'
  readonly path: string
  readonly move_path: string | null
}

/** Renderer-only detail. Already redacted by the executor; never forwarded to a model. */
export type ApprovalLocalDetail =
  | {
    readonly kind: 'file_change'
    readonly changes: readonly FileChangeDisplay[]
  }
  | {
    readonly kind: 'command_execution' | 'network'
    readonly command: string
    readonly cwd: string
    readonly scope?: string
  }
  | {
    readonly kind: 'permissions'
    readonly scope: string
  }

/** The running work an approval belongs to, so a person can tell which of several works is asking. */
export interface ApprovalWork {
  readonly work_id: string
  readonly project: string
  readonly title: string
}

/**
 * The head of the approval FIFO (spec 08): exactly one approval is voice-visible at a time; later
 * approvals from other running works are queued, keep their executor request open, and get a full TTL
 * once they become head.
 */
export interface ApprovalView {
  readonly pending_approval: boolean
  readonly pending_approval_busy: boolean
  readonly pending_approval_id?: string
  readonly kind: ApprovalKind | null
  readonly local_detail: ApprovalLocalDetail | null
  readonly operation_summary: string | null
  readonly expires_at: number | null
  readonly allowed_decisions?: readonly ApprovalDecision[]
  /** `null` for offers without work identity (ordinary/live transports). */
  readonly work: ApprovalWork | null
  /** Approvals waiting behind the head; never rendered, only counted. */
  readonly queued: number
  /** Present (true) only while the head is parked by `hold`: no countdown runs, a click still decides. */
  readonly held?: boolean
}

/** The half of an executor's approval broker that the host is allowed to touch. */
export interface ApprovalController {
  readonly view: ApprovalView
  readonly pending: boolean
  observe(observer: (view: ApprovalView) => void): () => void
  acceptDecision(input: {readonly approvalId: string; readonly decision: ApprovalDecision}): boolean
  invalidate(reason: string): boolean
  /** Park the head while something else holds the floor: its expiry timer stops, `pending` stays true. */
  hold(): boolean
  /** Un-park the head with a fresh full TTL, as if it had just become head. */
  release(): boolean
}
