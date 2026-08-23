import type {RealtimeTelemetry} from '../telemetry.js'

export type EndpointingEvent =
  | {readonly kind: 'speech_start'; readonly pcm: Uint8Array}
  | {readonly kind: 'speech_audio'; readonly pcm: Uint8Array}
  | {readonly kind: 'speech_end'; readonly commit: boolean}

export interface EndpointingPort {
  feed(pcm: Uint8Array, signal: AbortSignal): Promise<readonly EndpointingEvent[]>
  reset(): void | Promise<void>
  close(): Promise<void>
}

export type EndpointingFactory = (input: {
  readonly signal: AbortSignal
  readonly telemetry?: RealtimeTelemetry
}) => Promise<EndpointingPort>

export interface AsrTranscript {
  readonly text: string
  readonly final: boolean
}

export interface AsrSession {
  append(pcm: Uint8Array, signal?: AbortSignal): Promise<void>
  finish(signal?: AbortSignal): Promise<void>
  events(signal?: AbortSignal): AsyncIterable<AsrTranscript>
  close(): Promise<void>
}

export interface AsrClient {
  open(signal?: AbortSignal): Promise<AsrSession>
}

export interface AsrFactory {
  openClient(): AsrClient
}

export interface TtsAudio {
  readonly pcm: Uint8Array
}

export interface TtsSession {
  sendText(text: string, signal?: AbortSignal): Promise<void>
  finish(signal?: AbortSignal): Promise<void>
  cancel(signal?: AbortSignal): Promise<void>
  events(signal?: AbortSignal): AsyncIterable<TtsAudio>
  close(): Promise<void>
}

export interface TtsClient {
  open(signal?: AbortSignal): Promise<TtsSession>
}

export interface TtsFactory {
  openClient(): TtsClient
}
