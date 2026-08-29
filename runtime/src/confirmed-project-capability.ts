import type {DelegateRequest} from './ports.js'

type CapabilityPhase = 'ready' | 'admitting' | 'admitted' | 'revoked'

interface ConfirmedProjectCapabilityState {
  readonly proposal_id: string
  readonly origin_ref: string
  readonly expires_at: number
  readonly now: () => number
  phase: CapabilityPhase
}

const CAPABILITIES = new WeakMap<object, ConfirmedProjectCapabilityState>()

/** Register the exact frozen operation object issued by the confirmation controller. */
export function issueConfirmedProjectCapability(
  capability: object,
  input: {
    readonly proposalId: string
    readonly originRef: string
    readonly expiresAt: number
    readonly now: () => number
  },
): void {
  CAPABILITIES.set(capability, {
    proposal_id: input.proposalId,
    origin_ref: input.originRef,
    expires_at: input.expiresAt,
    now: input.now,
    phase: 'ready',
  })
}

/** Lock one exact capability for the one private confirmed-project admission shape. */
export function beginConfirmedProjectAdmission(
  capability: object,
  request: DelegateRequest,
): boolean {
  const state = CAPABILITIES.get(capability)
  const now = state?.now()
  if (
    state?.phase !== 'ready'
    || now === undefined
    || !Number.isFinite(now)
    || now >= state.expires_at
    || request.executor !== 'codex'
    || request.op !== 'project'
    || request.origin_ref !== state.origin_ref
    || Object.keys(request.request).length !== 1
    || request.request.action !== 'execute_confirmed'
  ) return false
  state.phase = 'admitting'
  return true
}

/** Admission rejection restores the capability; success consumes it before worker dispatch. */
export function finishConfirmedProjectAdmission(capability: object, accepted: boolean): boolean {
  const state = CAPABILITIES.get(capability)
  if (state?.phase !== 'admitting') return false
  state.phase = accepted ? 'admitted' : 'ready'
  return true
}

export function confirmedProjectCapabilityWasAdmitted(capability: object): boolean {
  return CAPABILITIES.get(capability)?.phase === 'admitted'
}

/**
 * Record the result returned by the host's narrow runtime-dispatch port.
 *
 * The real CausalRuntime has already moved the capability to admitted. This idempotent fallback lets
 * isolated adapter tests provide the same trusted port without constructing a serving runtime.
 */
export function recordConfirmedProjectAdmission(capability: object): boolean {
  const state = CAPABILITIES.get(capability)
  if (state?.phase === 'admitted') return true
  const now = state?.now()
  if (
    state?.phase !== 'ready'
    || now === undefined
    || !Number.isFinite(now)
    || now >= state.expires_at
  ) return false
  state.phase = 'admitted'
  return true
}

export function revokeConfirmedProjectCapability(capability: object): void {
  const state = CAPABILITIES.get(capability)
  if (state !== undefined) state.phase = 'revoked'
}
