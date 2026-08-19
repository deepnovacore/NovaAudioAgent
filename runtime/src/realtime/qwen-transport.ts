/**
 * Real WebSocket transport for the Qwen adapter.
 *
 * Kept out of `qwen.ts` so the protocol stays testable without a socket, and so
 * nothing in the adapter's own tests can accidentally reach the network.
 */

import { WebSocket, type RawData } from 'ws'
import {
  QwenSocketClosedError,
  type QwenConnector,
  type QwenConnectorOptions,
  type QwenSocket,
} from './qwen.js'

/** Bounds the inbound backlog so a firehose cannot grow memory without limit. */
export const MAX_QWEN_INBOUND_BACKLOG = 1_024

class WebSocketQwenSocket implements QwenSocket {
  readonly #socket: WebSocket
  readonly #inbound: string[] = []
  #waiter: (() => void) | undefined
  #closed = false
  #failure: Error | undefined

  constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on('message', (data: RawData, isBinary: boolean) => {
      // The Qwen realtime protocol is JSON text; audio arrives base64 inside it.
      if (isBinary) return
      if (this.#inbound.length >= MAX_QWEN_INBOUND_BACKLOG) {
        this.#fail(new Error('qwen inbound backlog overflowed'))
        return
      }
      this.#inbound.push(textOf(data))
      this.#wake()
    })
    socket.on('error', error => {
      this.#fail(error instanceof Error ? error : new Error('qwen socket error'))
    })
    socket.on('close', () => {
      this.#closed = true
      this.#wake()
    })
  }

  send(payload: string): Promise<void> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new QwenSocketClosedError())
    }
    return new Promise<void>((resolve, reject) => {
      this.#socket.send(payload, error => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })
  }

  async receive(): Promise<string> {
    for (;;) {
      const next = this.#inbound.shift()
      if (next !== undefined) return next
      if (this.#failure !== undefined) throw this.#failure
      // Drain before reporting EOF so frames already buffered are never lost.
      if (this.#closed) throw new QwenSocketClosedError()
      await new Promise<void>(resolve => { this.#waiter = resolve })
    }
  }

  close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.#socket.once('close', () => resolve())
      if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close(1000)
      else this.#socket.terminate()
    })
  }

  #fail(error: Error): void {
    this.#failure ??= error
    this.#wake()
  }

  #wake(): void {
    const waiter = this.#waiter
    this.#waiter = undefined
    waiter?.()
  }
}

function textOf(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString('utf8')
}

export const webSocketQwenConnector: QwenConnector = (
  options: QwenConnectorOptions,
): Promise<QwenSocket> => new Promise<QwenSocket>((resolve, reject) => {
  const socket = new WebSocket(options.endpoint, {
    headers: {...options.headers},
    handshakeTimeout: Math.max(1, Math.floor(options.openTimeout * 1000)),
    perMessageDeflate: false,
  })
  // Wrap before 'open' so frames a fast server sends immediately are buffered
  // rather than dropped between the handshake and the first receive().
  const wrapped = new WebSocketQwenSocket(socket)
  const settle = (outcome: () => void): void => {
    socket.off('open', onOpen)
    socket.off('error', onError)
    options.signal.removeEventListener('abort', onAbort)
    outcome()
  }
  const onOpen = (): void => settle(() => resolve(wrapped))
  const onError = (error: unknown): void => settle(() => {
    socket.terminate()
    // Never surface the provider's message: the endpoint carries the model and the
    // request carries the credential.
    void error
    reject(new Error('qwen realtime websocket failed to open'))
  })
  const onAbort = (): void => settle(() => {
    socket.terminate()
    reject(new Error('qwen realtime connect aborted'))
  })
  socket.once('open', onOpen)
  socket.once('error', onError)
  options.signal.addEventListener('abort', onAbort, {once: true})
})
