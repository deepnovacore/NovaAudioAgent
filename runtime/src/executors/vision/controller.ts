import {
  parseAgentActionResult,
  type AgentActionResult,
  type AgentCancelRequest,
  type AgentController,
  type AgentDispatchRequest,
} from '../../agent-controller.js'
import {
  VISION_AGENT_DESCRIPTOR,
  type VisionAgentControllerCore,
} from './controller-core.js'

/**
 * Public host-controller facade for the Vision core.
 *
 * The core owns assessment and runtime admission. This adapter owns the public, closed result
 * vocabulary; it reconstructs every detail object so a future core/provider cannot put prose or an
 * unbounded field on the realtime-facing result.
 */
export class VisionAgentController implements AgentController {
  readonly descriptor = VISION_AGENT_DESCRIPTOR
  readonly #core: Pick<VisionAgentControllerCore, 'dispatch' | 'cancel'>

  constructor(options: {readonly core: Pick<VisionAgentControllerCore, 'dispatch' | 'cancel'>}) {
    this.#core = options.core
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentActionResult> {
    try {
      return this.#normalize(await this.#core.dispatch(request))
    } catch {
      return unavailable()
    }
  }

  async cancel(request: AgentCancelRequest): Promise<AgentActionResult> {
    try {
      return this.#normalize(await this.#core.cancel(request))
    } catch {
      return unavailable()
    }
  }

  #normalize(value: unknown): AgentActionResult {
    if (!isRecord(value) || typeof value.code !== 'string') return unavailable()
    let candidate: unknown
    switch (value.code) {
      case 'delegated': {
        const detail = isRecord(value.detail) ? value.detail : null
        if (value.accepted !== true || typeof value.delegate_id !== 'string' || detail === null
          || !isVisionChannel(detail.channel) || detail.op !== 'start') return unavailable()
        candidate = {
          code: 'delegated', accepted: true, delegate_id: value.delegate_id,
          detail: {channel: detail.channel, op: 'start'},
        }
        break
      }
      case 'cancelled':
      case 'requested_stop': {
        const detail = isRecord(value.detail) ? value.detail : null
        if (value.accepted !== true || detail === null
          || !isVisionChannel(detail.channel) || detail.op !== 'stop') return unavailable()
        candidate = {
          code: 'monitor_stop_requested', accepted: true,
          detail: {channel: detail.channel, op: 'stop'},
        }
        break
      }
      case 'unclear':
        candidate = {code: 'clarification_required', accepted: true, detail: {}}
        break
      case 'busy':
        candidate = {code: 'busy', accepted: true, detail: {}}
        break
      case 'assessment_unavailable':
        candidate = {code: 'assessment_unavailable', accepted: false, detail: {}}
        break
      case 'not_running':
        candidate = {code: 'not_running', accepted: true, detail: {}}
        break
      case 'superseded':
        candidate = {code: 'superseded', accepted: false, detail: {}}
        break
      case 'runtime_rejected':
        candidate = {code: 'runtime_rejected', accepted: false, detail: {}}
        break
      default:
        return unavailable()
    }
    return parseAgentActionResult(candidate) ?? unavailable()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isVisionChannel(value: unknown): value is 'watch' | 'guard' {
  return value === 'watch' || value === 'guard'
}

function unavailable(): AgentActionResult {
  const result = {code: 'assessment_unavailable', accepted: false, detail: {}} as const
  const parsed = parseAgentActionResult(result)
  if (parsed === null) throw new Error('invalid built-in assessment_unavailable result')
  return parsed
}
