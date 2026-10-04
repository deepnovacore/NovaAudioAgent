import type {JsonValue} from '../core/events.js'
import type {JsonObject} from './protocol.js'

type Frame = Record<string, JsonValue>

/** Provider-specific wire details; the realtime host and event ownership stay shared. */
export interface IntegratedWireProfile {
  readonly provider: 'qwen' | 'stepfun' | 'openai'
  /** An empty voice selects the service default instead of failing construction. */
  readonly voiceOptional: boolean
  session(tools: readonly JsonObject[], voice: string, instructions: string, model: string): JsonObject
  outbound(frame: Frame): Frame
  inbound(frame: Frame): Frame
  inputPcm(pcm: Uint8Array): Uint8Array
  reset(): void
}

const unchanged = (frame: Frame): Frame => frame
const unchangedPcm = (pcm: Uint8Array): Uint8Array => pcm
// The adapter ignores unknown event types, so a retyped frame is dropped.
const DROPPED: Frame = Object.freeze({type: 'stepfun.dropped'})

export const qwenWireProfile: IntegratedWireProfile = Object.freeze({
  provider: 'qwen',
  voiceOptional: false,
  session: (tools: readonly JsonObject[], voice: string, instructions: string, model: string) => ({
    modalities: ['audio', 'text'], voice, instructions,
    input_audio_format: 'pcm', output_audio_format: 'pcm',
    ...(model.startsWith('qwen3.5-omni-') ? {} : {max_history_turns: 20}),
    tools: [...tools],
    turn_detection: {type: model.startsWith('qwen3.5-omni-') ? 'semantic_vad' : 'smart_turn'},
  }),
  outbound: unchanged,
  inbound: unchanged,
  inputPcm: unchangedPcm,
  reset: () => undefined,
})

/** Stateful linear PCM16 conversion; input and output frame boundaries do not reset phase. */
export class Pcm16Resampler {
  #sampleIndex = 0
  #nextOutputNumerator = 0
  #previous = 0
  constructor(private readonly inputRate: number, private readonly outputRate: number) {}

  reset(): void { this.#sampleIndex = 0; this.#nextOutputNumerator = 0; this.#previous = 0 }

  convert(pcm: Uint8Array): Uint8Array {
    if (pcm.length % 2 !== 0) throw new TypeError('PCM16 input must be aligned')
    const source = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    const output = new Int16Array(Math.ceil(pcm.length / 2 * this.outputRate / this.inputRate) + 2)
    let count = 0
    for (let offset = 0; offset < pcm.length; offset += 2) {
      const current = source.getInt16(offset, true)
      const index = this.#sampleIndex++
      while (this.#nextOutputNumerator <= index * this.outputRate) {
        const remainder = this.#nextOutputNumerator - (index - 1) * this.outputRate
        const sample = index === 0 ? current : this.#previous + (current - this.#previous) * remainder / this.outputRate
        output[count++] = Math.round(sample)
        this.#nextOutputNumerator += this.inputRate
      }
      this.#previous = current
    }
    return new Uint8Array(output.buffer.slice(0, count * 2))
  }
}

export function createStepFunWireProfile(): IntegratedWireProfile {
  const inputResampler = new Pcm16Resampler(16, 24)
  // StepFun reports a call both as arguments.done and as output_item.done; deliver it once.
  const seenToolCalls = new Set<string>()
  const firstToolCall = (frame: Frame): Frame => {
    const callId = frame.call_id
    if (typeof callId !== 'string') return frame
    if (seenToolCalls.has(callId)) return DROPPED
    seenToolCalls.add(callId)
    if (seenToolCalls.size > 256) seenToolCalls.delete(seenToolCalls.values().next().value!)
    return frame
  }
  return {
    provider: 'stepfun',
    voiceOptional: true,
    session: (tools, voice, instructions) => ({
      modalities: ['text', 'audio'], instructions,
      ...(voice === '' || voice === 'default' ? {} : {voice}),
      input_audio_format: 'pcm16', output_audio_format: 'pcm16',
      tools: tools.map(tool => {
        if (tool.type !== 'function') throw new TypeError('StepFun accepts function tools only')
        if (typeof tool.name !== 'string' || typeof tool.description !== 'string'
          || typeof tool.parameters !== 'object' || tool.parameters === null
          || Array.isArray(tool.parameters)) throw new TypeError('invalid function tool')
        return {type: 'function', function: {
          name: tool.name, description: tool.description, parameters: tool.parameters,
        }}
      }),
      turn_detection: {type: 'server_vad', prefix_padding_ms: 500},
    }),
    outbound: unchanged,
    inbound: frame => {
      if (frame.type === 'response.output_item.done') {
        const item = frame.item
        if (typeof item === 'object' && item !== null && !Array.isArray(item)
          && item.type === 'function_call') {
          if (typeof frame.response_id !== 'string' || typeof item.id !== 'string'
            || typeof item.call_id !== 'string' || typeof item.name !== 'string'
            || typeof item.arguments !== 'string') throw new TypeError('invalid StepFun function call')
          return firstToolCall({type: 'response.function_call_arguments.done',
            response_id: frame.response_id, item_id: item.id,
            call_id: item.call_id, name: item.name, arguments: item.arguments})
        }
      }
      if (frame.type === 'response.function_call_arguments.done') return firstToolCall(frame)
      // StepFun ends truncated responses as incomplete; the shared host treats them as failed.
      if (frame.type === 'response.done' && typeof frame.response === 'object' && frame.response !== null
        && !Array.isArray(frame.response) && frame.response.status === 'incomplete') {
        return {...frame, response: {...frame.response, status: 'failed'}}
      }
      if (frame.type === 'response.cancelled' && typeof frame.response_id === 'string') {
        return {type: 'response.done', response: {id: frame.response_id, status: 'cancelled'}}
      }
      return frame
    },
    inputPcm: pcm => inputResampler.convert(pcm),
    reset: () => { inputResampler.reset(); seenToolCalls.clear() },
  }
}
