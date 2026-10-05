import {parsePromptLanguage} from '../realtime/prompt-language.js'
import type {ClientPairing} from './client-pairing.js'
import {randomUUID} from 'node:crypto'
import {WebSocket, WebSocketServer, type RawData} from 'ws'
import {
  authenticateDesktopFrame, DesktopProtocolError, MAX_DESKTOP_JSON_BYTES,
  validateDesktopToken, type DesktopReadiness, type DesktopServerOptions,
} from '../desktop.js'
import {MAX_DESKTOP_PCM_BYTES, validateInputPcm} from '../desktop/desktop-wire.js'
import {NEWS_SOURCES} from '../news/feeds.js'
import {CLIENT_PATH, ClientCommands, clientReady, decodeClientAudioFrame, acceptsClientMedia, clientMediaSchema, type ClientMedia} from './client-protocol.js'

const MAX_BUFFERED_BYTES = 256 * 1024
const MAX_PENDING_SENDS = 128
const MAX_PERSONAL_BYTES = 1024 * 1024
const MOBILE_METHODS = new Set(['state', 'life.mutate', 'feed.action', 'memory.list', 'memory.evidence', 'memory.correct', 'memory.forget', 'memory.purge', 'conversations.read', 'conversations.create', 'conversations.select', 'conversations.open_work', 'conversations.clear', 'conversations.confirm', 'conversations.open_feed', 'conversations.voice', 'conversations.approve', 'presentation.set', 'presentation.seen', 'tasks.list', 'tasks.get', 'tasks.delegate', 'tasks.control', 'tasks.input', 'tasks.cancel', 'tasks.continue', 'tasks.reconcile', 'tasks.complete_todo', 'context.adopt', 'context.dismiss'])

/** Explicit mobile projection: new desktop fields are private by default. */
function mobileSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const keys = ['type', 'revision', 'reload_required', 'life', 'tasks', 'conversations', 'feed', 'memory', 'pending_approvals', 'pending_confirmations']
  const result = Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]))
  // Mobile displays the same ranked/saved articles without source configuration.
  if (value.news && typeof value.news === 'object' && !Array.isArray(value.news)) {
    const news = value.news as Record<string, unknown>
    const articleKeys = ['id', 'source_id', 'title', 'summary', 'url', 'published_at', 'read', 'saved']
    const articles = (rows: unknown) => Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object').map(row => {
      const article = row as Record<string, unknown>
      const name = NEWS_SOURCES.find(source => source.id === article.source_id)?.name
      return {...Object.fromEntries(articleKeys.filter(key => key in article).map(key => [key, article[key]])), ...(name ? {source_name: name} : {})}
    }) : []
    result.news = {enabled: news.enabled === true, refreshing: news.refreshing === true,
      items: articles(news.items), saved: articles(news.saved)}
  }
  // Suggestions and the Profile draft carry no source excerpts: mobile shows how many sources back them.
  const record = (input: unknown) => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  const text = (input: unknown) => typeof input === 'string' ? input : null
  const list = (input: unknown) => Array.isArray(input) ? input.map(record).filter(item => item !== null) : []
  const context = record(value.workbench_context)
  if (context) {
    const recap = record(context.recap)
    result.workbench_context = {status: text(context.status),
      recap: {text: text(recap?.text), projects: list(recap?.projects).map(project => ({name: text(project.name), line: text(project.line)}))},
      cards: list(context.cards).map(card => ({id: text(card.id), tab: text(card.tab), title: text(card.title), body: text(card.body),
        why: text(card.why), next: text(card.next), source_count: Array.isArray(card.refs) ? card.refs.length : 0}))}
  }
  const preparation = record(value.profile_preparation), draft = record(preparation?.draft)
  if (preparation) {
    result.profile_preparation = {status: text(preparation.status), draft: draft ? {
      about: text(record(draft.about)?.text),
      work: list(draft.work).map(item => ({title: text(item.title), text: text(item.text)}))} : null}
  }
  if (value.capabilities && typeof value.capabilities === 'object') {
    const caps = value.capabilities as Record<string, unknown>
    result.capabilities = Object.fromEntries(['tasks', 'memory'].filter(key => key in caps).map(key => [key, caps[key]]))
  }
  return result
}

interface Connection {
  readonly socket: WebSocket
  readonly id: string
  readonly commands: ClientCommands
  personal?: boolean
  legacyConversationId?: string
  snapshot?: string | undefined
  snapshotTimer?: ReturnType<typeof setTimeout> | undefined
  clientId?: string
  authenticated: boolean
  pendingBytes: number
  pendingMessages: number
  pendingSends: number
}

/** Private remote endpoint. Owns sockets only; a network failure never stops the agent graph. */
export class ClientServer {
  readonly #options: DesktopServerOptions & {readonly port: number; readonly media?: ClientMedia; readonly pairing?: ClientPairing; readonly sharedWorkbench?: boolean; readonly prepareLegacyVoice?: () => Promise<string>}
  readonly #instanceId = randomUUID()
  #server: WebSocketServer | undefined
  #active: Connection | undefined
  #closed = false

