/** Nova's durable personal-memory boundary. No provider types or execution authority. */
export type PersonalMemoryRecallScope = 'recent' | 'any'

export interface PersonalMemoryRecallHit {
  readonly memoryId: string
  readonly text: string
  /** Empty when a backend cannot provide provenance; never invent evidence references. */
  readonly evidenceIds: readonly string[]
  readonly kind?: 'fact' | 'experience' | 'trait'
  readonly subject?: string
  readonly attributedTo?: string
  readonly attribute?: string
  readonly emotion?: string
  readonly occurredAt?: string | null
  readonly recordedAt?: string
  /** Backend-local relevance, not confidence or a score comparable across providers. */
  readonly score?: number
}

export interface PersonalMemoryRecallResult {
  readonly source: 'personal'
  /** ok requires at least one hit in either group; empty requires both groups empty. */
  readonly state: 'ok' | 'empty'
  readonly scope: PersonalMemoryRecallScope
  readonly hits: readonly PersonalMemoryRecallHit[]
  /** Optional response-adaptation context, separate from factual recall. */
  readonly contextHits?: readonly PersonalMemoryRecallHit[]
  readonly degraded: boolean
}

export interface PersonalMemoryRememberTurn {
  /** Host-issued idempotency key; repeated admission must not duplicate the source. */
  readonly sourceId: string
  readonly sessionId: string
  readonly sequence: number
  readonly text: string
  readonly occurredAt: string | null
  /** Exact already-delivered assistant text that immediately preceded this turn, if known. */
  readonly previousAssistantReply?: string
}

/** A stable, user-owned reply preference suitable for synchronous response adjustment. */
export interface PersonalMemoryReplyPreference {
  readonly id: string
  readonly text: string
  /** Stable source ids only. A provider must not expose raw evidence here. */
  readonly evidenceIds: readonly string[]
}

/**
 * A bounded cached snapshot. Its revision is provider-local and only orders snapshots from this
 * resource instance; callers must not compare it across providers or identities.
 */
export interface PersonalMemoryResponseAdaptation {
  readonly revision: number
  readonly replyPreferences: readonly PersonalMemoryReplyPreference[]
}

export interface PersonalMemoryAdmissionReceipt {
  readonly sourceId: string
  /** Stored means recoverable across restart, not extracted or immediately searchable.
   * Deleted means a tombstone prevented re-admission of this source. */
  readonly state: 'stored' | 'deleted'
}

export interface PersonalMemoryRecallPort {
  recall(query: string, options?: {
    /** Recent is a bounded candidate window; any searches the full authorized namespace. */
    readonly scope?: PersonalMemoryRecallScope
    /** Maximum hits per result group; adapters own relevance filtering. */
    readonly limit?: number
    readonly signal?: AbortSignal
  }): Promise<PersonalMemoryRecallResult>
}

/** Identity and personal namespace are fixed by the host at construction, never by the model. */
export interface PersonalMemoryResource extends PersonalMemoryRecallPort {
  open(): Promise<void>
  close(): Promise<void>
  /** Absent for read-only providers. Resolve only after durable admission, or reject. */
  readonly remember?: (turn: PersonalMemoryRememberTurn) => Promise<PersonalMemoryAdmissionReceipt>
  /** Optional explicit deletion; backend must durably tombstone before resolving. */
  readonly forget?: (sourceId: string) => Promise<PersonalMemoryAdmissionReceipt>
  /**
   * Optional synchronous cached capability for automatic reply adjustment. It never performs a
   * recall, model call, or authority-bearing operation. Available only after a successful open;
   * unavailable resources throw rather than exposing a prior identity's cached context.
   */
  readonly responseAdaptation?: () => PersonalMemoryResponseAdaptation
}

export class PersonalMemoryError extends Error {
  constructor(readonly state: 'unavailable' | 'error') {
    super(`personal_memory_${state}`)
    this.name = 'PersonalMemoryError'
  }
}
