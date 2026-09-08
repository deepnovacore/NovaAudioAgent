/** The phone owns AOQ media; the host owns the existing Qwen protocol and Runtime policy. */
import {QwenAudioRealtimeAdapter, QwenSocketClosedError, type QwenSocket, type QwenAdapterOptions} from './qwen.js'
import type {JsonObject, SessionIdentity} from './protocol.js'

interface Attachment {
  readonly id: string
  readonly send: (event: Record<string, unknown>) => Promise<void>
  readonly disconnect: () => void
}

class AoqDataSocket implements QwenSocket {
  readonly id: string
  claimed = false
  readonly #attachment: Attachment
  readonly #queue: string[] = []
  #bytes = 0
  #closed = false
  #wake: (() => void) | undefined

  constructor(attachment: Attachment) { this.id = attachment.id; this.#attachment = attachment }
  push(event: Record<string, unknown>): void {
    if (this.#closed) return
    const raw = JSON.stringify(event)
    if (this.#queue.length >= 128 || this.#bytes + Buffer.byteLength(raw) > 256 * 1024) {
      void this.close(); return
    }
    this.#queue.push(raw); this.#bytes += Buffer.byteLength(raw); this.#wake?.()
  }
  async receive(): Promise<string> {
    while (!this.#closed) {
      const raw = this.#queue.shift()
      if (raw !== undefined) { this.#bytes -= Buffer.byteLength(raw); return raw }
      await new Promise<void>(resolve => { this.#wake = resolve })
      this.#wake = undefined
    }
    throw new QwenSocketClosedError()
  }
  async send(raw: string): Promise<void> {
    if (this.#closed) throw new QwenSocketClosedError()
    await this.#attachment.send(JSON.parse(raw) as Record<string, unknown>)
  }
  detach(): void {
    this.#closed = true; this.#queue.length = 0; this.#bytes = 0; this.#wake?.()
  }
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.detach()
    try { this.#attachment.disconnect(); return Promise.resolve() }
    catch (error) { return Promise.reject(error instanceof Error ? error : new QwenSocketClosedError()) }
  }
}

/** One active authenticated phone, not one Runtime per phone connection. */
export class AoqRuntimeLink {
  #active: AoqDataSocket | undefined
  readonly #waiters = new Set<() => void>()
  attach(attachment: Attachment): void {
    if (this.#active !== undefined) throw new Error('AOQ already attached')
    this.#active = new AoqDataSocket(attachment)
    for (const wake of this.#waiters) wake()
  }
  receive(id: string, event: Record<string, unknown>): void {
    if (this.#active?.id === id) this.#active.push(event)
  }
  detach(id: string): void {
    if (this.#active?.id !== id) return
    this.#active.detach(); this.#active = undefined
  }
  async take(signal: AbortSignal): Promise<QwenSocket> {
    for (;;) {
      signal.throwIfAborted()
      if (this.#active !== undefined && !this.#active.claimed) {
        this.#active.claimed = true
        return this.#active
      }
      await new Promise<void>(resolve => {
        const wake = (): void => {
          this.#waiters.delete(wake); signal.removeEventListener('abort', wake); resolve()
        }
        this.#waiters.add(wake); signal.addEventListener('abort', wake, {once: true})
        if (signal.aborted) wake()
      })
    }
  }
}

/** Reuse Qwen event normalization and tool ownership, with no cloud WebSocket or host PCM. */
export class AoqRealtimeAdapter extends QwenAudioRealtimeAdapter {
  readonly #link: AoqRuntimeLink
  readonly #selected: {socket?: QwenSocket}
  readonly #onDiagnostic: (line: string) => void
  constructor(options: Omit<QwenAdapterOptions, 'connector'> & {readonly link: AoqRuntimeLink; readonly onDiagnostic?: (line: string) => void}) {
    const selected: {socket?: QwenSocket} = {}
    super({...options, connector: () => {
      if (selected.socket === undefined) return Promise.reject(new QwenSocketClosedError())
      return Promise.resolve(selected.socket)
    }})
    this.#link = options.link; this.#selected = selected
    this.#onDiagnostic = options.onDiagnostic ?? (() => { /* Diagnostics are optional for in-memory tests. */ })
  }
  override async connect(options: {readonly tools: readonly JsonObject[]; readonly signal: AbortSignal}): Promise<SessionIdentity> {
    for (;;) {
      // Human attachment is unbounded but abortable. Only the actual SDK handshake is timed.
      this.#selected.socket = await this.#link.take(options.signal)
      try {
        const identity = await super.connect(options)
        this.#onDiagnostic('[runtime-diagnostic] aoq_provider_connected')
        return identity
      }
      catch {
        this.#onDiagnostic('[runtime-diagnostic] aoq_handshake_failed')
        await super.close()
        options.signal.throwIfAborted()
        // A failed phone attempt releases that phone, not the persistent host graph.
      }
    }
  }
  override sendAudio(pcm: Uint8Array, signal: AbortSignal): Promise<void> {
    void pcm; void signal
    return Promise.reject(new Error('AOQ phone owns microphone PCM'))
  }
}
