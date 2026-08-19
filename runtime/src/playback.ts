export type DeliveryDisposition = 'spoken' | 'interrupted' | 'suppressed'

export const MAX_PLAYBACK_FRAME_BYTES = 64 * 1024
export const MAX_RENDERER_TOMBSTONES = 256

export interface PlaybackGeneration {
  readonly session_epoch: number
  readonly generation_epoch: number
  readonly generation_id: string
  readonly utterance_id: string
  readonly response_id: string
}

export interface PlaybackFrame {
  readonly utterance_id: string
  readonly generation_epoch: number
  readonly sequence: number
  readonly pcm: Uint8Array
}

export interface PlaybackCompletion {
  readonly session_epoch: number
  readonly response_id: string
  readonly utterance_id: string
  readonly generation_epoch: number
  readonly text: string
  readonly disposition: DeliveryDisposition
  readonly started: boolean
  readonly played_ms: number | null
}

interface GenerationState {
  readonly identity: PlaybackGeneration
  nextSequence: number
  transcript: string
  providerTerminal: boolean
  fenced: boolean
  delivered: boolean
  started: boolean
  terminalDisposition: Exclude<DeliveryDisposition, 'suppressed'>
}

export interface PlaybackRegistryOptions {
  readonly idFactory: () => string
  readonly onFrame: (frame: PlaybackFrame) => void
  readonly onClear: (utteranceId: string, generationEpoch: number) => void
  readonly onAlert?: (utteranceId: string | null, generationEpoch: number | null) => void
}

export class PlaybackRegistry {
  readonly #idFactory: () => string
  readonly #onFrame: (frame: PlaybackFrame) => void
  readonly #onClear: (utteranceId: string, generationEpoch: number) => void
  readonly #onAlert: (utteranceId: string | null, generationEpoch: number | null) => void
  readonly #byProvider = new Map<string, GenerationState>()
  readonly #byRenderer = new Map<string, GenerationState>()
  readonly #rendererTombstones: string[] = []
  readonly #rendererTombstoneSet = new Set<string>()
  #generationEpoch = 0
  #currentProviderIdentity: string | null = null

  constructor(options: PlaybackRegistryOptions) {
    this.#idFactory = options.idFactory
    this.#onFrame = options.onFrame
    this.#onClear = options.onClear
    this.#onAlert = options.onAlert ?? (() => undefined)
  }

  get current(): PlaybackGeneration | null {
    if (this.#currentProviderIdentity === null) return null
    return this.#byProvider.get(this.#currentProviderIdentity)?.identity ?? null
  }

  get hasUnreportedFence(): boolean {
    return [...this.#byProvider.values()].some(state => state.fenced && !state.delivered)
  }

  get rendererTombstoneCount(): number {
    return this.#rendererTombstones.length
  }

  openResponse(input: {readonly sessionEpoch: number; readonly responseId: string}): PlaybackGeneration {
    if (!Number.isInteger(input.sessionEpoch) || input.sessionEpoch < 1 || input.responseId.length === 0) {
      throw new Error('sessionEpoch and responseId are required')
    }
    const providerIdentity = providerKey(input.sessionEpoch, input.responseId)
    if (this.#byProvider.has(providerIdentity)) {
      throw new Error('response already has a playback generation')
    }
    if (this.#currentProviderIdentity !== null) {
      throw new Error('another playback generation is active')
    }
    this.#generationEpoch += 1
    const identity = Object.freeze({
      session_epoch: input.sessionEpoch,
      generation_epoch: this.#generationEpoch,
      generation_id: this.#requiredId(),
      utterance_id: this.#requiredId(),
      response_id: input.responseId,
    })
    const state: GenerationState = {
      identity,
      nextSequence: 0,
      transcript: '',
      providerTerminal: false,
      fenced: false,
      delivered: false,
      started: false,
      terminalDisposition: 'spoken',
    }
    this.#byProvider.set(providerIdentity, state)
    this.#byRenderer.set(rendererKey(identity.utterance_id, identity.generation_epoch), state)
    this.#currentProviderIdentity = providerIdentity
    return identity
  }

  pushAudio(input: {
    readonly sessionEpoch: number
    readonly responseId: string
    readonly pcm: Uint8Array
  }): boolean {
    if (!(input.pcm instanceof Uint8Array) || input.pcm.byteLength === 0 || input.pcm.byteLength % 2 !== 0) {
      throw new Error('pcm must be non-empty aligned PCM16 bytes')
    }
    const state = this.#byProvider.get(providerKey(input.sessionEpoch, input.responseId))
    if (state === undefined || state.providerTerminal || state.fenced || state.delivered) return false
    for (let offset = 0; offset < input.pcm.byteLength; offset += MAX_PLAYBACK_FRAME_BYTES) {
      this.#onFrame({
        utterance_id: state.identity.utterance_id,
        generation_epoch: state.identity.generation_epoch,
        sequence: state.nextSequence,
        pcm: input.pcm.slice(offset, offset + MAX_PLAYBACK_FRAME_BYTES),
      })
      state.nextSequence += 1
    }
    return true
  }

  setTranscript(input: {
    readonly sessionEpoch: number
    readonly responseId: string
    readonly text: string
  }): boolean {
    const state = this.#byProvider.get(providerKey(input.sessionEpoch, input.responseId))
    if (state === undefined || state.delivered) return false
    state.transcript = input.text
    return true
  }

  markProviderTerminal(input: {
    readonly sessionEpoch: number
    readonly responseId: string
    readonly disposition?: Exclude<DeliveryDisposition, 'suppressed'>
  }): boolean {
    const state = this.#byProvider.get(providerKey(input.sessionEpoch, input.responseId))
    if (state === undefined || state.fenced || state.delivered) return false
    state.providerTerminal = true
    state.terminalDisposition = input.disposition ?? 'spoken'
    if (state.nextSequence === 0) this.#retire(state)
    return true
  }

