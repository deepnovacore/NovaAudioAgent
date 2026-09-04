import type {JsonValue} from '../../events.js'
import type {ModelGateway} from '../../model-gateway.js'
import {
  assessVision,
  VISION_ASSESS_SYSTEM,
  VisionMonitorMachine,
  type VisionAssessContext,
  type VisionIdentity,
} from '../../vision-assess.js'

export const VISION_AGENT_DESCRIPTOR = Object.freeze({
  name: 'vision',
  summary: 'Monitors the camera for a bounded visual condition.',
  ownedChannels: Object.freeze(['watch', 'guard']),
})

export type VisionChannel = 'watch' | 'guard'
export type VisionStartRequest = Readonly<{
  condition: string
  interval_s: number
  duration_s: number
}>

export interface VisionRuntimeOpPort {
  dispatch(request: {
    readonly channel: VisionChannel
    readonly op: 'start' | 'stop'
    readonly request: Readonly<Record<string, JsonValue>>
    readonly origin_ref: string
    readonly stillWanted: () => boolean
  }): {readonly accepted: boolean; readonly delegate_id: string | null}
}

/** Host-private correlation between a runtime delegate and this controller's monitor identity. */
export interface VisionLifecycleSink {
  bind(delegateId: string, identity: VisionIdentity): void
}

export interface VisionControllerDispatchRequest {
  readonly instruction: string
  readonly originalUserText: string
  readonly origin_ref: string
  readonly sessionEpoch: number
  readonly acceptedUserInputRevision: number
  readonly stillWanted: () => boolean
  readonly currentRequestId?: () => string
  readonly currentRevision?: () => number
  readonly currentSessionEpoch?: () => number
}

export interface VisionControllerCancelRequest {
  readonly origin_ref?: string
  readonly stillWanted: () => boolean
}

export type VisionControllerResult =
  | {
    readonly code: 'delegated'
    readonly accepted: true
    readonly delegate_id: string
    readonly detail: {readonly channel: VisionChannel; readonly op: 'start'}
  }
  | {
    readonly code: 'cancelled' | 'requested_stop'
    readonly accepted: true
    readonly detail: {readonly channel: VisionChannel; readonly op: 'stop'}
  }
  | {
    readonly code: 'not_running' | 'busy' | 'unclear' | 'superseded' | 'runtime_rejected' | 'assessment_unavailable'
    readonly accepted: boolean
    readonly detail: Readonly<Record<string, never>> | {readonly reason: 'assessment_unclear'}
  }

export type VisionControllerResultCode = VisionControllerResult['code']

const EMPTY_DETAIL: Readonly<Record<string, never>> = Object.freeze({})
const VISION_STRING_LIMIT = 2_000
const DEFAULT_ASSESSMENT_TIMEOUT_MS = 5_000
const HOST_IDENTIFIER_LIMIT = 128

interface RuntimeAdmission {
  readonly accepted: boolean
  readonly delegate_id: string | null
}

