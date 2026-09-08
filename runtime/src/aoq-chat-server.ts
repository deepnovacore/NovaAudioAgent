import type {ClientPairing} from './client-pairing.js'
/** AOQ credential/data broker; Runtime ownership is supplied through hooks, never constructed here. */
import {randomUUID, timingSafeEqual} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {WebSocket, WebSocketServer} from 'ws'
import {z} from 'zod'
import type {DesktopServerOptions, DesktopReadiness} from './desktop.js'
import type {DesktopServerTransport} from './desktop-realtime.js'
import type {ClientCommands} from './client-protocol.js'

const MAX_JSON_BYTES = 16 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_BUFFERED_BYTES = 256 * 1024
const TRANSPORT = 'qwen_aoq_chat_v1'
const RUNTIME_TRANSPORT = 'qwen_aoq_runtime_v1'
const MAX_EVENT_BYTES = 64 * 1024
const MAX_ENVELOPE_BYTES = 128 * 1024
const hostEvents = new Set(['session.update', 'conversation.item.create', 'conversation.item.delete',
  'conversation.item.truncate', 'input_audio_buffer.clear', 'response.create', 'response.cancel'])
const providerEvents = new Set(['session.created', 'session.updated', 'error',
  'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed', 'input_audio_buffer.cleared',
  'conversation.item.created', 'conversation.item.deleted', 'conversation.item.truncated',
  'conversation.item.input_audio_transcription.completed', 'conversation.item.input_audio_transcription.failed',
  // Qwen-Audio ASR metadata only: the adapter deliberately ignores partial/ambient text.
  'conversation.item.input_audio_transcription.delta', 'conversation.item.ambient_audio_transcription.delta',
  'conversation.item.ambient_audio_transcription.completed',
  'response.created', 'response.done', 'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done', 'response.audio_transcript.delta', 'response.audio_transcript.done',
  'response.output_audio_transcript.delta', 'response.output_audio_transcript.done', 'response.text.delta', 'response.text.done',
  'response.output_text.delta', 'response.output_text.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.audio.done'])
const eventEnvelope = z.object({type: z.literal('aoq.event'), connection_id: z.uuid(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), event: z.record(z.string(), z.unknown())}).strict()

function validateEvent(event: Record<string, unknown>, allowed: ReadonlySet<string>): string {
  if (!event || Array.isArray(event) || typeof event.type !== 'string' || !allowed.has(event.type)) throw new Error('invalid AOQ event')
  const raw = JSON.stringify(event)
  if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) throw new Error('AOQ event too large')
  // Validate the JSON tree without recursive descent or accepting audio payloads in nested items.
  const pending: unknown[] = [event]
  while (pending.length) {
    const value = pending.pop()
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue
    if (typeof value === 'number' && Number.isFinite(value)) continue
    if (typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value))) throw new Error('invalid AOQ JSON')
    for (const [key, child] of Object.entries(value)) {
      if (['audio', 'base64', 'pcm', 'audio_delta'].includes(key)) throw new Error('AOQ audio payload rejected')
      pending.push(child)
    }
  }
  return raw
}
const text = z.string().trim().min(1).max(8192)
const allocationSchema = z.object({
  aoqTokenForClient: text, sid: text, clientRelayCertFingerprint: text,
  clientRelayEndpoints: z.array(z.object({endpoint: text.max(253), port: z.number().int().min(1).max(65535),
    route_index: z.number().int().nonnegative().optional()})).min(1).max(8),
  extraInfo: z.object({workspaceIdHash: text}),
  sidExpiresInSecs: z.number().positive().max(2_147_483),
})
type Allocation = z.infer<typeof allocationSchema>
const helloSchema = z.object({type: z.literal('hello'), token: z.string()})
const mediaSchema = z.object({protocol_version: z.literal(1),
  media: z.object({transports: z.array(z.string()).max(32)})})
const connectSchema = z.object({type: z.literal('aoq.connect'), connection_id: z.uuid(), request_id: z.uuid()}).strict()

/** Beijing workspace hosts only; callers cannot supply a URL, port, path or redirect. */
export function aoqCredentialURL(host: string): string {
  if (!/^llm-[a-z0-9]+\.cn-beijing\.maas\.aliyuncs\.com$/u.test(host)) throw new Error('invalid_aoq_api_host')
  return `https://${host}/api/v1/webrtc/realtime?model=qwen-audio-3.0-realtime-plus`
}