  fenceCurrent(options: {readonly alert?: boolean} = {}): PlaybackGeneration | null {
    const current = this.current
    if (current === null) {
      if (options.alert === true) this.#onAlert(null, null)
      return null
    }
    const fenced = options.alert === true
      ? this.alertFenceGeneration(current)
      : this.switchGeneration(current)
    return fenced ? current : null
  }

  switchGeneration(generation: PlaybackGeneration): boolean {
    return this.#fenceGeneration(generation, false)
  }

  alertFenceGeneration(generation: PlaybackGeneration): boolean {
    return this.#fenceGeneration(generation, true)
  }

  retireClearUnknown(generation: PlaybackGeneration): boolean {
    const state = this.#stateForGeneration(generation)
    if (state === undefined || state.delivered || !state.fenced) return false
    this.#retire(state)
    return true
  }

  markStarted(utteranceId: string, generationEpoch: number): boolean {
    const state = this.#find(utteranceId, generationEpoch)
    if (state === undefined || state.delivered || state.started) return false
    state.started = true
    return true
  }

  recordCleared(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null,
  ): PlaybackCompletion | null {
    const state = this.#find(utteranceId, generationEpoch)
    if (state === undefined || state.delivered || !state.fenced) return null
    state.delivered = true
    const completion = this.#completion(
      state,
      state.started || (playedMs !== null && playedMs > 0) ? 'interrupted' : 'suppressed',
      playedMs,
    )
    this.#retire(state)
    return completion
  }

  ackDone(
    utteranceId: string,
    generationEpoch: number,
    playedMs: number | null = null,
  ): PlaybackCompletion | null {
    const state = this.#find(utteranceId, generationEpoch)
    if (
      state === undefined
      || state.fenced
      || state.delivered
      || !state.providerTerminal
      || state.nextSequence === 0
    ) return null
    state.delivered = true
    let disposition: DeliveryDisposition = state.terminalDisposition
    if (
      disposition === 'interrupted'
      && !state.started
      && (playedMs === null || playedMs <= 0)
    ) disposition = 'suppressed'
    const completion = this.#completion(state, disposition, playedMs)
    this.#retire(state)
    return completion
  }

  #completion(
    state: GenerationState,
    disposition: DeliveryDisposition,
    playedMs: number | null,
  ): PlaybackCompletion {
    return {
      session_epoch: state.identity.session_epoch,
      response_id: state.identity.response_id,
      utterance_id: state.identity.utterance_id,
      generation_epoch: state.identity.generation_epoch,
      text: state.transcript,
      disposition,
      started: state.started,
      played_ms: playedMs,
    }
  }

  #find(utteranceId: string, generationEpoch: number): GenerationState | undefined {
    const identity = rendererKey(utteranceId, generationEpoch)
    if (this.#rendererTombstoneSet.has(identity)) return undefined
    return this.#byRenderer.get(identity)
  }

  #fenceGeneration(generation: PlaybackGeneration, alert: boolean): boolean {
    const state = this.#stateForGeneration(generation)
    if (
      state === undefined
      || state.fenced
      || state.delivered
      || this.#currentProviderIdentity !== providerKey(generation.session_epoch, generation.response_id)
    ) return false
    state.fenced = true
    this.#currentProviderIdentity = null
    if (alert) {
      this.#onAlert(generation.utterance_id, generation.generation_epoch)
    } else {
      this.#onClear(generation.utterance_id, generation.generation_epoch)
    }
    return true
  }

  #stateForGeneration(generation: PlaybackGeneration): GenerationState | undefined {
    const state = this.#byRenderer.get(rendererKey(generation.utterance_id, generation.generation_epoch))
    return state !== undefined && sameGeneration(state.identity, generation) ? state : undefined
  }

  #retire(state: GenerationState): void {
    const providerIdentity = providerKey(state.identity.session_epoch, state.identity.response_id)
    const rendererIdentity = rendererKey(state.identity.utterance_id, state.identity.generation_epoch)
    if (this.#byProvider.get(providerIdentity) === state) this.#byProvider.delete(providerIdentity)
    if (this.#byRenderer.get(rendererIdentity) === state) this.#byRenderer.delete(rendererIdentity)
    if (this.#currentProviderIdentity === providerIdentity) this.#currentProviderIdentity = null
    this.#addRendererTombstone(rendererIdentity)
  }

  #addRendererTombstone(rendererIdentity: string): void {
    if (this.#rendererTombstoneSet.has(rendererIdentity)) return
    if (this.#rendererTombstones.length === MAX_RENDERER_TOMBSTONES) {
      const expired = this.#rendererTombstones.shift()
      if (expired !== undefined) this.#rendererTombstoneSet.delete(expired)
    }
    this.#rendererTombstones.push(rendererIdentity)
    this.#rendererTombstoneSet.add(rendererIdentity)
  }

  #requiredId(): string {
    const value = this.#idFactory()
    if (value.length === 0) throw new Error('playback ids must be non-empty')
    return value
  }
}

function providerKey(sessionEpoch: number, responseId: string): string {
  return JSON.stringify([sessionEpoch, responseId])
}

function rendererKey(utteranceId: string, generationEpoch: number): string {
  return JSON.stringify([utteranceId, generationEpoch])
}

function sameGeneration(left: PlaybackGeneration, right: PlaybackGeneration): boolean {
  return left.session_epoch === right.session_epoch
    && left.generation_epoch === right.generation_epoch
    && left.generation_id === right.generation_id
    && left.utterance_id === right.utterance_id
    && left.response_id === right.response_id
}
