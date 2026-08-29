const MAX_PROPOSAL_ID_CODE_POINTS = 128

function validProposalId(value) {
  if (typeof value !== 'string') return false
  const codePoints = [...value].length
  return codePoints > 0 && codePoints <= MAX_PROPOSAL_ID_CODE_POINTS
}

/** One-shot renderer authority for the proposal currently visible in the banner. */
export class ConfirmationDecisionController {
  #send
  #proposalId = null
  #busy = false
  #hostBusy = false

  constructor({send}) {
    if (typeof send !== 'function') throw new TypeError('send is required')
    this.#send = send
  }

  sync({pending, proposalId, busy = false}) {
    const next = pending === true && validProposalId(proposalId) ? proposalId : null
    if (next !== this.#proposalId) this.#busy = false
    this.#proposalId = next
    this.#hostBusy = busy === true
    if (next === null || busy === false) this.#busy = false
  }

  get enabled() {
    return this.#proposalId !== null && !this.#busy && !this.#hostBusy
  }

  decide(confirmed) {
    if (!this.enabled || typeof confirmed !== 'boolean') return false
    const proposalId = this.#proposalId
    const sent = this.#send({
      type: 'project.confirmation_decision',
      proposal_id: proposalId,
      confirmed,
    })
    if (sent !== true) return false
    this.#busy = true
    return true
  }

  deliveryLost() {
    this.#busy = false
  }
}
