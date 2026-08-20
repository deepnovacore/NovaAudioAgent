import { timingSafeEqual } from 'node:crypto'
import { createConnection } from 'node:net'
import { z } from 'zod'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

export const MAX_DESKTOP_JSON_BYTES = 16 * 1024
export const MAX_DESKTOP_PCM_BYTES = 64 * 1024
export const MAX_DESKTOP_OUTBOUND_BINARY_BYTES = 8 * 1024 * 1024
export const MAX_DESKTOP_PENDING_SENDS = 128
export const DESKTOP_AUTH_TIMEOUT_MS = 3_000
export const DESKTOP_CLOSE_GRACE_MS = 500
export const DESKTOP_READY_TIMEOUT_MS = 5_000

const tokenPattern = /^[a-f0-9]{32}$/u
const readyEndpointPattern = /^127\.0\.0\.1:([0-9]{1,5})$/u
const identifierSchema = z.string().max(256).refine(value => value.trim().length > 0)
const renderTimestampSchema = z.number().finite().nonnegative().optional()

const helloSchema = z.object({
  type: z.literal('hello'),
  token: z.string(),
})
const DEFAULT_BOOTSTRAP_TEXT_FRAMES = [
  '{"type":"desktop.ready"}',
  '{"type":"codex.state","state":"idle"}',
] as const

export const desktopControlSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('speech.onset'),
    speech_id: identifierSchema,
    t_render_ms: renderTimestampSchema,
  }),
  z.object({
    type: z.literal('playback.started'),
    utterance_id: identifierSchema,
    generation_epoch: z.number().int().positive(),
    t_render_ms: renderTimestampSchema,
  }),
  ...(['playback.stopped', 'playback.done', 'playback.cleared'] as const)
    .map(type => z.object({
      type: z.literal(type),
      utterance_id: identifierSchema,
      generation_epoch: z.number().int().positive(),
      played_ms: z.number().int().nonnegative().optional(),
      t_render_ms: renderTimestampSchema,
    })),
  z.object({
    type: z.literal('memory.board.request'),
    request_id: identifierSchema,
  }),
  z.object({
    type: z.literal('clock.pong'),
    ping_id: identifierSchema,
    t_render_ms: z.number().finite().nonnegative(),
  }),
])

export type DesktopControl = z.infer<typeof desktopControlSchema>

export class DesktopProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopProtocolError'
  }
}

export interface DesktopServerOptions {
  readonly token: string
  readonly onControl?: (control: DesktopControl) => void | Promise<void>
  readonly onAudio?: (pcm: Uint8Array) => void | Promise<void>
  readonly onClientDisconnect?: () => void
  readonly onClientAuthenticated?: () => void | Promise<void>
  readonly bootstrapTextFrames?: readonly string[]
  readonly authTimeoutMs?: number
  readonly closeGraceMs?: number
}

export interface DesktopReadiness {
  readonly token: string
  readonly host: '127.0.0.1'
  readonly port: number
}

export class NodeDesktopServer {
  readonly #options: DesktopServerOptions
  #server: WebSocketServer | undefined
  #active: WebSocket | undefined
  #authenticated = false
  readonly #pendingSends: PendingDesktopSend[] = []
  #currentSend: PendingDesktopSend | undefined
  #writerRunning = false
  #pendingSendCount = 0
  #stopping = false
  #closing: Promise<void> | undefined

