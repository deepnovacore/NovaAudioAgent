import {SPEECH_FINAL_LIMIT, prepareForSpeech} from './realtime/speech-prep.js'

/** Host-owned live preference; progress only, never task execution or final delivery. */
export type CodingProgressNarration = 'smart' | 'continuous'
export class CodingProgressNarrationState {
  #mode: CodingProgressNarration
  #enabled = true
  readonly #listeners = new Set<() => void>()
  constructor(mode: CodingProgressNarration = 'smart') { this.#mode = mode }
  get mode(): CodingProgressNarration { return this.#mode }
  get enabled(): boolean { return this.#enabled }
  viaSurrogate(coding: boolean, manifestPolicy: boolean): boolean {
    return coding ? this.#enabled && this.#mode === 'smart' && manifestPolicy : manifestPolicy
  }
  setMode(mode: CodingProgressNarration): void {
    if (mode !== 'smart' && mode !== 'continuous') throw new TypeError('invalid coding narration mode')
    if (this.#mode === mode) return
    this.#mode = mode
    for (const listener of this.#listeners) listener()
  }
  setEnabled(enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new TypeError('invalid coding narration preference')
    if (this.#enabled === enabled) return
    this.#enabled = enabled
    for (const listener of this.#listeners) listener()
  }
  observe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}

/** Both routing outlets compare the same public speech content, never raw markup. */
export function codingProgressSummary(summary: string | null): string | null {
  return summary === null ? null : prepareForSpeech(summary, {limit: SPEECH_FINAL_LIMIT}).text || null
}
