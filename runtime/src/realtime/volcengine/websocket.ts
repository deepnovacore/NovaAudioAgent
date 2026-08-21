import { WebSocket, type RawData } from 'ws'

export const MAX_VOLC_SOCKET_BACKLOG_FRAMES = 256
export const MAX_VOLC_SOCKET_BACKLOG_BYTES = 16 * 1_024 * 1_024
export const DEFAULT_VOLC_CONNECT_TIMEOUT_MS = 20_000
export const DEFAULT_VOLC_RECEIVE_TIMEOUT_MS = 15_000
export const DEFAULT_VOLC_CLOSE_TIMEOUT_MS = 1_000

export type VolcSocketFailureCode =
  | 'aborted'
  | 'timeout'
  | 'protocol'
  | 'overflow'
  | 'concurrent_receive'
  | 'closed'
  | 'network'

export class VolcSocketFailure extends Error {
  readonly code: VolcSocketFailureCode

  constructor(code: VolcSocketFailureCode) {
    super(`Volcengine binary socket ${code}`)
    this.name = 'VolcSocketFailure'
    this.code = code
  }
}

export interface VolcBinarySocket {
  send(frame: Uint8Array, signal?: AbortSignal): Promise<void>
  receive(signal?: AbortSignal): Promise<Uint8Array>
  close(): Promise<void>
}

export interface VolcBinaryConnectorOptions {
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly openTimeoutMs: number
  readonly closeTimeoutMs: number
  readonly maxFrameBytes: number
  readonly signal: AbortSignal
}

export type VolcBinaryConnector = (
  options: VolcBinaryConnectorOptions,
) => Promise<VolcBinarySocket>

interface ReceiveWaiter {
  readonly resolve: (frame: Uint8Array) => void
  readonly reject: (error: VolcSocketFailure) => void
  readonly cleanup: () => void
}

class WebSocketVolcBinarySocket implements VolcBinarySocket {
  readonly #socket: WebSocket
  readonly #closeTimeoutMs: number
  readonly #maxFrameBytes: number
  readonly #queued: Uint8Array[] = []
  #queuedBytes = 0
  #waiter: ReceiveWaiter | undefined
  #failure: VolcSocketFailure | undefined
  #closed = false
  #accepting = true
  #sendTail: Promise<void> = Promise.resolve()
  #closePromise: Promise<void> | undefined

  readonly #onMessage = (data: RawData, isBinary: boolean): void => {
    if (!this.#accepting || this.#failure !== undefined) return
    if (!isBinary) {
      this.#fail(new VolcSocketFailure('protocol'))
      return
    }
    const frame = copyRawData(data)
    if (frame.byteLength > this.#maxFrameBytes) {
      this.#fail(new VolcSocketFailure('overflow'))
      return
    }
    const waiter = this.#waiter
    if (waiter !== undefined) {
      this.#waiter = undefined
      waiter.cleanup()
      waiter.resolve(frame)
      return
    }
    if (this.#queued.length >= MAX_VOLC_SOCKET_BACKLOG_FRAMES
      || this.#queuedBytes + frame.byteLength > MAX_VOLC_SOCKET_BACKLOG_BYTES) {
      this.#fail(new VolcSocketFailure('overflow'))
      return
    }
    this.#queued.push(frame)
    this.#queuedBytes += frame.byteLength
  }