  constructor(options: DesktopServerOptions) {
    validateDesktopToken(options.token)
    const timeout = options.authTimeoutMs ?? DESKTOP_AUTH_TIMEOUT_MS
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new DesktopProtocolError('desktop authentication timeout is invalid')
    }
    const closeGrace = options.closeGraceMs ?? DESKTOP_CLOSE_GRACE_MS
    if (!Number.isFinite(closeGrace) || closeGrace <= 0) {
      throw new DesktopProtocolError('desktop close grace is invalid')
    }
    this.#options = {
      ...options,
      authTimeoutMs: timeout,
      closeGraceMs: closeGrace,
      bootstrapTextFrames: copyBootstrapTextFrames(options.bootstrapTextFrames),
    }
  }

  async sendText(raw: string): Promise<void> {
    if (!this.#canSend()) throw outboundUnavailableError()
    validateOutboundText(raw)
    return this.#enqueueSend(this.#active!, raw)
  }

  async sendBinary(raw: Uint8Array): Promise<void> {
    if (!this.#canSend()) throw outboundUnavailableError()
    validateOutboundBinary(raw)
    // The caller may reuse its buffer after the Promise is returned. The queued
    // frame must remain exactly the bytes accepted at this boundary.
    return this.#enqueueSend(this.#active!, new Uint8Array(raw))
  }

  /** Retire only the client active when this call begins; a later reconnect is never its target. */
  async disconnectClient(): Promise<void> {
    const active = this.#active
    if (active === undefined) return
    await closeWebSocket(active, this.#options.closeGraceMs ?? DESKTOP_CLOSE_GRACE_MS)
    this.#notifyDisconnected(active)
  }

  async start(): Promise<DesktopReadiness> {
    if (this.#server !== undefined || this.#stopping) {
      throw new Error('desktop server already started or stopped')
    }
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      maxPayload: MAX_DESKTOP_PCM_BYTES,
      perMessageDeflate: false,
    })
    this.#server = server
    server.on('connection', socket => this.#accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('desktop loopback server did not bind')
    }
    return {token: this.#options.token, host: '127.0.0.1', port: address.port}
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#stopping = true
    this.#closing = this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    const active = this.#active
    const activeClosed = active === undefined ? Promise.resolve() : closeWebSocket(
      active,
      this.#options.closeGraceMs ?? DESKTOP_CLOSE_GRACE_MS,
    )
    if (server === undefined) {
      await activeClosed
      this.#notifyDisconnected(active)
      return
    }
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
    })
    await Promise.all([activeClosed, serverClosed])
    this.#notifyDisconnected(active)
  }

  #accept(socket: WebSocket): void {
    if (this.#active !== undefined || this.#stopping) {
      socket.close(4009, 'desktop client already connected')
      return
    }
    this.#active = socket
    // `ws` reports protocol and max-payload failures through this event before
    // closing the peer. The close code remains the renderer-visible verdict.
    socket.on('error', error => { void error })
    let authenticated = false
    let rejected = false
    let processing = Promise.resolve()
    const authTimer = setTimeout(() => socket.close(4003, 'desktop protocol rejected'),
      this.#options.authTimeoutMs)

    socket.on('message', (data, isBinary) => {
      processing = processing.then(async () => {
        // One rejection is terminal. Without this latch a peer could keep
        // guessing tokens on the same socket in the window before close settles.
        if (rejected) return
        if (!authenticated) {
          if (isBinary) throw new DesktopProtocolError('desktop authentication frame must be text')
          authenticateDesktopFrame(rawText(data), this.#options.token)
          authenticated = true
          this.#authenticated = true
          clearTimeout(authTimer)
          for (const frame of this.#options.bootstrapTextFrames ?? []) {
            await this.#enqueueSend(socket, frame)
          }
          await this.#options.onClientAuthenticated?.()
          return
        }
        if (isBinary) {
          const pcm = rawBytes(data)
          if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
            throw new DesktopProtocolError('desktop input must be aligned PCM16 bytes')
          }
          await this.#options.onAudio?.(pcm)
          return
        }
        await this.#options.onControl?.(parseDesktopControl(rawText(data)))
      }).catch(() => {
        rejected = true
        socket.close(4003, 'desktop protocol rejected')
      })
    })
    socket.once('close', () => {
      clearTimeout(authTimer)
      this.#notifyDisconnected(socket)
    })
  }

  #notifyDisconnected(socket: WebSocket | undefined): void {
    if (socket === undefined || this.#active !== socket) return
    this.#active = undefined
    this.#authenticated = false
    this.#rejectSocketSends(socket, outboundUnavailableError())
    this.#options.onClientDisconnect?.()
  }

  #canSend(): boolean {
    return !this.#stopping && this.#active !== undefined && this.#authenticated
  }

  #enqueueSend(socket: WebSocket, raw: string | Uint8Array): Promise<void> {
    if (this.#pendingSendCount >= MAX_DESKTOP_PENDING_SENDS) {
      return Promise.reject(new DesktopProtocolError('desktop outbound send queue is full'))
    }
    this.#pendingSendCount += 1
    const pending = new PendingDesktopSend(socket, raw)
    this.#pendingSends.push(pending)
    void this.#drainSends()
    return pending.promise
  }

  async #drainSends(): Promise<void> {
    if (this.#writerRunning) return
    this.#writerRunning = true
    try {
      while (this.#pendingSends.length > 0) {
        const pending = this.#pendingSends.shift()!
        this.#currentSend = pending
        if (this.#active !== pending.socket || !this.#authenticated || this.#stopping) {
          this.#settleSend(pending, outboundUnavailableError())
          this.#currentSend = undefined
          continue
        }
        try {
          await sendWebSocketFrame(pending.socket, pending.raw)
          this.#settleSend(pending)
        } catch {
          this.#settleSend(pending, new DesktopProtocolError('desktop outbound send failed'))
          this.#closeFailedSocket(pending.socket)
        }
        this.#currentSend = undefined
      }
    } finally {
      this.#writerRunning = false
      if (this.#pendingSends.length > 0) void this.#drainSends()
    }
  }

  #settleSend(pending: PendingDesktopSend, error?: DesktopProtocolError): void {
    if (pending.settled) return
    pending.settled = true
    this.#pendingSendCount -= 1
    if (error === undefined) pending.resolve()
    else pending.reject(error)
  }

  #rejectSocketSends(socket: WebSocket, error: DesktopProtocolError): void {
    if (this.#currentSend?.socket === socket) this.#settleSend(this.#currentSend, error)
    for (const pending of this.#pendingSends) {
      if (pending.socket === socket) this.#settleSend(pending, error)
    }
  }

  #closeFailedSocket(socket: WebSocket): void {
    this.#notifyDisconnected(socket)
    if (socket.readyState < WebSocket.CLOSING) {
      socket.close(4003, 'desktop protocol rejected')
    }
  }
}

