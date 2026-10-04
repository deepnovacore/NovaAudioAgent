import {Pcm16Resampler, type IntegratedWireProfile} from './integrated-wire-profile.js'
import type {JsonValue} from '../core/events.js'

/** OpenAI GA protocol translation. Host item delivery still requires server acknowledgments. */
export function createOpenAIWireProfile(): IntegratedWireProfile {
  const resampler = new Pcm16Resampler(16_000, 24_000)
  const eventNames: Readonly<Record<string,string>> = {
    'conversation.item.added': 'conversation.item.created',
    'response.output_audio.delta': 'response.audio.delta',
    'response.output_audio_transcript.delta': 'response.audio_transcript.delta',
    'response.output_audio_transcript.done': 'response.audio_transcript.done',
    'response.output_text.delta': 'response.text.delta',
  }
  return {
    provider: 'openai', voiceOptional: false,
    session: (tools, voice, instructions) => ({
      type: 'realtime', instructions, output_modalities: ['audio'], tools: [...tools],
      audio: {
        input: {format: {type:'audio/pcm',rate:24_000}, transcription: {model:'gpt-transcribe'}, turn_detection: {type:'server_vad'}},
        output: {format: {type:'audio/pcm',rate:24_000}, voice},
      },
    }),
    outbound: frame => {
      if (frame.type === 'response.create' && record(frame.response)) {
        const {modalities, ...response} = frame.response
        return {...frame, response: {...response, ...(modalities === undefined ? {} : {output_modalities: ['audio']})}}
      }
      if (frame.type === 'session.update' && record(frame.session)) return {...frame,session:{type:'realtime',...frame.session}}
      return frame
    },
    inbound: frame => {
      if (frame.type === 'error' && record(frame.error) && frame.error.code === 'response_cancel_not_active') {
        return {...frame,error:{...frame.error,code:'invalid_value',message:'no active response found to cancel'}}
      }
      if (typeof frame.type === 'string' && eventNames[frame.type]) return {...frame,type:eventNames[frame.type]!}
      if (frame.type === 'response.done' && record(frame.response) && frame.response.status === 'incomplete') {
        return {...frame,response:{...frame.response,status:'failed'}}
      }
      return frame
    },
    inputPcm: pcm => resampler.convert(pcm),
    reset: () => resampler.reset(),
  }
}
function record(value: JsonValue | undefined): value is Record<string,JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