/** Only the official top-level allocation is accepted; errors never retain upstream text. */
export async function issueAoqCredential(apiKey: string, signal: AbortSignal, apiHost: string, fetcher: typeof fetch = fetch): Promise<Allocation> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal.addEventListener('abort', abort, {once: true})
  if (signal.aborted) abort()
  const timeout = setTimeout(abort, 8000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (!apiKey.trim()) throw new Error()
    const response = await fetcher(aoqCredentialURL(apiHost), {
      method: 'POST', body: '{}', redirect: 'error', signal: controller.signal,
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'x-dashscope-rtc-transport': 'moq'},
    })
    reader = response.body?.getReader()
    if (!response.ok || response.redirected || !reader || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const {value, done} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error()
      chunks.push(value)
    }
    controller.signal.throwIfAborted()
    return allocationSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch {
    throw new Error('credential_unavailable')
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    controller.abort()
    void reader?.cancel().catch(() => { /* Never expose upstream errors. */ })
  }
}

export interface AoqProviderConnection {
  readonly id: string
  readonly send: (event: Record<string, unknown>) => Promise<void>
  readonly disconnect: () => void
}
export type AoqRuntimeOptions = DesktopServerOptions & {
  readonly onProviderConnect: (connection: AoqProviderConnection) => void
  readonly onProviderEvent: (id: string, event: Record<string, unknown>) => void
  readonly onProviderDisconnect: (id: string) => void
}
export interface AoqChatServerOptions {
  readonly pairing?: ClientPairing
  readonly onDiagnostic?: (line: string) => void
  readonly runtime?: AoqRuntimeOptions
  readonly port: number
  readonly token: string
  readonly issueCredential: (signal: AbortSignal) => Promise<Allocation>
  readonly voice?: string
  readonly authTimeoutMs?: number
  readonly credentialTimeoutMs?: number
  readonly heartbeatMs?: number
  readonly now?: () => number
}
interface Connection {
  readonly socket: WebSocket
  readonly id: string
  readonly abort: AbortController
  readonly commands?: ClientCommands
  controlLane: Promise<void>
  pendingControls: number
  pendingControlBytes: number
  pendingSendBytes: number
  allocated: boolean
  providerConnected: boolean
  inboundSequence: number
  outboundSequence: number
  authenticated: boolean
  requested: boolean
  alive: boolean
  pendingSends: number
  burstMessages: number
  burstBytes: number
  authTimer?: ReturnType<typeof setTimeout>
  credentialTimer?: ReturnType<typeof setTimeout>
  heartbeat?: ReturnType<typeof setInterval>
}

export class AoqChatServer implements DesktopServerTransport {
  readonly #options: AoqChatServerOptions
  #Commands: typeof ClientCommands | undefined
  readonly #instanceId = randomUUID()
  #server: WebSocketServer | undefined
  #active: Connection | undefined
  #closed = false
  // ponytail: process-local, shared-token rolling budget; use shared storage if deploying multiple brokers.
  #attempts: number[] = []

