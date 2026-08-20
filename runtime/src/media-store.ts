/**
 * Bounded in-process image storage.
 *
 * Ported from the store half of `src/nova_audio_agent/media.py`. Frames are large and arrive
 * continuously, so this is an LRU bounded by *compressed payload bytes* rather than entry count: a
 * hundred thumbnails and one full-resolution capture are not the same load, and counting entries would
 * treat them as if they were.
 *
 * The ref it hands back is what reaches the model and Memory. Everything downstream cites that string,
 * so the store is where a frame stops being bytes and becomes something the agent can point at.
 *
 * (The request-materialization half of the Python module belongs with the camera path and is not here.)
 */

import { createHash, randomBytes } from 'node:crypto'

const MIB = 1_024 * 1_024
export const MEDIA_STORE_MAX_BYTES = 32 * MIB

export type MediaRef = string

export interface MediaEntry {
  readonly ref: MediaRef
  readonly digest: string
  readonly media_type: string
  readonly width: number
  readonly height: number
  readonly captured_at: number
  readonly payload: Uint8Array
}

export class MediaStore {
  readonly maxBytes: number
  readonly #idFactory: () => string
  /** Insertion-ordered, and re-inserted on read, which is what makes it an LRU. */
  readonly #entries = new Map<MediaRef, MediaEntry>()
  #totalBytes = 0

  constructor(
    maxBytes: number = MEDIA_STORE_MAX_BYTES,
    options: {readonly idFactory?: () => string} = {},
  ) {
    if (maxBytes <= 0) throw new RangeError('max_bytes 必须大于 0')
    this.maxBytes = maxBytes
    this.#idFactory = options.idFactory ?? (() => randomBytes(16).toString('hex'))
  }

  get totalBytes(): number {
    return this.#totalBytes
  }

  /**
   * Store one frame and mint its ref.
   *
   * A payload larger than the whole store is refused rather than admitted and immediately evicted --
   * accepting it would empty the store to hold something that cannot stay.
   */
  put(
    payload: Uint8Array,
    options: {
      readonly mediaType: string
      readonly width: number
      readonly height: number
      readonly capturedAt: number
    },
  ): MediaEntry {
    if (payload.length === 0) throw new RangeError('媒体 payload 不能为空')
    if (payload.length > this.maxBytes) throw new RangeError('媒体 payload 超过 MediaStore 容量')
    if (options.width <= 0 || options.height <= 0) throw new RangeError('媒体尺寸必须为正数')
    const ref = this.#newRef()
    const entry: MediaEntry = {
      ref,
      digest: createHash('sha256').update(payload).digest('hex'),
      media_type: options.mediaType,
      width: options.width,
      height: options.height,
      captured_at: options.capturedAt,
      payload,
    }
    // Evicted oldest-first until this fits. Checked before insertion, so the store never momentarily
    // exceeds its bound.
    while (this.#entries.size > 0 && this.#totalBytes + payload.length > this.maxBytes) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      const evicted = this.#entries.get(oldest.value)
      this.#entries.delete(oldest.value)
      if (evicted !== undefined) this.#totalBytes -= evicted.payload.length
    }
    this.#entries.set(ref, entry)
    this.#totalBytes += payload.length
    return entry
  }

  /** Read an entry, marking it recently used. */
  get(ref: MediaRef): MediaEntry | undefined {
    const entry = this.#entries.get(ref)
    if (entry === undefined) return undefined
    this.#entries.delete(ref)
    this.#entries.set(ref, entry)
    return entry
  }

  /** Read without touching the recency order, for callers that are only inspecting. */
  peek(ref: MediaRef): MediaEntry | undefined {
    return this.#entries.get(ref)
  }

  get size(): number {
    return this.#entries.size
  }

  /**
   * Mint a ref, retrying on the vanishingly unlikely collision rather than overwriting a frame.
   *
   * Bounded, unlike the oracle's `while True`. A factory that keeps returning the same value is a
   * programming error, and the oracle's response to it is to spin forever holding the event loop --
   * which is how a monitoring window turns into a hung process rather than a failed one. Sixteen
   * attempts is far past what randomness would ever need, so reaching the limit means the factory is
   * broken and says so.
   */
  #newRef(): MediaRef {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const ref = `media:${this.#idFactory()}`
      if (!this.#entries.has(ref)) return ref
    }
    throw new Error('media id factory is not producing distinct refs')
  }
}