  readonly #onError = (error: Error): void => {
    const code = 'code' in error ? error.code : undefined
    this.#fail(new VolcSocketFailure(
      code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'overflow' : 'network',
    ))
  }

  readonly #onClose = (): void => {
    this.#closed = true
    this.#accepting = false
    const waiter = this.#waiter
    if (waiter !== undefined) {
      this.#waiter = undefined
      waiter.cleanup()
      waiter.reject(this.#failure ?? new VolcSocketFailure('closed'))
    }
  }

  constructor(
    socket: WebSocket,
    options: {readonly closeTimeoutMs: number; readonly maxFrameBytes: number},
  ) {
    this.#socket = socket
    this.#closeTimeoutMs = options.closeTimeoutMs
    this.#maxFrameBytes = options.maxFrameBytes
    socket.on('message', this.#onMessage)
    socket.on('error', this.#onError)
    socket.on('close', this.#onClose)
  }

  send(frame: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!(frame instanceof Uint8Array)) return Promise.reject(new VolcSocketFailure('protocol'))
    if (frame.byteLength > this.#maxFrameBytes) {
      const failure = new VolcSocketFailure('overflow')
      this.#fail(failure)
      return Promise.reject(failure)
    }
    if (signal?.aborted === true) return Promise.reject(new VolcSocketFailure('aborted'))
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (!this.#accepting || this.#closed) return Promise.reject(new VolcSocketFailure('closed'))
    const owned = new Uint8Array(frame)
    const operation = this.#sendTail.then(() => this.#write(owned, signal))
    this.#sendTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  receive(signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#waiter !== undefined) {
      return Promise.reject(new VolcSocketFailure('concurrent_receive'))
    }
    const next = this.#queued.shift()
    if (next !== undefined) {
      this.#queuedBytes -= next.byteLength
      return Promise.resolve(next)
    }
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (!this.#accepting || this.#closed) return Promise.reject(new VolcSocketFailure('closed'))
    if (signal?.aborted === true) return Promise.reject(new VolcSocketFailure('aborted'))
    return new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = (): void => {
        const waiter = this.#waiter
        if (waiter === undefined) return
        this.#waiter = undefined
        waiter.cleanup()
        reject(new VolcSocketFailure('aborted'))
      }
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
      this.#waiter = {resolve, reject, cleanup}
      signal?.addEventListener('abort', onAbort, {once: true})
      if (signal?.aborted === true) onAbort()
    })
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#accepting = false
    const waiter = this.#waiter
    if (waiter !== undefined) {
      this.#waiter = undefined
      waiter.cleanup()
      waiter.reject(new VolcSocketFailure('closed'))
    }
    this.#closePromise = this.#performClose()
    return this.#closePromise
  }

  async #write(frame: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new VolcSocketFailure('aborted')
    if (this.#failure !== undefined) throw this.#failure
    if (!this.#accepting || this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new VolcSocketFailure('closed')
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.send(frame, error => {
        if (error === undefined || error === null) {
          resolve()
          return
        }
        const failure = new VolcSocketFailure('network')
        this.#fail(failure)
        reject(failure)
      })
    })
  }

  async #performClose(): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let onClosed: (() => void) | undefined
    let terminated = false
    try {
      if (this.#socket.readyState === WebSocket.CLOSED) return
      await new Promise<void>(resolve => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        onClosed = finish
        this.#socket.once('close', finish)
        timer = setTimeout(() => {
          terminated = true
          this.#socket.terminate()
          finish()
        }, this.#closeTimeoutMs)
        if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close(1000)
        else {
          terminated = true
          this.#socket.terminate()
        }
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onClosed !== undefined) this.#socket.off('close', onClosed)
      if (!terminated && this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate()
      this.#closed = true
      this.#clearQueue()
      this.#socket.off('message', this.#onMessage)
      this.#socket.off('error', this.#onError)
      this.#socket.off('close', this.#onClose)
    }
  }

  #fail(failure: VolcSocketFailure): void {
    if (this.#failure !== undefined) return
    this.#failure = failure
    this.#accepting = false
    this.#clearQueue()
    const waiter = this.#waiter
    if (waiter !== undefined) {
      this.#waiter = undefined
      waiter.cleanup()
      waiter.reject(failure)
    }
    this.#socket.terminate()
  }

  #clearQueue(): void {
    this.#queued.length = 0
    this.#queuedBytes = 0
  }
}

function copyRawData(data: RawData | ArrayBufferView): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  throw new VolcSocketFailure('protocol')
}

export const webSocketVolcBinaryConnector: VolcBinaryConnector = options =>
  new Promise<VolcBinarySocket>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new VolcSocketFailure('aborted'))
      return
    }
    if (!Number.isSafeInteger(options.openTimeoutMs) || options.openTimeoutMs < 1
      || !Number.isSafeInteger(options.closeTimeoutMs) || options.closeTimeoutMs < 1
      || !Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1) {
      reject(new VolcSocketFailure('protocol'))
      return
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(options.endpoint, {
        headers: {...options.headers},
        handshakeTimeout: options.openTimeoutMs,
        maxPayload: options.maxFrameBytes,
        perMessageDeflate: false,
      })
    } catch {
      reject(new VolcSocketFailure('network'))
      return
    }
    const wrapped = new WebSocketVolcBinarySocket(socket, options)
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      socket.off('open', onOpen)
      socket.off('error', onError)
      options.signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      outcome()
    }
    const dispose = (): void => {
      socket.terminate()
      void wrapped.close().catch(() => undefined)
    }
    const onOpen = (): void => settle(() => resolve(wrapped))
    const onError = (): void => settle(() => {
      dispose()
      reject(new VolcSocketFailure('network'))
    })
    const onAbort = (): void => settle(() => {
      dispose()
      reject(new VolcSocketFailure('aborted'))
    })
    socket.once('open', onOpen)
    socket.once('error', onError)
    options.signal.addEventListener('abort', onAbort, {once: true})
    const timer = setTimeout(() => settle(() => {
      dispose()
      reject(new VolcSocketFailure('timeout'))
    }), options.openTimeoutMs)
    if (options.signal.aborted) onAbort()
  })