  constructor(options: AoqChatServerOptions) {
    if (!/^[a-f0-9]{32}$/u.test(options.token) || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error('invalid AOQ server configuration')
    }
    for (const ms of [options.authTimeoutMs ?? 3000, options.credentialTimeoutMs ?? 8000, options.heartbeatMs ?? 15000]) {
      if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647) throw new Error('invalid AOQ timeout')
    }
    if (options.voice !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/u.test(options.voice)) throw new Error('invalid AOQ voice')
    if (options.runtime && options.runtime.token !== options.token) throw new Error('AOQ runtime token mismatch')
    this.#options = options
  }

  async start(): Promise<DesktopReadiness> {
    if (this.#server || this.#closed) throw new Error('AOQ server already started or stopped')
    if (this.#options.runtime) this.#Commands = (await import('./client-protocol.js')).ClientCommands
    if (this.#server || this.#closed) throw new Error('AOQ server already started or stopped')
    const server = new WebSocketServer({host: '127.0.0.1', port: this.#options.port,
      maxPayload: this.#options.runtime ? MAX_ENVELOPE_BYTES : MAX_JSON_BYTES - 1, perMessageDeflate: false})
    this.#server = server
    server.on('connection', (socket, request) => {
      socket.on('error', () => { socket.terminate() })
      if (!this.#closed && this.#options.pairing?.handle(socket, request.url)) return
      if (request.url !== '/client/v1') { this.#closeSocket(socket, 4004); return }
      if (this.#active || this.#closed) { this.#closeSocket(socket, 4009); return }
      this.#accept(socket)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    server.on('error', () => { /* Sockets own network failure cleanup. */ })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('AOQ server did not bind')
    return {token: this.#options.token, host: '127.0.0.1', port: address.port}
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#active) this.#release(this.#active)
    const server = this.#server
    this.#server = undefined
    if (!server) return
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  async sendText(raw: string): Promise<void> {
    const c = this.#active
    if (!this.#options.runtime || !c?.authenticated) throw new Error('AOQ runtime unavailable')
    if (Buffer.byteLength(raw) >= MAX_JSON_BYTES) throw new Error('AOQ desktop frame too large')
    const frame = z.object({type: z.string().min(1)}).parse(JSON.parse(raw) as unknown)
    if (frame.type.startsWith('aoq.') || frame.type === 'hello' || frame.type === 'client.command'
      || hostEvents.has(frame.type) || providerEvents.has(frame.type)) throw new Error('invalid AOQ desktop frame')
    await this.#write(c, raw, MAX_JSON_BYTES - 1)
  }

  sendBinary(raw: Uint8Array): Promise<void> {
    void raw
    return Promise.reject(new Error('AOQ binary transport is unavailable'))
  }

  disconnectClient(): Promise<void> {
    const c = this.#active
    if (c) { this.#release(c); c.socket.terminate() }
    return Promise.resolve()
  }

  #release(c: Connection): void {
    if (this.#active !== c) return
    this.#active = undefined
    clearTimeout(c.authTimer)
    clearTimeout(c.credentialTimer)
    clearInterval(c.heartbeat)
    const runtime = this.#options.runtime
    // Fence the desktop epoch before releasing the provider, even when a hook throws.
    if (c.authenticated) {
      try { void Promise.resolve(runtime?.onClientDisconnect?.({hadProviderAttachment: c.providerConnected})).catch(() => { /* Continue owned cleanup. */ }) } catch { /* Continue owned cleanup. */ }
    }
    if (c.providerConnected) {
      c.providerConnected = false
      try { void Promise.resolve(runtime?.onProviderDisconnect(c.id)).catch(() => { /* Cleanup is already fenced. */ }) } catch { /* Never leak hook errors. */ }
    }
    c.abort.abort()
  }

  #closeSocket(socket: WebSocket, code: number): void {
    socket.close(code, 'AOQ connection closed')
    const grace = setTimeout(() => socket.terminate(), 500)
    grace.unref()
    socket.once('close', () => clearTimeout(grace))
  }

  #reject(c: Connection, code = c.authenticated ? 1002 : 4003, reason = 'invalid_message', eventType: unknown = 'unknown'): void {
    if (this.#active !== c) return
    if (code === 1002 || code === 4003) {
      const safeType = typeof eventType === 'string' && /^[a-z_.]{1,80}$/u.test(eventType) ? eventType : 'unknown'
      try { this.#options.onDiagnostic?.(`[runtime-diagnostic] aoq_protocol_rejected type=${safeType} reason=${reason}`) } catch { /* Diagnostics cannot prevent cleanup. */ }
    }
    this.#release(c)
    this.#closeSocket(c.socket, code)
  }

  #unavailable(c: Connection): void {
    if (this.#active !== c) return
    this.#send(c, {type: 'aoq.error', code: 'credential_unavailable'})
    this.#reject(c, 4008)
  }

  #send(c: Connection, frame: unknown): boolean {
    if (this.#active !== c || c.socket.readyState !== WebSocket.OPEN) return false
    void this.#write(c, JSON.stringify(frame), MAX_JSON_BYTES - 1).catch(() => this.#reject(c))
    return this.#active === c
  }

  async #write(c: Connection, raw: string, maxBytes: number): Promise<void> {
    if (this.#active !== c || c.socket.readyState !== WebSocket.OPEN) throw new Error('AOQ connection unavailable')
    const size = Buffer.byteLength(raw)
    if (size > maxBytes || c.pendingSendBytes + size > MAX_BUFFERED_BYTES
      || c.socket.bufferedAmount + size > MAX_BUFFERED_BYTES || c.pendingSends >= 128) {
      this.#reject(c, 4008)
      throw new Error('AOQ send queue full')
    }
    c.pendingSends++
    c.pendingSendBytes += size
    try {
      await new Promise<void>((resolve, reject) => c.socket.send(raw, error => error ? reject(new Error('AOQ send failed')) : resolve()))
    } catch {
      this.#reject(c)
      throw new Error('AOQ send failed')
    } finally { c.pendingSends--; c.pendingSendBytes -= size }
  }

  async #sendProvider(c: Connection, event: Record<string, unknown>): Promise<void> {
    if (this.#active !== c || !c.providerConnected || !Number.isSafeInteger(c.outboundSequence + 1)) throw new Error('AOQ provider unavailable')
    const rawEvent = validateEvent(event, hostEvents)
    const raw = `{"type":"aoq.command","connection_id":${JSON.stringify(c.id)},"sequence":${++c.outboundSequence},"event":${rawEvent}}`
    await this.#write(c, raw, MAX_ENVELOPE_BYTES)
  }

  #control(c: Connection, raw: string): void {
    const size = Buffer.byteLength(raw)
    if (++c.pendingControls > 128 || (c.pendingControlBytes += size) > MAX_BUFFERED_BYTES) { this.#reject(c, 4008); return }
    c.controlLane = c.controlLane.then(async () => {
      if (this.#active !== c || !c.commands) return
      const result = await c.commands.receive(raw, control => {
        if (this.#active !== c || !this.#options.runtime?.onControl) throw new Error('AOQ control unavailable')
        return this.#options.runtime.onControl(control)
      })
      if (this.#active !== c) return
      await this.#write(c, JSON.stringify(result), MAX_JSON_BYTES - 1)
      if (c.commands.full) this.#reject(c, 4008)
    }).catch(() => this.#reject(c)).finally(() => { c.pendingControls--; c.pendingControlBytes -= size })
  }

  #accept(socket: WebSocket): void {
    const id = randomUUID()
    const c: Connection = {socket, id, abort: new AbortController(),
      ...(this.#Commands ? {commands: new this.#Commands(id)} : {}),
      controlLane: Promise.resolve(), pendingControls: 0, pendingControlBytes: 0, pendingSendBytes: 0,
      allocated: false, providerConnected: false, inboundSequence: 0, outboundSequence: 0,
      authenticated: false, requested: false, alive: true, pendingSends: 0, burstMessages: 0, burstBytes: 0}
    this.#active = c
    c.authTimer = setTimeout(() => this.#reject(c, 4003, 'auth_timeout'), this.#options.authTimeoutMs ?? 3000)
    socket.once('close', () => this.#release(c))
    socket.on('pong', () => { c.alive = true })
    c.heartbeat = setInterval(() => {
      if (!c.alive) { this.#release(c); socket.terminate(); return }
      c.alive = false
      socket.ping()
    }, this.#options.heartbeatMs ?? 15000)
    socket.on('message', (data, binary) => {
      if (this.#active !== c) return
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      c.burstBytes += bytes.byteLength
      c.burstMessages++
      // Parse synchronously; never queue frames behind an in-flight HTTP allocation.
      if (c.burstMessages === 1) queueMicrotask(() => { c.burstMessages = 0; c.burstBytes = 0 })
      if (binary || bytes.byteLength > (this.#options.runtime ? MAX_ENVELOPE_BYTES : MAX_JSON_BYTES - 1) || c.burstBytes > MAX_BUFFERED_BYTES || c.burstMessages > 128) {
        this.#reject(c, undefined, binary ? 'binary_rejected' : 'input_limit'); return
      }
      let rejectionReason = 'invalid_json'
      let eventType: unknown = 'unknown'
      try {
        const raw = bytes.toString('utf8')
        const frame: unknown = JSON.parse(raw)
        rejectionReason = 'invalid_envelope'
        const type = z.object({type: z.string()}).parse(frame).type
        eventType = type
        if (bytes.byteLength >= MAX_JSON_BYTES && !(this.#options.runtime && c.authenticated && type === 'aoq.event')) { this.#reject(c, undefined, 'input_limit', type); return }
        if (!c.authenticated) {
          rejectionReason = 'authentication_failed'
          const hello = helloSchema.parse(frame)
          const provided = Buffer.from(hello.token)
          const expected = Buffer.from(this.#options.token)
          if (!(this.#options.pairing ? this.#options.pairing.accepts(hello.token) : provided.length === expected.length && timingSafeEqual(provided, expected))) { this.#reject(c, 4003, 'authentication_failed', type); return }
          const media = mediaSchema.safeParse(frame)
          const runtime = this.#options.runtime
          const transport = runtime ? RUNTIME_TRANSPORT : TRANSPORT
          if (!media.success || !media.data.media.transports.includes(transport)) { this.#reject(c, 4006); return }
          c.authenticated = true
          if (this.#options.pairing) {
            const untrack = this.#options.pairing.track(hello.token, () => this.#reject(c, 4003, 'device_revoked'))
            socket.once('close', untrack)
          }
          clearTimeout(c.authTimer)
          this.#send(c, {type: 'client.ready', protocol_version: 1, server_instance_id: this.#instanceId, connection_id: c.id,
            input_audio: {encoding: 'pcm_s16le', sample_rate: 16000, channels: 1},
            output_audio: {encoding: 'pcm_s16le', sample_rate: 24000, channels: 1}, capabilities: runtime ? ['audio', 'captions', 'projects', 'executor'] : ['audio', 'captions'],
            media: {transport, path: 'direct', audio_owner: 'aoq_sdk', pipeline: 'integrated', mode: runtime ? 'runtime' : 'chat_only'}})
          if (this.#active === c) {
            try { void Promise.resolve(runtime?.onClientAuthenticated?.()).catch(() => this.#reject(c)) } catch { this.#reject(c) }
          }
          return
        }
        if (this.#options.runtime && type === 'aoq.event') {
          rejectionReason = 'invalid_event_envelope'
          const envelope = eventEnvelope.parse(frame)
          eventType = envelope.event.type
          if (!c.allocated) { this.#reject(c, 1002, 'not_allocated', eventType); return }
          if (envelope.connection_id !== c.id) { this.#reject(c, 1002, 'connection_mismatch', eventType); return }
          if (envelope.sequence !== c.inboundSequence + 1) { this.#reject(c, 1002, 'event_sequence', eventType); return }
          if (typeof eventType !== 'string' || !providerEvents.has(eventType)) { this.#reject(c, 1002, 'unsupported_event', eventType); return }
          rejectionReason = 'invalid_event_payload'
          validateEvent(envelope.event, providerEvents)
          c.inboundSequence = envelope.sequence
          rejectionReason = 'provider_hook_failed'
          void Promise.resolve(this.#options.runtime.onProviderEvent(c.id, envelope.event)).catch(() => this.#reject(c))
          return
        }
        if (this.#options.runtime && type === 'client.command') { this.#control(c, raw); return }
        rejectionReason = 'invalid_connect'
        const request = connectSchema.parse(frame)
        if (request.connection_id !== c.id) { this.#reject(c); return }
        if (c.requested) { this.#unavailable(c); return }
        c.requested = true
        const now = (this.#options.now ?? (() => performance.now()))()
        this.#attempts = this.#attempts.filter(time => now - time < 60_000)
        if (this.#attempts.length >= 6) { this.#unavailable(c); return }
        this.#attempts.push(now)
        c.credentialTimer = setTimeout(() => this.#unavailable(c), this.#options.credentialTimeoutMs ?? 8000)
        void this.#allocate(c, request.request_id, now)
      } catch { this.#reject(c, undefined, rejectionReason, eventType) }
    })
  }

  async #allocate(c: Connection, requestId: string, started: number): Promise<void> {
    try {
      const result = allocationSchema.parse(await this.#options.issueCredential(c.abort.signal))
      if (this.#active !== c || c.abort.signal.aborted) return
      clearTimeout(c.credentialTimer)
      const {sidExpiresInSecs, clientRelayEndpoints, ...fields} = result
      const credentials = {...fields, clientRelayEndpoints: clientRelayEndpoints.map(({endpoint, port, route_index}, index) => ({
        endpoint, port, routeIndex: route_index ?? index,
      }))}
      const remaining = sidExpiresInSecs * 1000 - ((this.#options.now ?? (() => performance.now()))() - started)
      if (remaining <= 0) { this.#unavailable(c); return }
      const frame = {type: 'aoq.credentials', connection_id: c.id, request_id: requestId, credentials,
        ...(this.#options.runtime ? {mode: 'runtime'} : {session: {modalities: ['text', 'audio'], voice: this.#options.voice ?? 'longanqian',
          input_audio_format: 'pcm', output_audio_format: 'pcm',
          instructions: '你是Nova，一个自然、友好的语音聊天助手。仅进行纯聊天，不执行主机工具，不操作文件、终端、项目或设备，也不声称已执行这些操作。',
          turn_detection: {type: 'smart_turn'}}})}
      if (Buffer.byteLength(JSON.stringify(frame)) >= MAX_JSON_BYTES) { this.#unavailable(c); return }
      if (this.#options.runtime) {
        c.providerConnected = true
        void Promise.resolve(this.#options.runtime.onProviderConnect({id: c.id, send: event => this.#sendProvider(c, event),
          disconnect: () => { if (this.#active === c) this.#reject(c, 4008) }})).catch(() => this.#unavailable(c))
      }
      if (!this.#send(c, frame)) return
      c.allocated = true
      // sidExpiresInSecs is not documented as a broker-enforced active-call deadline.
      // The SDK/upstream owns post-connect expiry; never truncate a live call here.
    } catch { this.#unavailable(c) }
  }
}
