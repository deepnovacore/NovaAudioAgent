import type {DelegateRequest} from './ports.js'

type CapabilityPhase = 'ready' | 'admitting' | 'admitted' | 'revoked'

interface ConfirmedProjectCapabilityState {
  readonly proposal_id: string
  readonly origin_ref: string
  phase: CapabilityPhase
}

const CAPABILITIES = new WeakMap<object, ConfirmedProjectCapabilityState>()

/** Register the exact frozen operation object after the controller accepts a decision before its TTL. */
export function issueConfirmedProjectCapability(
  capability: object,
  input: {
    readonly proposalId: string
    readonly originRef: string
  },
): void {
  CAPABILITIES.set(capability, {
    proposal_id: input.proposalId,
    origin_ref: input.originRef,
    phase: 'ready',
  })
}

/**
 * Lock one exact capability for the one private confirmed-project admission shape.
 *
 * The proposal TTL gates capability issuance, not completion of an in-flight commit. Provider
 * replacement, service close, terminal rejection and replay still revoke the identity explicitly.
 */
export function beginConfirmedProjectAdmission(
  capability: object,
  request: DelegateRequest,
): boolean {
  const state = CAPABILITIES.get(capability)
  if (
    state?.phase !== 'ready'
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
  if (state?.phase !== 'ready') return false
  state.phase = 'admitted'
  return true
}

export function revokeConfirmedProjectCapability(capability: object): void {
  const state = CAPABILITIES.get(capability)
  if (state !== undefined) state.phase = 'revoked'
}