interface ActiveVisionReservation {
  readonly identity: VisionIdentity
  readonly channel: VisionChannel
  readonly origin_ref: string
  readonly stillWanted: () => boolean
  readonly fence: () => boolean
  delegate_id: string
  stopAccepted: boolean
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/** JSON Schema sent to the assess model. Keep this in lockstep with visionAssessSchema. */
export const VISION_ASSESS_JSON_SCHEMA: Readonly<Record<string, JsonValue>> = deepFreeze({
  type: 'object',
  properties: {
    request_id: {type: 'string', minLength: 1, maxLength: 128},
    revision: {type: 'integer', minimum: 0},
    kind: {type: 'string', enum: ['monitor', 'stop', 'unclear']},
    condition: {type: ['string', 'null'], maxLength: 300},
    urgency: {type: ['string', 'null'], enum: ['routine', 'urgent', null]},
    urgency_evidence: {type: ['string', 'null'], maxLength: 300},
    interval_s: {type: ['number', 'null']},
    duration_s: {type: ['number', 'null']},
    question: {type: ['string', 'null'], maxLength: 300},
  },
  required: [
    'request_id', 'revision', 'kind', 'condition', 'urgency', 'urgency_evidence',
    'interval_s', 'duration_s', 'question',
  ],
  additionalProperties: false,
})

function emptyResult(code: Extract<VisionControllerResultCode,
  'not_running' | 'busy' | 'superseded' | 'runtime_rejected' | 'assessment_unavailable'>): VisionControllerResult {
  return Object.freeze({code, accepted: code === 'not_running' || code === 'busy' ? true : false, detail: EMPTY_DETAIL})
}

function unclearResult(): VisionControllerResult {
  return Object.freeze({
    code: 'unclear', accepted: true,
    detail: Object.freeze({reason: 'assessment_unclear' as const}),
  })
}

function promptFor(identity: VisionIdentity, request: VisionControllerDispatchRequest): string {
  // JSON keeps the model-facing fields explicit while the per-field bounds prevent a user utterance
  // from turning the assess slot into an unbounded context sink.
  return JSON.stringify({
    request_id: identity.request_id,
    revision: identity.revision,
    accepted_revision: identity.revision,
    original_user_text: request.originalUserText.slice(0, VISION_STRING_LIMIT),
    instruction: request.instruction.slice(0, VISION_STRING_LIMIT),
  })
}

function sameIdentity(left: VisionIdentity, right: VisionIdentity): boolean {
  return left.request_id === right.request_id
    && left.revision === right.revision
    && left.session_epoch === right.session_epoch
}

function safeWanted(fn: () => boolean): boolean {
  try { return fn() === true } catch { return false }
}

/** Copy exactly the tiny runtime admission result; never retain a provider-owned object. */
function parseRuntimeAdmission(value: unknown): RuntimeAdmission | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype: object | null = Object.getPrototypeOf(value) as object | null
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== 2 || !keys.includes('accepted') || !keys.includes('delegate_id')) return null
    for (const key of keys) {
      if (typeof key !== 'string') return null
      const descriptor = descriptors[key]
      if (descriptor === undefined || !descriptor.enumerable
        || descriptor.get !== undefined || descriptor.set !== undefined
        || !Object.hasOwn(descriptor, 'value')) return null
    }
    const accepted: unknown = descriptors.accepted?.value as unknown
    const delegateId: unknown = descriptors.delegate_id?.value as unknown
    if (typeof accepted !== 'boolean') return null
    if (delegateId !== null && typeof delegateId !== 'string') return null
    if (typeof delegateId === 'string' && delegateId.length > HOST_IDENTIFIER_LIMIT) return null
    return {accepted, delegate_id: delegateId}
  } catch {
    return null
  }
}

/**
 * Thin Vision controller core. It owns only assessment, the one-monitor reservation, and calls to
 * the host runtime operation port. Public result wording and AgentController adaptation stay outside.
 */
export class VisionAgentControllerCore {
  readonly descriptor = VISION_AGENT_DESCRIPTOR
  readonly #gateway: ModelGateway
  readonly #model: string
  readonly #requestIdFactory: () => string
  readonly #runtimePort: VisionRuntimeOpPort
  readonly #assessmentTimeoutMs: number
  readonly #lifecycleSink: VisionLifecycleSink | undefined
  readonly #machine = new VisionMonitorMachine()
  #active: ActiveVisionReservation | null = null

  constructor(options: {
    readonly gateway: ModelGateway
    readonly watchModel?: string
    readonly model?: string
    readonly requestIdFactory?: () => string
    readonly idFactory?: () => string
    readonly runtimePort?: VisionRuntimeOpPort
    readonly runtime?: VisionRuntimeOpPort
    readonly lifecycleSink?: VisionLifecycleSink
    readonly assessmentTimeoutMs?: number
  }) {
    const model = options.watchModel ?? options.model
    const requestIdFactory = options.requestIdFactory ?? options.idFactory
    const runtimePort = options.runtimePort ?? options.runtime
    if (model === undefined || model.trim() === '') throw new TypeError('vision watch model is required')
    if (requestIdFactory === undefined) throw new TypeError('vision request id factory is required')
    if (runtimePort === undefined) throw new TypeError('vision runtime port is required')
    this.#gateway = options.gateway
    this.#model = model
    this.#requestIdFactory = requestIdFactory
    this.#runtimePort = runtimePort
    this.#assessmentTimeoutMs = options.assessmentTimeoutMs ?? DEFAULT_ASSESSMENT_TIMEOUT_MS
    this.#lifecycleSink = options.lifecycleSink
  }

