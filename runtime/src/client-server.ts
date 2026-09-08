import type {ClientPairing} from './client-pairing.js'
import {randomUUID} from 'node:crypto'
import {WebSocket, WebSocketServer, type RawData} from 'ws'
import {
  authenticateDesktopFrame, DesktopProtocolError, MAX_DESKTOP_JSON_BYTES,
  validateDesktopToken, type DesktopReadiness, type DesktopServerOptions,
} from './desktop.js'
import {MAX_DESKTOP_PCM_BYTES, validateInputPcm} from './desktop-wire.js'
import {CLIENT_PATH, ClientCommands, clientReady, decodeClientAudioFrame, acceptsClientMedia, clientMediaSchema, type ClientMedia} from './client-protocol.js'

const MAX_BUFFERED_BYTES = 256 * 1024
const MAX_PENDING_SENDS = 128

interface Connection {
  readonly socket: WebSocket
  readonly id: string
  readonly commands: ClientCommands
  authenticated: boolean
  pendingBytes: number
  pendingMessages: number
  pendingSends: number
}

/** Private remote endpoint. Owns sockets only; a network failure never stops the agent graph. */
export class ClientServer {
  readonly #options: DesktopServerOptions & {readonly port: number; readonly media?: ClientMedia; readonly pairing?: ClientPairing}
  readonly #instanceId = randomUUID()
  #server: WebSocketServer | undefined
  #active: Connection | undefined
  #closed = false