  constructor(options: DesktopServerOptions & {readonly port: number; readonly media?: ClientMedia; readonly pairing?: ClientPairing; readonly sharedWorkbench?: boolean; readonly prepareLegacyVoice?: () => Promise<string>}) {
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
    const connection = this.#requireActive()
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || typeof value.type !== 'string') throw new DesktopProtocolError('invalid client output')
    if (this.#options.sharedWorkbench && !connection.personal && (value.type.startsWith('personal.') || value.type.startsWith('conversation.'))) return
    if (this.#options.sharedWorkbench && !connection.personal && value.type === 'caption' && value.conversation_id !== connection.legacyConversationId) return
    const personal = connection.personal && ['personal.state', 'personal.result'].includes(value.type)
    if (personal) {
      const frame = value.type === 'personal.state' ? mobileSnapshot(value) : {...value}
      const data = frame.data
      if (data && typeof data === 'object' && (data as Record<string, unknown>).type === 'personal.state') {
        frame.data = mobileSnapshot(data as Record<string, unknown>)
        const pending = connection.snapshot ? JSON.parse(connection.snapshot) as {revision?:number} : undefined
        if (pending && Number(pending.revision) <= Number((data as Record<string,unknown>).revision)) {
          clearTimeout(connection.snapshotTimer); connection.snapshotTimer=undefined; connection.snapshot=undefined
        }
      }
      raw = JSON.stringify(frame)
      if (Buffer.byteLength(raw) > MAX_PERSONAL_BYTES) {
        raw = JSON.stringify(value.type === 'personal.state'
          ? {type: value.type, revision: value.revision, reload_required: true}
          : {type: value.type, request_id: value.request_id, ok: value.ok, ...(value.error ? {error: value.error} : {}), reload_required: true})
      }
      if (value.type === 'personal.state') {
        connection.snapshot = raw
        connection.snapshotTimer ??= setTimeout(() => {
          connection.snapshotTimer = undefined
          const snapshot = connection.snapshot
          connection.snapshot = undefined
          if (snapshot && this.#active === connection) void this.#send(connection, snapshot, true).catch(() => { /* send owns disconnect */ })
        }, 250)
        return
      }
    } else if (Buffer.byteLength(raw) > MAX_DESKTOP_JSON_BYTES) throw new DesktopProtocolError('client output text too large')
    await this.#send(connection, raw, personal === true)
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
    clearTimeout(connection.snapshotTimer)
    connection.snapshot = undefined
    if (connection.authenticated) { this.#options.onClientDisconnect?.() }
  }

  #reject(connection: Connection, code = connection.authenticated && connection.personal ? 1002 : 4003): void {
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
          const hello = JSON.parse(raw) as {protocol_version?: unknown; media?: unknown; language?: unknown; capabilities?: unknown}
          if (hello.protocol_version !== 1 || !acceptsClientMedia(hello.media)) { this.#reject(connection, 4006); return }
          const language = parsePromptLanguage(hello.language)
          connection.clientId=credential===undefined?'remote:master':this.#options.pairing!.clientIdentity(credential)
          connection.personal = Array.isArray(hello.capabilities) && hello.capabilities.includes('personal')
          connection.authenticated = true
          if (credential !== undefined) {
            const untrack = this.#options.pairing!.track(credential, () => this.#reject(connection, 4003))
            socket.once('close', untrack)
          }
          clearTimeout(timer)
          await this.#send(connection, clientReady(this.#instanceId, id, this.#options.media, connection.personal))
          if (this.#active === connection) {
            await this.#options.onClientAuthenticated?.(language)
            if (this.#options.sharedWorkbench && !connection.personal) {
              if (!this.#options.prepareLegacyVoice) { this.#reject(connection,4006); return }
              try { connection.legacyConversationId = await this.#options.prepareLegacyVoice() }
              catch { this.#reject(connection,4009); return }
              if (this.#active === connection) await this.#options.onControl?.({type:'input.audio',conversation_id:connection.legacyConversationId},{client_id:'remote:master',can_takeover:false})
            }
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
            const mobile = connection.personal === true || this.#options.sharedWorkbench === true
            if (mobile && control.type === 'personal.command' && !MOBILE_METHODS.has(control.method)) throw new DesktopProtocolError('mobile command unavailable')
            if (connection.legacyConversationId && ['input.audio','input.text','input.dictation'].includes(control.type)) control = {...control,conversation_id:connection.legacyConversationId} as typeof control
            return this.#options.onControl(control, mobile ? {client_id:'remote:master',can_takeover:false} : {client_id:connection.clientId!,can_takeover:connection.clientId!=='remote:master'})
          })
          if (this.#active !== connection) return
          await this.#send(connection, JSON.stringify(result))
          if (connection.commands.full) this.#reject(connection, 4008)
        }
      }).catch(() => this.#reject(connection))
        .finally(() => { connection.pendingBytes -= bytes.byteLength; connection.pendingMessages-- })
    })
  }

  async #send(connection: Connection, raw: string | Uint8Array, personal = false): Promise<void> {
    const socket = connection.socket
    if (this.#active !== connection || socket.readyState !== WebSocket.OPEN) throw new Error('client unavailable')
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength
    if (socket.bufferedAmount + size > (personal ? MAX_PERSONAL_BYTES + MAX_BUFFERED_BYTES : MAX_BUFFERED_BYTES) || connection.pendingSends >= MAX_PENDING_SENDS) {
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
