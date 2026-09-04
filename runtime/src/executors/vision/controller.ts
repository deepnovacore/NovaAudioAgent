import {
  parseAgentActionResult,
  type AgentActionResult,
  type AgentCancelRequest,
  type AgentController,
  type AgentDispatchRequest,
} from '../../agent-controller.js'
import {types as nodeTypes} from 'node:util'
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
    const record = readPlainRecord(value)
    if (record === null || typeof record.values.code !== 'string') return unavailable()
    const code = record.values.code
    let candidate: unknown
    switch (code) {
      case 'delegated': {
        if (!hasExactKeys(record, ['accepted', 'code', 'delegate_id', 'detail'])
          || record.values.accepted !== true || !isBoundedIdentifier(record.values.delegate_id)) return unavailable()
        const detail = readPlainRecord(record.values.detail)
        if (detail === null || !hasExactKeys(detail, ['channel', 'op'])
          || !isVisionChannel(detail.values.channel) || detail.values.op !== 'start') return unavailable()
        candidate = {
          code: 'delegated', accepted: true, delegate_id: record.values.delegate_id,
          detail: {channel: detail.values.channel, op: 'start'},
        }
        break
      }
      case 'cancelled':
      case 'requested_stop': {
        if (!hasExactKeys(record, ['accepted', 'code', 'detail']) || record.values.accepted !== true) return unavailable()
        const detail = readPlainRecord(record.values.detail)
        if (detail === null || !hasExactKeys(detail, ['channel', 'op'])
          || !isVisionChannel(detail.values.channel) || detail.values.op !== 'stop') return unavailable()
        candidate = {
          code: 'monitor_stop_requested', accepted: true,
          detail: {channel: detail.values.channel, op: 'stop'},
        }
        break
      }
      case 'unclear':
        if (!hasExactKeys(record, ['accepted', 'code', 'detail']) || record.values.accepted !== true
          || !hasExactDetail(record.values.detail, {reason: 'assessment_unclear'})) return unavailable()
        candidate = {code: 'clarification_required', accepted: true, detail: {}}
        break
      case 'busy':
        if (!hasExactKeys(record, ['accepted', 'code', 'detail']) || record.values.accepted !== true
          || !isEmptyDetail(record.values.detail)) return unavailable()
        candidate = {code: 'busy', accepted: true, detail: {}}
        break
      case 'assessment_unavailable':
        if (!hasExactKeys(record, ['accepted', 'code', 'detail']) || record.values.accepted !== false
          || !isEmptyDetail(record.values.detail)) return unavailable()
        candidate = {code: 'assessment_unavailable', accepted: false, detail: {}}
        break
      case 'not_running':
        if (!hasExactKeys(record, ['accepted', 'code', 'detail']) || record.values.accepted !== true
          || !isEmptyDetail(record.values.detail)) return unavailable()
        candidate = {code: 'not_running', accepted: true, detail: {}}
        break
      case 'superseded':
        if (!hasExactKeys(record, ['accepted', 'code', 'detail']) || record.values.accepted !== false
          || !isEmptyDetail(record.values.detail)) return unavailable()
        candidate = {code: 'superseded', accepted: false, detail: {}}
        break
      case 'runtime_rejected':
        if (!hasExactKeys(record, ['accepted', 'code', 'detail']) || record.values.accepted !== false
          || !isEmptyDetail(record.values.detail)) return unavailable()
        candidate = {code: 'runtime_rejected', accepted: false, detail: {}}
        break
      default:
        return unavailable()
    }
    return parseAgentActionResult(candidate) ?? unavailable()
  }
}

interface PlainRecord {
  readonly values: Record<string, unknown>
  readonly keys: readonly string[]
}

function readPlainRecord(value: unknown): PlainRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    if (nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    const stringKeys: string[] = []
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      if (typeof key !== 'string') return null
      stringKeys.push(key)
      const descriptor = descriptors[key]
      if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined
        || descriptor.set !== undefined || !Object.hasOwn(descriptor, 'value')) return null
      Object.defineProperty(values, key, {value: descriptor.value, enumerable: true, writable: false, configurable: false})
    }
    return Object.freeze({values: Object.freeze(values), keys: Object.freeze(stringKeys)})
  } catch {
    return null
  }
}

function hasExactKeys(record: PlainRecord, expected: readonly string[]): boolean {
  if (record.keys.length !== expected.length) return false
  return expected.every(key => record.keys.includes(key))
}

function isEmptyDetail(value: unknown): boolean {
  const detail = readPlainRecord(value)
  return detail !== null && detail.keys.length === 0
}

function hasExactDetail(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  const detail = readPlainRecord(value)
  if (detail === null || !hasExactKeys(detail, Object.keys(expected))) return false
  return Object.entries(expected).every(([key, item]) => detail.values[key] === item)
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
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
