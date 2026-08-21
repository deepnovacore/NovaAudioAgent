import { MAX_REALTIME_TEXT } from '../protocol.js'

const boundaries = new Set([...`，。！？；：,.!?;:\n`])

export class TextChunker {
  readonly #softLimit: number
  readonly #hardLimit: number
  #pending: string[] = []
  #first = true

  constructor(options: {readonly softLimit?: number; readonly hardLimit?: number} = {}) {
    const softLimit = options.softLimit ?? 18
    const hardLimit = options.hardLimit ?? 48
    if (!Number.isSafeInteger(softLimit) || !Number.isSafeInteger(hardLimit)
      || softLimit < 1 || hardLimit < softLimit) {
      throw new RangeError('invalid TTS text limits')
    }
    this.#softLimit = softLimit
    this.#hardLimit = hardLimit
  }

  push(text: unknown): readonly string[] {
    if (typeof text !== 'string') throw new TypeError('TTS text delta must be a string')
    const delta = [...text]
    if (delta.length > MAX_REALTIME_TEXT) throw new RangeError('TTS text delta is too large')
    this.#pending.push(...delta)
    const chunks: string[] = []
    while (this.#pending.length > 0) {
      const boundary = this.flushBoundary()
      if (boundary === null && this.#pending.length < this.#hardLimit) break
      const end = boundary === null ? this.#hardLimit : Math.min(boundary, this.#hardLimit)
      chunks.push(this.#pending.slice(0, end).join(''))
      this.#pending = this.#pending.slice(end)
      this.#first = false
    }
    return chunks
  }

  finish(): readonly string[] {
    if (this.#pending.length === 0) return []
    const pending = this.#pending.join('')
    this.#pending = []
    this.#first = false
    return [pending]
  }

  private flushBoundary(): number | null {
    for (let index = 0; index < this.#pending.length; index += 1) {
      if (!boundaries.has(this.#pending[index]!)) continue
      const end = index + 1
      if (this.#first || end >= this.#softLimit) return end
    }
    return null
  }
}