  constructor(options: DesktopServerOptions & {readonly port: number; readonly media?: ClientMedia; readonly pairing?: ClientPairing}) {
    validateDesktopToken(options.token)
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new DesktopProtocolError('client port is invalid')
    }
    const timeout = options.authTimeoutMs ?? 3000
    if (!Number.isFinite(timeout) || timeout <= 0) throw new DesktopProtocolError('client auth timeout is invalid')
    this.#options = {...options, ...(options.media === undefined ? {} : {media: clientMediaSchema.parse(options.media)})}
  }

  async start(): Promise<DesktopReadiness> {
    if (this.#server || this.#closed) throw new Error('client server already started or stopped')
    const server = new WebSocketServer({host: '127.0.0.1', port: this.#options.port,
      maxPayload: MAX_DESKTOP_PCM_BYTES, perMessageDeflate: false})
    this.#server = server
    server.on('connection', (socket, request) => {
      socket.on('error', () => { /* close owns cleanup */ })
      if (!this.#closed && this.#options.pairing?.handle(socket, request.url)) return
      if (request.url !== CLIENT_PATH) { socket.close(4004, 'unsupported endpoint'); return }
      if (this.#active || this.#closed) { socket.close(4009, 'client busy'); return }
      this.#accept(socket)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    // A listening-server error is diagnostic, not an unhandled EventEmitter exception.
    server.on('error', () => { /* active transports report their own failures */ })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('client server did not bind')
    return {token: this.#options.token, host: '127.0.0.1', port: address.port}
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.disconnectClient()
    const server = this.#server
    this.#server = undefined
    if (!server) return
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  disconnectClient(): Promise<void> {
    const connection = this.#active
    if (!connection) return Promise.resolve()
    this.#release(connection)
    connection.socket.terminate()
    return Promise.resolve()
  }

  async sendText(raw: string): Promise<void> {
    if (Buffer.byteLength(raw) > MAX_DESKTOP_JSON_BYTES) throw new DesktopProtocolError('client output text too large')
    const value = JSON.parse(raw) as {type?: unknown} | null
    if (!value || typeof value.type !== 'string') throw new DesktopProtocolError('invalid client output')
    await this.#send(this.#requireActive(), raw)
  }

  async sendBinary(raw: Uint8Array): Promise<void> {
    decodeClientAudioFrame(raw)
    await this.#send(this.#requireActive(), new Uint8Array(raw))
  }

  #requireActive(): Connection {
    const connection = this.#active
    if (!connection?.authenticated) throw new Error('client unavailable')
    return connection
  }

  #release(connection: Connection): void {
    if (this.#active !== connection) return
    this.#active = undefined
    if (connection.authenticated) { this.#options.onClientDisconnect?.() }
  }

  #reject(connection: Connection, code = 4003): void {
    this.#release(connection)
    connection.socket.close(code, code === 4008 ? 'refresh connection' : 'client protocol rejected')
    // Closing peers must not retain unbounded sockets if they never complete the handshake.
    const timer = setTimeout(() => connection.socket.terminate(), 500)
    timer.unref()
    connection.socket.once('close', () => clearTimeout(timer))
  }

  #accept(socket: WebSocket): void {
    const id = randomUUID()
    const connection: Connection = {socket, id, commands: new ClientCommands(id),
      authenticated: false, pendingBytes: 0, pendingMessages: 0, pendingSends: 0}
    this.#active = connection
    const timer = setTimeout(() => this.#reject(connection), this.#options.authTimeoutMs ?? 3000)
    socket.once('close', () => { clearTimeout(timer); this.#release(connection) })
    let processing = Promise.resolve()
    socket.on('message', (data: RawData, binary: boolean) => {
      if (this.#active !== connection) return
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      connection.pendingBytes += bytes.byteLength
      connection.pendingMessages++
      if (connection.pendingBytes > MAX_BUFFERED_BYTES || connection.pendingMessages > 128) {
        this.#reject(connection)
        return
      }
      processing = processing.then(async () => {
        if (this.#active !== connection) return
        if (!connection.authenticated) {
          if (binary || bytes.byteLength > MAX_DESKTOP_JSON_BYTES) throw new DesktopProtocolError('invalid client hello')
          const raw = bytes.toString('utf8')
          const credential = this.#options.pairing?.authenticate(raw)
          if (credential === undefined) authenticateDesktopFrame(raw, this.#options.token)
          const hello = JSON.parse(raw) as {protocol_version?: unknown; media?: unknown}
          if (hello.protocol_version !== 1 || !acceptsClientMedia(hello.media)) { this.#reject(connection, 4006); return }
          connection.authenticated = true
          if (credential !== undefined) {
            const untrack = this.#options.pairing!.track(credential, () => this.#reject(connection, 4003))
            socket.once('close', untrack)
          }
          clearTimeout(timer)
          await this.#send(connection, clientReady(this.#instanceId, id, this.#options.media))
          if (this.#active === connection) {
            await this.#options.onClientAuthenticated?.()
          }
        } else if (binary) {
          const pcm = validateInputPcm(bytes)
          if (pcm.length === 0) throw new DesktopProtocolError('empty client PCM')
          // A provider may be reconnecting; discard this frame without blaming the client.
          try { await this.#options.onAudio?.(pcm) } catch { /* provider owns recovery */ }
        } else {
          const result = await connection.commands.receive(bytes.toString('utf8'), control => {
            if (this.#active !== connection) throw new Error('stale client')
            if (this.#options.onControl === undefined) throw new Error('control consumer unavailable')
            return this.#options.onControl(control)
          })
          if (this.#active !== connection) return
          await this.#send(connection, JSON.stringify(result))
          if (connection.commands.full) this.#reject(connection, 4008)
        }
      }).catch(() => this.#reject(connection))
        .finally(() => { connection.pendingBytes -= bytes.byteLength; connection.pendingMessages-- })
    })
  }

  async #send(connection: Connection, raw: string | Uint8Array): Promise<void> {
    const socket = connection.socket
    if (this.#active !== connection || socket.readyState !== WebSocket.OPEN) throw new Error('client unavailable')
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength
    if (socket.bufferedAmount + size > MAX_BUFFERED_BYTES || connection.pendingSends >= MAX_PENDING_SENDS) {
      this.#reject(connection, 4008)
      throw new Error('client send queue full')
    }
    connection.pendingSends++
    try {
      await new Promise<void>((resolve, reject) => {
        socket.send(raw, {binary: typeof raw !== 'string'}, error => error ? reject(error) : resolve())
      })
    } catch (error) {
      this.#reject(connection)
      throw error
    } finally { connection.pendingSends-- }
  }
}