class PendingDesktopSend {
  readonly promise: Promise<void>
  settled = false
  readonly resolve: () => void
  readonly reject: (error: DesktopProtocolError) => void

  constructor(
    readonly socket: WebSocket,
    readonly raw: string | Uint8Array,
  ) {
    let resolve: (() => void) | undefined
    let reject: ((error: DesktopProtocolError) => void) | undefined
    this.promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    this.resolve = resolve as () => void
    this.reject = reject as (error: DesktopProtocolError) => void
  }
}

export function validateDesktopToken(token: string): void {
  if (!tokenPattern.test(token)) {
    throw new DesktopProtocolError('desktop token must be 128-bit lowercase hexadecimal')
  }
}

function copyBootstrapTextFrames(frames: readonly string[] | undefined): readonly string[] {
  const copied = [...(frames ?? DEFAULT_BOOTSTRAP_TEXT_FRAMES)]
  for (const frame of copied) validateOutboundText(frame, 'desktop bootstrap frame')
  return copied
}

function validateOutboundText(raw: string, label = 'desktop outbound text frame'): void {
  if (typeof raw !== 'string') {
    throw new DesktopProtocolError(`${label} is invalid`)
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_DESKTOP_JSON_BYTES) {
    throw new DesktopProtocolError(`${label} is too large`)
  }
}

function validateOutboundBinary(raw: Uint8Array): void {
  if (!(raw instanceof Uint8Array)) {
    throw new DesktopProtocolError('desktop outbound binary frame is invalid')
  }
  if (raw.byteLength > MAX_DESKTOP_OUTBOUND_BINARY_BYTES) {
    throw new DesktopProtocolError('desktop outbound binary frame is too large')
  }
}

function outboundUnavailableError(): DesktopProtocolError {
  return new DesktopProtocolError('desktop outbound send is unavailable')
}

function sendWebSocketFrame(socket: WebSocket, raw: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(raw, {binary: typeof raw !== 'string'}, error => {
      if (error == null) resolve()
      else reject(error)
    })
  })
}

export function authenticateDesktopFrame(raw: string, expectedToken: string): void {
  validateDesktopToken(expectedToken)
  const value = parseBoundedJson(raw)
  const parsed = helloSchema.safeParse(value)
  if (!parsed.success || !safeTokenEqual(parsed.data.token, expectedToken)) {
    throw new DesktopProtocolError('desktop authentication failed')
  }
}

export function parseDesktopControl(raw: string): DesktopControl {
  const result = desktopControlSchema.safeParse(parseBoundedJson(raw))
  if (!result.success) throw new DesktopProtocolError('desktop control frame is unsupported')
  return result.data
}

export function parseReadyEndpoint(raw: string): {readonly host: '127.0.0.1', readonly port: number} {
  const match = readyEndpointPattern.exec(raw.trim())
  const port = match === null ? 0 : Number(match[1])
  if (port < 1 || port > 65_535) {
    throw new DesktopProtocolError('desktop readiness endpoint is invalid')
  }
  return {host: '127.0.0.1', port}
}

export async function announceReadiness(
  endpoint: string,
  readiness: DesktopReadiness,
  timeoutMs = DESKTOP_READY_TIMEOUT_MS,
): Promise<void> {
  validateDesktopToken(readiness.token)
  if (readiness.host !== '127.0.0.1' || !Number.isInteger(readiness.port)
    || readiness.port < 1 || readiness.port > 65_535) {
    throw new DesktopProtocolError('desktop readiness payload is invalid')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DesktopProtocolError('desktop readiness timeout is invalid')
  }
  const target = parseReadyEndpoint(endpoint)
  const line = `${JSON.stringify(readiness)}\n`
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(target)
    // The handshake is one line followed by EOF. A parent that accepts the
    // connection and then never closes it must not hang startup indefinitely
    // with no diagnostic.
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new DesktopProtocolError('desktop readiness announcement timed out'))
    }, timeoutMs)
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once('connect', () => socket.end(line))
    socket.once('close', hadError => {
      if (hadError) return
      clearTimeout(timer)
      resolve()
    })
  })
}

function parseBoundedJson(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > MAX_DESKTOP_JSON_BYTES) {
    throw new DesktopProtocolError('desktop control frame is too large')
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new DesktopProtocolError('desktop control frame is invalid JSON')
  }
}

function safeTokenEqual(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes)
}

function rawText(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString('utf8')
}

function rawBytes(data: RawData): Uint8Array {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
  if (bytes.byteLength > MAX_DESKTOP_PCM_BYTES) {
    throw new DesktopProtocolError('desktop input PCM frame is too large')
  }
  // Copy rather than view. `ws` allocates receive buffers from a shared pool, so
  // a view would alias bytes that a later frame overwrites, and the realtime
  // uplink holds PCM across await points before it reaches a provider.
  return new Uint8Array(bytes)
}

async function closeWebSocket(socket: WebSocket, graceMs: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    socket.once('close', finish)
    const timer = setTimeout(() => {
      socket.terminate()
      finish()
    }, graceMs)
    if (socket.readyState < WebSocket.CLOSING) socket.close(1001, 'shutdown')
  })
}