  get state(): 'idle' | 'permission-pending' | 'active' | 'terminal' { return this.#machine.state }
  get identity(): VisionIdentity | null { return this.#machine.identity }

  async dispatch(request: VisionControllerDispatchRequest): Promise<VisionControllerResult> {
    if (this.#isStopInstruction(request.instruction)) return Promise.resolve(this.#stop(request, 'requested_stop'))
    if (this.#machine.state !== 'idle') return emptyResult('busy')
    if (!safeWanted(request.stillWanted)) return emptyResult('superseded')

    let identity: VisionIdentity
    try {
      identity = {
        request_id: this.#requestIdFactory(),
        revision: request.acceptedUserInputRevision,
        session_epoch: request.sessionEpoch,
      }
    } catch {
      return emptyResult('assessment_unavailable')
    }
    const context: VisionAssessContext = {
      request_id: identity.request_id,
      revision: identity.revision,
      session_epoch: identity.session_epoch,
      original_user_text: request.originalUserText,
      stillWanted: request.stillWanted,
      ...(request.currentRequestId === undefined ? {} : {current_request_id: request.currentRequestId}),
      ...(request.currentRevision === undefined ? {} : {current_revision: request.currentRevision}),
      ...(request.currentSessionEpoch === undefined ? {} : {current_session_epoch: request.currentSessionEpoch}),
    }

    const assessed = await this.#assess(identity, request)
    if (assessed === null) return emptyResult('assessment_unavailable')
    const decision = assessVision(assessed, context)
    if (decision.code === 'no_action') {
      return decision.reason === 'invalid_schema' ? emptyResult('assessment_unavailable') : unclearResult()
    }
    if (decision.code === 'superseded' || !decision.recheck()) return emptyResult('superseded')
    if (decision.code === 'unclear') return unclearResult()
    if (decision.code === 'stop') return Promise.resolve(this.#stop(request, 'requested_stop', decision.recheck))

    // This is the last fence before reserving the global slot.
    if (!decision.recheck()) return emptyResult('superseded')
    const machineReservation = this.#machine.reserve(decision.identity)
    if (machineReservation.code === 'busy') return emptyResult('busy')
    if (machineReservation.code === 'stale') return emptyResult('superseded')

    const channel: VisionChannel = decision.assessment.urgency === 'urgent' ? 'guard' : 'watch'
    // Publish the reservation before entering the port: permission callbacks can arrive reentrantly
    // from the synchronous runtime adapter and must see the pending reservation.
    const reservation = {
      identity: {...decision.identity}, channel, origin_ref: request.origin_ref,
      stillWanted: request.stillWanted, fence: decision.recheck, delegate_id: '',
      stopAccepted: false,
    }
    this.#active = reservation
    // The final pre-effect fence is intentionally after reservation: pending permission is already
    // busy, but a stale request must not even enter the runtime operation port.
    if (!decision.recheck()) {
      this.#releaseRejected(decision.identity)
      return emptyResult('superseded')
    }
    let admission: RuntimeAdmission | null
    try {
      admission = parseRuntimeAdmission(this.#runtimePort.dispatch({
        channel,
        op: 'start',
        request: {
          condition: decision.assessment.condition,
          interval_s: decision.assessment.interval_s,
          duration_s: decision.assessment.duration_s,
        },
        origin_ref: request.origin_ref,
        stillWanted: () => safeWanted(request.stillWanted) && decision.recheck(),
      }))
    } catch {
      admission = null
    }
    if (admission === null || !admission.accepted || admission.delegate_id === null || admission.delegate_id === '') {
      this.#releaseRejected(decision.identity)
      return emptyResult('runtime_rejected')
    }
    // A reentrant terminal callback may have fenced and cleaned the reservation before dispatch
    // returned. Its accepted result must not resurrect the monitor slot.
    reservation.delegate_id = admission.delegate_id
    this.#lifecycleSink?.bind(admission.delegate_id, decision.identity)
    const stateAfterAdmission: string = this.#machine.state
    const stillReserved = (stateAfterAdmission === 'permission-pending' || stateAfterAdmission === 'active')
      && this.#machine.identity !== null && sameIdentity(this.#machine.identity, decision.identity)
      && this.#active === reservation
    if (!stillReserved) {
      this.#compensatingStop(reservation)
      return emptyResult('superseded')
    }
    if (!decision.recheck()) {
      this.#machine.cancel(decision.identity)
      this.#compensatingStop(reservation)
      return emptyResult('superseded')
    }
    return Object.freeze({
      code: 'delegated' as const,
      accepted: true as const,
      delegate_id: admission.delegate_id,
      detail: Object.freeze({channel, op: 'start' as const}),
    })
  }

  cancel(request: VisionControllerCancelRequest): Promise<VisionControllerResult> {
    return Promise.resolve(this.#stop(request, 'cancelled'))
  }

  /** Host callback after camera permission admission. A stale identity is fenced, never granted. */
  permissionGranted(identity: VisionIdentity): boolean {
    const active = this.#active
    if (active === null || !sameIdentity(active.identity, identity)) return false
    if (!safeWanted(active.stillWanted) || !safeWanted(active.fence)) {
      if (this.#machine.state === 'permission-pending' || this.#machine.state === 'active') {
        this.#machine.cancel(active.identity)
        this.#compensatingStop(active)
      }
      return false
    }
    const granted = this.#machine.grant({...identity})
    return granted.code === 'active' || granted.code === 'already_active'
  }
  onPermissionGranted(identity: VisionIdentity): boolean { return this.permissionGranted(identity) }

  /** Host callback for an executor terminal. Cleanup is exact-identity and idempotent. */
  terminal(identity: VisionIdentity): void { this.#cleanupTerminal({...identity}) }
  onTerminal(identity: VisionIdentity): void { this.terminal(identity) }

  /** Host callback for a detected hit. A hit is terminal for this one monitor window. */
  hit(identity: VisionIdentity): void {
    const result = this.#machine.hit({...identity})
    if (result.code !== 'hit') return
    this.#machine.cancel({...identity})
    this.#cleanupTerminal({...identity})
  }
  onHit(identity: VisionIdentity): void { this.hit(identity) }

  async #assess(identity: VisionIdentity, request: VisionControllerDispatchRequest): Promise<unknown> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const completion = this.#gateway.complete({
        model: this.#model,
        system: VISION_ASSESS_SYSTEM,
        prompt: promptFor(identity, request),
        jsonSchema: VISION_ASSESS_JSON_SCHEMA,
        signal: controller.signal,
      })
      const response = Number.isFinite(this.#assessmentTimeoutMs) && this.#assessmentTimeoutMs > 0
        ? await Promise.race([
          completion,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error('vision assessment timeout'))
            }, this.#assessmentTimeoutMs)
          }),
        ])
        : await completion
      if (typeof response.text !== 'string') return null
      return JSON.parse(response.text)
    } catch {
      return null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #stop(
    request: VisionControllerCancelRequest | VisionControllerDispatchRequest,
    successCode: 'cancelled' | 'requested_stop',
    wanted: () => boolean = request.stillWanted,
  ): VisionControllerResult {
    const active = this.#active
    if (this.#machine.state === 'idle' || active === null) return emptyResult('not_running')
    if (!safeWanted(request.stillWanted) || !safeWanted(wanted)) return emptyResult('superseded')
    const cancellation = this.#machine.cancel(active.identity)
    if (cancellation.code === 'already_cancelled') {
      if (!this.#dispatchStop(active, request.origin_ref)) return emptyResult('runtime_rejected')
      return Object.freeze({
        code: 'requested_stop' as const, accepted: true as const,
        detail: Object.freeze({channel: active.channel, op: 'stop' as const}),
      })
    }
    if (cancellation.code !== 'cancelled') return emptyResult('not_running')
    const accepted = this.#dispatchStop(active, request.origin_ref)
    if (!accepted) {
      // Keep the fenced terminal reservation: the runtime may have started work even when its stop
      // admission was rejected. Only an exact terminal callback can prove it is safe to reopen.
      return emptyResult('runtime_rejected')
    }
    return Object.freeze({
      code: successCode,
      accepted: true as const,
      detail: Object.freeze({channel: active.channel, op: 'stop' as const}),
    })
  }

  #releaseRejected(identity: VisionIdentity): void {
    this.#machine.cancel({...identity})
    this.#machine.cleanup({...identity})
    if (this.#active !== null && sameIdentity(this.#active.identity, identity)) this.#active = null
  }

  #compensatingStop(active: ActiveVisionReservation): void {
    // This is cleanup for an already-admitted exact identity, so it must not depend on the stale
    // user fence that caused the compensation. The machine is fenced before this effect.
    this.#dispatchStop(active)
  }

  /** Issue an exact stop and return whether the synchronous runtime adapter admitted it. */
  #dispatchStop(active: ActiveVisionReservation, originRef = active.origin_ref): boolean {
    if (active.stopAccepted) return true
    try {
      const result = parseRuntimeAdmission(this.#runtimePort.dispatch({
        channel: active.channel, op: 'stop', request: {}, origin_ref: originRef,
        // Cancellation fenced the machine before this callback can be observed by the port.
        stillWanted: () => true,
      }))
      const accepted = result?.accepted === true
      if (accepted) active.stopAccepted = true
      return accepted
    } catch {
      return false
    }
  }

  #cleanupTerminal(identity: VisionIdentity): void {
    const canceled = this.#machine.state === 'active' || this.#machine.state === 'permission-pending'
    if (canceled) this.#machine.cancel({...identity})
    const cleaned = this.#machine.cleanup({...identity})
    if ((cleaned.code === 'cleaned' || cleaned.code === 'already_idle')
      && this.#active !== null && sameIdentity(this.#active.identity, identity)) this.#active = null
  }

  #isStopInstruction(instruction: string): boolean {
    const normalized = instruction.trim().toLocaleLowerCase()
    return normalized === 'stop' || normalized === 'cancel' || normalized === '停止' || normalized === '取消监控'
  }
}
