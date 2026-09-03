const MAX_PROPOSAL_ID_CODE_POINTS = 128
const PYTHON_BLANK_CHARACTERS = new Set([
  '\u0009', '\u000a', '\u000b', '\u000c', '\u000d',
  '\u001c', '\u001d', '\u001e', '\u001f', '\u0020', '\u0085', '\u00a0', '\u1680',
  '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
  '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000',
])

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

/** Separate one-shot authority for a Codex app-server permission request. */
export class CodexApprovalDecisionController {
  #send
  #approvalId = null
  #busy = false
  #hostBusy = false
  #allowed = ['accept', 'decline']

  constructor({send}) {
    if (typeof send !== 'function') throw new TypeError('send is required')
    this.#send = send
  }

  sync({pending, approvalId, busy = false, allowedDecisions = ['accept', 'decline']}) {
    const next = pending === true && validProposalId(approvalId) ? approvalId : null
    if (next !== this.#approvalId) this.#busy = false
    this.#approvalId = next
    this.#hostBusy = busy === true
    this.#allowed = Array.isArray(allowedDecisions) ? [...allowedDecisions] : ['decline']
    if (next === null || busy === false) this.#busy = false
  }

  get enabled() {
    return this.#approvalId !== null && !this.#busy && !this.#hostBusy
  }

  get canAccept() { return this.#allowed.includes('accept') }
  get canAcceptForSession() { return this.#allowed.includes('acceptForSession') }

  decide(approved, scope) {
    if (!this.enabled || typeof approved !== 'boolean') return false
    if (scope !== undefined && (scope !== 'session' || !approved)) return false
    if (!this.#allowed.includes(approved ? scope === 'session' ? 'acceptForSession' : 'accept' : 'decline')) return false
    const sent = this.#send({
      type: 'codex.approval_decision',
      approval_id: this.#approvalId,
      approved,
      ...(scope === undefined ? {} : {scope}),
    })
    if (sent !== true) return false
    this.#busy = true
    return true
  }

  deliveryLost() {
    this.#busy = false
  }
}

/** Presentation-only arbitration. It never owns or transfers either decision authority. */
export class ConfirmationPresentationController {
  #activeKind = null
  #pendingProject = false
  #pendingCodex = false

  sync(kind, pending) {
    if (kind !== 'project' && kind !== 'codex') return false
    const wasActive = this.#activeKind === kind
    if (kind === 'project') this.#pendingProject = pending === true
    else this.#pendingCodex = pending === true
    if (pending === true) {
      if (this.#activeKind === null) this.#activeKind = kind
      return this.#activeKind === kind
    }
    if (this.#activeKind !== kind) return false
    this.#activeKind = kind === 'project'
      ? (this.#pendingCodex ? 'codex' : null)
      : (this.#pendingProject ? 'project' : null)
    return wasActive
  }

  get activeKind() {
    return this.#activeKind
  }
}

const APPROVAL_BASE_KEYS = [
  'expires_in_seconds', 'kind', 'local_detail', 'operation_summary',
  'pending_approval', 'pending_approval_busy', 'type',
]

/** Strictly validate the independent renderer-only approval frame. */
export function parseCodexApprovalMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null
  const keys = Object.keys(message).sort().join(',')
  const pending = message.pending_approval
  const expectedKeys = pending === true
    ? [...APPROVAL_BASE_KEYS, 'pending_approval_id', ...(message.allowed_decisions === undefined ? [] : ['allowed_decisions'])].sort().join(',')
    : [...APPROVAL_BASE_KEYS].sort().join(',')
  if (
    keys !== expectedKeys
    || message.type !== 'codex.approval'
    || typeof pending !== 'boolean'
    || typeof message.pending_approval_busy !== 'boolean'
    || (!pending && message.pending_approval_busy)
  ) return null
  if (!pending) {
    if (
      message.kind !== null
      || message.local_detail !== null
      || message.operation_summary !== null
      || message.expires_in_seconds !== null
    ) return null
    return Object.freeze({...message, operation: ''})
  }
  if (
    !validProposalId(message.pending_approval_id)
    || !['command_execution', 'file_change', 'network', 'permissions'].includes(message.kind)
    || !validText(message.operation_summary, 256)
    || !Number.isFinite(message.expires_in_seconds)
    || message.expires_in_seconds < 0
    || message.expires_in_seconds > 60
  ) return null
  const allowed = message.allowed_decisions
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.length < 1 || allowed.length > 3
    || allowed.some(value => !['accept', 'acceptForSession', 'decline'].includes(value)) || !allowed.includes('decline'))) return null
  const detail = parseLocalDetail(message.local_detail, message.kind)
  if (detail === null) return null
  return Object.freeze({...message, local_detail: detail, operation: approvalOperation(detail)})
}

function parseLocalDetail(detail, kind) {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null
  if ('scope' in detail && !validText(detail.scope, 1024)) return null
  if (kind === 'permissions') {
    return Object.keys(detail).sort().join(',') === 'kind,scope' && detail.kind === kind
      ? Object.freeze({...detail}) : null
  }
  if (kind === 'command_execution' || kind === 'network') {
    if (
      Object.keys(detail).sort().join(',') !== (detail.scope === undefined ? 'command,cwd,kind' : 'command,cwd,kind,scope')
      || detail.kind !== kind
      || !validText(detail.command, 4096)
      || !validText(detail.cwd, 4096)
    ) return null
    return Object.freeze({...detail})
  }
  if (
    Object.keys(detail).sort().join(',') !== 'changes,kind'
    || detail.kind !== kind
    || !Array.isArray(detail.changes)
    || detail.changes.length < 1
    || detail.changes.length > 64
  ) return null
  const changes = []
  for (const change of detail.changes) {
    if (
      change === null
      || typeof change !== 'object'
      || Array.isArray(change)
      || Object.keys(change).sort().join(',') !== 'change,move_path,path'
      || !['add', 'delete', 'update'].includes(change.change)
      || !validText(change.path, 4096)
      || change.move_path !== null && !validText(change.move_path, 4096)
    ) return null
    changes.push(Object.freeze({...change}))
  }
  return Object.freeze({kind, changes: Object.freeze(changes)})
}

function approvalOperation(detail) {
  if (detail.kind === 'permissions') return `提升权限：${detail.scope}`
  if (detail.kind === 'command_execution' || detail.kind === 'network') return `${detail.kind === 'network' ? '访问网络' : '执行命令'}：${detail.command}${detail.scope ? `；${detail.scope}` : ''}`
  const paths = detail.changes.slice(0, 3).map(change => change.path).join('、')
  const suffix = detail.changes.length > 3 ? ` 等 ${detail.changes.length} 个文件` : ''
  return `修改文件：${paths}${suffix}`
}

function validText(value, limit) {
  if (typeof value !== 'string' || [...value].length > limit) return false
  for (const character of value) {
    if (!PYTHON_BLANK_CHARACTERS.has(character)) return true
  }
  return false
}
