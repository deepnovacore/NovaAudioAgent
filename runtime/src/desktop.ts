import { timingSafeEqual } from 'node:crypto'
import { createConnection } from 'node:net'
import { z } from 'zod'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  CAMERA_CAPTURE_TIMEOUT_MS,
  CAMERA_HEIGHT,
  CAMERA_PERMISSION_TIMEOUT_MS,
  CAMERA_WIDTH,
  MAX_CAMERA_LATE_RESPONSES,
  MAX_CAMERA_POSITION_MS,
  MAX_CAMERA_WIRE_BYTES,
  MAX_DESKTOP_INBOUND_BYTES,
  MAX_PENDING_CAMERA_REQUESTS,
  decodeCameraFrame,
  hasCameraFrameMagic,
  parseCameraError,
  parseCameraPermissionResult,
  serializeCameraCapture,
  serializeCameraPermissionRequest,
  type CameraPermissionStatus,
} from './desktop-camera.js'
import {codePointLengthLikePython, stripLikePython} from './python-text.js'
import {
  MAX_BOARD_MESSAGE_BYTES,
  type MemoryBoardDetail,
} from './realtime/memory-board.js'

export {
  loadProjectNativeHostFromResources,
  type ProjectNativeHost,
} from './project-native-resource.js'

export {
  ManagedWorkspaceMaintenanceService,
  type ManagedWorkspaceAuthorization,
  type ManagedWorkspaceCapabilities,
  type ManagedWorkspaceExecuteResult,
  type ManagedWorkspaceMaintenanceHealth,
  type ManagedWorkspaceOpenResult,
  type ManagedWorkspacePreparation,
  type ManagedWorkspacePrepareResult,
  type ManagedWorkspaceScope,
} from './managed-workspace-maintenance.js'

export const MAX_DESKTOP_JSON_BYTES = 16 * 1024
export const MAX_DESKTOP_PCM_BYTES = 64 * 1024
export const MAX_DESKTOP_OUTBOUND_BINARY_BYTES = 8 * 1024 * 1024
export const MAX_DESKTOP_PENDING_SENDS = 128
export const MAX_DESKTOP_DEBUG_CONNECTIONS = 4
export const DESKTOP_AUTH_TIMEOUT_MS = 3_000
export const DESKTOP_CLOSE_GRACE_MS = 500
export const DESKTOP_READY_TIMEOUT_MS = 5_000
export const DESKTOP_DEBUG_PATH = '/debug-board'

const tokenPattern = /^[a-f0-9]{32}$/u
const readyEndpointPattern = /^127\.0\.0\.1:([0-9]{1,5})$/u
const identifierSchema = z.string()
  .refine(value => codePointLengthLikePython(value) <= 256)
  .refine(value => stripLikePython(value) !== '')
const renderTimestampSchema = z.number().finite().nonnegative().optional()
const playbackTelemetryCountSchema = z.number().int().nonnegative().max(4_294_967_295)
const playbackTelemetryQueueSchema = z.number().int().nonnegative().max(16_777_216)
const playbackTelemetryDurationSchema = z.number().finite().nonnegative().max(86_400_000)

const helloSchema = z.object({
  type: z.literal('hello'),
  token: z.string(),
})

const debugBoardRequestSchema = z.object({
  type: z.literal('debug.board.request'),
  request_id: identifierSchema,
  board: z.enum(['memory', 'workspace_graph']),
  detail: z.enum(['compact', 'full']),
}).strict()

export const playbackTelemetrySchema = z.object({
  type: z.literal('playback.telemetry'),
  utterance_id: identifierSchema,
  generation_epoch: z.number().int().positive(),
  final: z.boolean(),
  window_ms: playbackTelemetryDurationSchema.int(),
  queued_samples: playbackTelemetryQueueSchema,
  queued_samples_max: playbackTelemetryQueueSchema,
  underrun_samples: playbackTelemetryCountSchema,
  underrun_callbacks: playbackTelemetryCountSchema,
  max_consecutive_underrun_samples: playbackTelemetryCountSchema,
  render_callbacks: playbackTelemetryCountSchema,
  max_callback_us: z.number().int().nonnegative().max(60_000_000),
  frame_gap_ms_max: playbackTelemetryDurationSchema,
  pcm_near_silence_ms_max: playbackTelemetryDurationSchema.int(),
  sequence_gaps: z.number().int().nonnegative().max(1_000_000),
  rejected_frames: z.number().int().nonnegative().max(1_000_000),
  stdin_buffered_bytes_max: playbackTelemetryQueueSchema,
  stdin_backpressure_count: z.number().int().nonnegative().max(1_000_000),
  stdin_drain_ms_max: playbackTelemetryDurationSchema,
}).strict()

export const connectionDiagnosticSchema = z.discriminatedUnion('phase', [
  z.object({
    type: z.literal('connection.diagnostic'),
    phase: z.literal('closed'),
    close_code: z.number().int().nonnegative().max(4_999),
    reason: z.enum([
      'normal',
      'going_away',
      'protocol_error',
      'unsupported_data',
      'abnormal',
      'policy',
      'message_too_big',
      'internal_error',
      'protocol_rejected',
      'client_unavailable',
      'other',
    ]),
  }).strict(),
  z.object({
    type: z.literal('connection.diagnostic'),
    phase: z.literal('reconnect_attempt'),
    attempt: z.number().int().positive().max(1_000_000),
    delay_ms: z.number().int().positive().max(60_000),
  }).strict(),
  z.object({
    type: z.literal('connection.diagnostic'),
    phase: z.literal('reconnect_result'),
    attempt: z.number().int().nonnegative().max(1_000_000),
    result: z.enum(['connected', 'open_failed']),
  }).strict(),
])
const DEFAULT_BOOTSTRAP_TEXT_FRAMES = [
  '{"type":"desktop.ready"}',
  '{"type":"codex.state","state":"idle"}',
] as const

const ordinaryDesktopControlSchema = z.discriminatedUnion('type', [
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
    type: z.literal('project.confirmation_decision'),
    proposal_id: identifierSchema.refine(value => codePointLengthLikePython(value) <= 128),
    confirmed: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('clock.pong'),
    ping_id: identifierSchema,
    t_render_ms: z.number().finite().nonnegative(),
  }),
  playbackTelemetrySchema,
])

export const desktopControlSchema = z.union([
  ordinaryDesktopControlSchema,
  connectionDiagnosticSchema,
])

export type DesktopControl = z.infer<typeof desktopControlSchema>
  | {readonly type: 'playback.telemetry_rejected'}

export class DesktopProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopProtocolError'
  }
}

export class DesktopOutboundValidationError extends DesktopProtocolError {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopOutboundValidationError'
  }
}


export type DesktopCameraErrorCode = 'invalid_request' | 'capture_unavailable'

export class DesktopCameraError extends Error {
  constructor(readonly code: DesktopCameraErrorCode) {
    super(code === 'invalid_request'
      ? 'desktop camera capture request is invalid'
      : 'desktop camera capture is unavailable')
    this.name = 'DesktopCameraError'
  }
}

export interface CameraCaptureRequest {
  readonly source: 'local' | 'file'
  readonly positionMs?: number
}

export interface CapturedCameraFrame {
  readonly payload: Uint8Array
  readonly media_type: 'image/jpeg'
  readonly width: typeof CAMERA_WIDTH
  readonly height: typeof CAMERA_HEIGHT
}

/** The authenticated, bounded camera request surface exposed by the desktop owner. */
export interface CameraCaptureTransport {
  captureCamera(request: CameraCaptureRequest): Promise<CapturedCameraFrame>
  requestCameraPermission?(): Promise<CameraPermissionStatus>
}

export interface DesktopCameraTimer {
  set(delayMs: number, callback: () => void): unknown
  clear(handle: unknown): void
}

export interface DesktopServerOptions {
  readonly token: string
  readonly onControl?: (control: DesktopControl) => void | Promise<void>
  readonly onAudio?: (pcm: Uint8Array) => void | Promise<void>
  readonly onClientDisconnect?: () => void
  readonly onClientAuthenticated?: () => void | Promise<void>
  readonly onDebugBoardRequest?: (
    request: DesktopDebugBoardRequest,
  ) => string | Promise<string>
  readonly bootstrapTextFrames?: readonly string[]
  readonly authTimeoutMs?: number
  readonly closeGraceMs?: number
  readonly cameraTimer?: DesktopCameraTimer
}

export interface DesktopDebugBoardRequest {
  readonly request_id: string
  readonly board: 'memory' | 'workspace_graph'
  readonly detail: MemoryBoardDetail
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
  #connectionGeneration = 0
  #cameraSequence = 0n
  #cameraPermissionSequence = 0n
  readonly #pendingCamera = new Map<string, PendingCameraCapture>()
  #pendingCameraPermission: PendingCameraPermission | undefined
  readonly #lateCameraIds = new Map<string, CameraResponseOwner>()
  readonly #lateCameraOrder: string[] = []
  readonly #debugSockets = new Set<WebSocket>()
  #inboundBytes = 0

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

  captureCamera(request: CameraCaptureRequest): Promise<CapturedCameraFrame> {
    validateCameraCaptureRequest(request)
    if (!this.#canSend() || this.#pendingCamera.size >= MAX_PENDING_CAMERA_REQUESTS) {
      return Promise.reject(cameraUnavailableError())
    }
    const socket = this.#active!
    const generation = this.#connectionGeneration
    this.#cameraSequence += 1n
    const requestId = `camera-${this.#cameraSequence}`
    const raw = serializeCameraCapture(request.source === 'local'
      ? {request_id: requestId, source: 'local'}
      : {request_id: requestId, source: 'file', position_ms: request.positionMs!})
    const pending = new PendingCameraCapture(requestId, socket, generation)
    this.#pendingCamera.set(requestId, pending)
    const timer = this.#options.cameraTimer ?? defaultCameraTimer
    pending.timerHandle = timer.set(CAMERA_CAPTURE_TIMEOUT_MS, () => {
      if (this.#pendingCamera.get(requestId) !== pending) return
      this.#pendingCamera.delete(requestId)
      this.#rememberLateCameraId(pending)
      pending.reject(cameraUnavailableError())
    })
    void this.#enqueueSend(socket, raw).catch(() => {
      this.#rejectCameraCapture(pending, cameraUnavailableError())
    })
    return pending.promise
  }

  requestCameraPermission(): Promise<CameraPermissionStatus> {
    if (!this.#canSend() || this.#pendingCameraPermission !== undefined) {
      return Promise.reject(cameraUnavailableError())
    }
    const socket = this.#active!
    const generation = this.#connectionGeneration
    this.#cameraPermissionSequence += 1n
    const requestId = `camera-permission-${this.#cameraPermissionSequence}`
    const pending = new PendingCameraPermission(requestId, socket, generation)
    this.#pendingCameraPermission = pending
    const timer = this.#options.cameraTimer ?? defaultCameraTimer
    pending.timerHandle = timer.set(CAMERA_PERMISSION_TIMEOUT_MS, () => {
      if (this.#pendingCameraPermission !== pending) return
      this.#pendingCameraPermission = undefined
      this.#rememberLateCameraId(pending)
      pending.reject(cameraUnavailableError())
    })
    void this.#enqueueSend(socket, serializeCameraPermissionRequest({request_id: requestId}))
      .catch(() => this.#rejectCameraPermission(pending))
    return pending.promise
  }

  /** Retire only the client active when this call begins; a later reconnect is never its target. */
  async disconnectClient(): Promise<void> {
    const active = this.#active
    if (active === undefined) return
    this.#rejectSocketCameraCaptures(active)
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
      maxPayload: MAX_CAMERA_WIRE_BYTES,
      perMessageDeflate: false,
    })
    this.#server = server
    server.on('connection', (socket, request) => {
      if (request.url === DESKTOP_DEBUG_PATH) this.#acceptDebug(socket)
      else if (request.url === '/') this.#accept(socket)
      else socket.close(4004, 'desktop endpoint is unsupported')
    })
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
    if (active !== undefined) this.#rejectSocketCameraCaptures(active)
    const activeClosed = active === undefined ? Promise.resolve() : closeWebSocket(
      active,
      this.#options.closeGraceMs ?? DESKTOP_CLOSE_GRACE_MS,
    )
    const debugClosed = [...this.#debugSockets].map(socket => closeWebSocket(
      socket,
      this.#options.closeGraceMs ?? DESKTOP_CLOSE_GRACE_MS,
    ))
    if (server === undefined) {
      await Promise.all([activeClosed, ...debugClosed])
      this.#notifyDisconnected(active)
      return
    }
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
    })
    await Promise.all([activeClosed, ...debugClosed, serverClosed])
    this.#notifyDisconnected(active)
  }

  #acceptDebug(socket: WebSocket): void {
    if (
      this.#stopping
      || this.#options.onDebugBoardRequest === undefined
      || this.#debugSockets.size >= MAX_DESKTOP_DEBUG_CONNECTIONS
    ) {
      socket.close(4009, 'desktop debug client unavailable')
      return
    }
    this.#debugSockets.add(socket)
    socket.on('error', error => { void error })
    let authenticated = false
    let requestStarted = false
    let terminal = false
    let inboundBytes = 0
    let processing = Promise.resolve()
    const reject = (): void => {
      if (terminal) return
      terminal = true
      if (socket.readyState < WebSocket.CLOSING) {
        socket.close(4003, 'desktop debug protocol rejected')
      }
    }
    let phaseTimer = setTimeout(reject, this.#options.authTimeoutMs)
    const resetPhaseTimer = (): void => {
      clearTimeout(phaseTimer)
      phaseTimer = setTimeout(reject, this.#options.authTimeoutMs)
    }
    socket.on('message', (data, isBinary) => {
      const frameBytes = rawDataByteLength(data)
      if (isBinary || inboundBytes + frameBytes > MAX_DESKTOP_JSON_BYTES) {
        reject()
        return
      }
      inboundBytes += frameBytes
      processing = processing.then(async () => {
        if (terminal) return
        const raw = rawText(data)
        if (!authenticated) {
          authenticateDesktopFrame(raw, this.#options.token)
          authenticated = true
          resetPhaseTimer()
          return
        }
        if (requestStarted) throw new DesktopProtocolError('desktop debug request already started')
        const request = parseDebugBoardRequest(raw)
        requestStarted = true
        resetPhaseTimer()
        const response = await this.#options.onDebugBoardRequest!(request)
        if (terminal) return
        validateDebugBoardResponse(response, request)
        await sendWebSocketFrame(socket, response)
        if (terminal) return
        terminal = true
        clearTimeout(phaseTimer)
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'debug complete')
      }).catch(() => reject()).finally(() => {
        inboundBytes -= frameBytes
      })
    })
    socket.once('close', () => {
      terminal = true
      clearTimeout(phaseTimer)
      this.#debugSockets.delete(socket)
    })
  }

  #accept(socket: WebSocket): void {
    if (this.#active !== undefined || this.#stopping) {
      socket.close(4009, 'desktop client already connected')
      return
    }
    this.#active = socket
    const generation = ++this.#connectionGeneration
    // `ws` reports protocol and max-payload failures through this event before
    // closing the peer. The close code remains the renderer-visible verdict.
    socket.on('error', error => { void error })
    let authenticated = false
    let rejected = false
    let processing = Promise.resolve()
    const authTimer = setTimeout(() => socket.close(4003, 'desktop protocol rejected'),
      this.#options.authTimeoutMs)

    socket.on('message', (data, isBinary) => {
      const inboundBytes = rawDataByteLength(data)
      if (this.#inboundBytes + inboundBytes > MAX_DESKTOP_INBOUND_BYTES) {
        rejected = true
        socket.close(4003, 'desktop protocol rejected')
        return
      }
      this.#inboundBytes += inboundBytes
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
          const binary = rawBinaryBytes(data)
          if (hasCameraFrameMagic(binary)) {
            this.#receiveCameraFrame(socket, generation, binary)
            return
          }
          const pcm = validateAndCopyPcm(binary)
          if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
            throw new DesktopProtocolError('desktop input must be aligned PCM16 bytes')
          }
          try {
            await this.#options.onAudio?.(pcm)
          } catch {
            // The renderer frame is already fully validated here. A provider can be temporarily
            // unavailable while its session reconnects; that host-side delivery failure drops only
            // this PCM frame and must not be reclassified as a renderer protocol violation.
          }
          return
        }
        const raw = rawText(data)
        const cameraError = maybeCameraError(raw)
        if (cameraError !== undefined) {
          this.#receiveCameraError(socket, generation, cameraError.request_id)
          return
        }
        const cameraPermission = maybeCameraPermissionResult(raw)
        if (cameraPermission !== undefined) {
          this.#receiveCameraPermission(
            socket,
            generation,
            cameraPermission.request_id,
            cameraPermission.status,
          )
          return
        }
        const control = parseDesktopControl(raw)
        try {
          await this.#options.onControl?.(control)
        } catch {
          // Control parsing succeeded, so a host-side failure (for example cancellation while the
          // provider reconnects) is not evidence that the renderer violated the desktop protocol.
        }
      }).catch(() => {
        rejected = true
        socket.close(4003, 'desktop protocol rejected')
      }).finally(() => {
        this.#inboundBytes -= inboundBytes
      })
    })
    socket.once('close', () => {
      clearTimeout(authTimer)
      this.#notifyDisconnected(socket)
    })
  }

  #notifyDisconnected(socket: WebSocket | undefined): void {
    if (socket === undefined) return
    this.#rejectSocketCameraCaptures(socket)
    if (this.#active !== socket) return
    this.#active = undefined
    this.#authenticated = false
    this.#rejectSocketSends(socket, outboundUnavailableError())
    try {
      this.#options.onClientDisconnect?.()
    } catch {
      // Disconnect observation cannot own the socket writer or process lifetime.
    }
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

  #receiveCameraFrame(socket: WebSocket, generation: number, raw: Uint8Array): void {
    const frame = decodeCameraFrame(raw)
    const pending = this.#ownedCameraCapture(frame.request_id, socket, generation)
    if (pending === undefined) return
    this.#settleCameraCapture(pending)
    pending.resolve({
      payload: new Uint8Array(frame.payload),
      media_type: 'image/jpeg',
      width: CAMERA_WIDTH,
      height: CAMERA_HEIGHT,
    })
  }

  #receiveCameraError(socket: WebSocket, generation: number, requestId: string): void {
    const pending = this.#ownedCameraCapture(requestId, socket, generation)
    if (pending === undefined) return
    this.#rejectCameraCapture(pending, cameraUnavailableError())
  }

  #ownedCameraCapture(
    requestId: string,
    socket: WebSocket,
    generation: number,
  ): PendingCameraCapture | undefined {
    const pending = this.#pendingCamera.get(requestId)
    if (pending === undefined) {
      const lateOwner = this.#lateCameraIds.get(requestId)
      if (lateOwner !== undefined) {
        if (lateOwner.socket === socket && lateOwner.generation === generation) return undefined
        throw new DesktopProtocolError('desktop camera response has wrong owner')
      }
      throw new DesktopProtocolError('desktop camera response is unsolicited')
    }
    if (pending.socket !== socket || pending.generation !== generation) {
      throw new DesktopProtocolError('desktop camera response has wrong owner')
    }
    return pending
  }

  #settleCameraCapture(pending: PendingCameraCapture): void {
    if (this.#pendingCamera.get(pending.requestId) !== pending) return
    this.#pendingCamera.delete(pending.requestId)
    const timer = this.#options.cameraTimer ?? defaultCameraTimer
    if (pending.timerHandle !== undefined) timer.clear(pending.timerHandle)
  }

  #rejectCameraCapture(pending: PendingCameraCapture, error: DesktopCameraError): void {
    if (this.#pendingCamera.get(pending.requestId) !== pending) return
    this.#settleCameraCapture(pending)
    pending.reject(error)
  }

  #rejectSocketCameraCaptures(socket: WebSocket): void {
    for (const pending of [...this.#pendingCamera.values()]) {
      if (pending.socket === socket) this.#rejectCameraCapture(pending, cameraUnavailableError())
    }
    if (this.#pendingCameraPermission?.socket === socket) {
      this.#rejectCameraPermission(this.#pendingCameraPermission)
    }
  }

  #receiveCameraPermission(
    socket: WebSocket,
    generation: number,
    requestId: string,
    status: CameraPermissionStatus,
  ): void {
    const pending = this.#pendingCameraPermission
    if (pending?.requestId !== requestId) {
      const lateOwner = this.#lateCameraIds.get(requestId)
      if (lateOwner?.socket === socket && lateOwner.generation === generation) return
      throw new DesktopProtocolError('desktop camera permission response is unsolicited')
    }
    if (pending.socket !== socket || pending.generation !== generation) {
      throw new DesktopProtocolError('desktop camera permission response has wrong owner')
    }
    this.#settleCameraPermission(pending)
    pending.resolve(status)
  }

  #settleCameraPermission(pending: PendingCameraPermission): void {
    if (this.#pendingCameraPermission !== pending) return
    this.#pendingCameraPermission = undefined
    const timer = this.#options.cameraTimer ?? defaultCameraTimer
    if (pending.timerHandle !== undefined) timer.clear(pending.timerHandle)
  }

  #rejectCameraPermission(pending: PendingCameraPermission): void {
    if (this.#pendingCameraPermission !== pending) return
    this.#settleCameraPermission(pending)
    pending.reject(cameraUnavailableError())
  }

  #rememberLateCameraId(pending: CameraResponseOwner & {readonly requestId: string}): void {
    this.#lateCameraIds.set(pending.requestId, {
      socket: pending.socket,
      generation: pending.generation,
    })
    this.#lateCameraOrder.push(pending.requestId)
    while (this.#lateCameraOrder.length > MAX_CAMERA_LATE_RESPONSES) {
      const oldest = this.#lateCameraOrder.shift()
      if (oldest !== undefined) this.#lateCameraIds.delete(oldest)
    }
  }
}

interface CameraResponseOwner {
  readonly socket: WebSocket
  readonly generation: number
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

class PendingCameraCapture {
  readonly promise: Promise<CapturedCameraFrame>
  readonly resolve: (frame: CapturedCameraFrame) => void
  readonly reject: (error: DesktopCameraError) => void
  timerHandle: unknown

  constructor(
    readonly requestId: string,
    readonly socket: WebSocket,
    readonly generation: number,
  ) {
    let resolve: ((frame: CapturedCameraFrame) => void) | undefined
    let reject: ((error: DesktopCameraError) => void) | undefined
    this.promise = new Promise<CapturedCameraFrame>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    this.resolve = resolve as (frame: CapturedCameraFrame) => void
    this.reject = reject as (error: DesktopCameraError) => void
  }
}

class PendingCameraPermission {
  readonly promise: Promise<CameraPermissionStatus>
  readonly resolve: (status: CameraPermissionStatus) => void
  readonly reject: (error: DesktopCameraError) => void
  timerHandle: unknown

  constructor(
    readonly requestId: string,
    readonly socket: WebSocket,
    readonly generation: number,
  ) {
    let resolve: ((status: CameraPermissionStatus) => void) | undefined
    let reject: ((error: DesktopCameraError) => void) | undefined
    this.promise = new Promise<CameraPermissionStatus>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    this.resolve = resolve as (status: CameraPermissionStatus) => void
    this.reject = reject as (error: DesktopCameraError) => void
  }
}

const defaultCameraTimer: DesktopCameraTimer = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
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
    throw new DesktopOutboundValidationError(`${label} is invalid`)
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_DESKTOP_JSON_BYTES) {
    throw new DesktopOutboundValidationError(`${label} is too large`)
  }
}

function parseDebugBoardRequest(raw: string): DesktopDebugBoardRequest {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new DesktopProtocolError('desktop debug request is invalid')
  }
  const parsed = debugBoardRequestSchema.safeParse(value)
  if (!parsed.success) throw new DesktopProtocolError('desktop debug request is invalid')
  return parsed.data
}

function validateDebugBoardResponse(raw: string, request: DesktopDebugBoardRequest): void {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BOARD_MESSAGE_BYTES) {
    throw new DesktopOutboundValidationError('desktop debug response is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new DesktopOutboundValidationError('desktop debug response is invalid')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DesktopOutboundValidationError('desktop debug response is invalid')
  }
  const response = value as {readonly type?: unknown; readonly request_id?: unknown}
  const expectedType = request.board === 'memory' ? 'memory.board' : 'workspace_graph.board'
  if (response.type !== expectedType || response.request_id !== request.request_id) {
    throw new DesktopOutboundValidationError('desktop debug response is invalid')
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

function cameraUnavailableError(): DesktopCameraError {
  return new DesktopCameraError('capture_unavailable')
}

function validateCameraCaptureRequest(request: CameraCaptureRequest): void {
  if (typeof request !== 'object' || request === null) {
    throw new DesktopCameraError('invalid_request')
  }
  if (request.source === 'local') {
    if (request.positionMs !== undefined) throw new DesktopCameraError('invalid_request')
    return
  }
  if (request.source !== 'file'
    || typeof request.positionMs !== 'number'
    || !Number.isFinite(request.positionMs)
    || !Number.isInteger(request.positionMs)
    || request.positionMs < 0
    || request.positionMs > MAX_CAMERA_POSITION_MS) {
    throw new DesktopCameraError('invalid_request')
  }
}

function maybeCameraError(raw: string): {readonly request_id: string} | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (value as Record<string, unknown>).type !== 'camera.error') return undefined
  return parseCameraError(raw)
}

function maybeCameraPermissionResult(raw: string): {
  readonly request_id: string
  readonly status: CameraPermissionStatus
} | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (value as Record<string, unknown>).type !== 'camera.permission_result') return undefined
  return parseCameraPermissionResult(raw)
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
  const value = parseBoundedJson(raw)
  const result = desktopControlSchema.safeParse(value)
  if (!result.success) {
    if (
      typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
    ) {
      const type = (value as Record<string, unknown>).type
      if (type === 'playback.telemetry') return {type: 'playback.telemetry_rejected'}
    }
    throw new DesktopProtocolError('desktop control frame is unsupported')
  }
  return result.data
}

export function parseReadyEndpoint(raw: string): {readonly host: '127.0.0.1', readonly port: number} {
  const match = readyEndpointPattern.exec(stripLikePython(raw))
  const port = match === null ? 0 : Number(match[1])
  if (port < 1 || port > 65_535) {
    throw new DesktopProtocolError('desktop readiness endpoint is invalid')
  }
  return {host: '127.0.0.1', port}
}

export async function announceReadiness(
  endpoint: string,
  readiness: DesktopReadiness,
  input: number | {
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  } = DESKTOP_READY_TIMEOUT_MS,
): Promise<void> {
  const timeoutMs = typeof input === 'number' ? input : (input.timeoutMs ?? DESKTOP_READY_TIMEOUT_MS)
  const signal = typeof input === 'number' ? undefined : input.signal
  validateDesktopToken(readiness.token)
  if (readiness.host !== '127.0.0.1' || !Number.isInteger(readiness.port)
    || readiness.port < 1 || readiness.port > 65_535) {
    throw new DesktopProtocolError('desktop readiness payload is invalid')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DesktopProtocolError('desktop readiness timeout is invalid')
  }
  if (signal?.aborted === true) {
    throw new DesktopProtocolError('desktop readiness announcement cancelled')
  }
  const target = parseReadyEndpoint(endpoint)
  const line = `${JSON.stringify(readiness)}\n`
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(target)
    let settled = false
    let writeStarted = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = (): void => {
      // Once the whole line has been handed to Socket.end it cannot be reliably withdrawn. Keep
      // observing that write: reporting "cancelled" after the parent may have accepted readiness
      // would make the two processes disagree about whether startup committed.
      if (writeStarted) return
      socket.destroy()
      finish(new DesktopProtocolError('desktop readiness announcement cancelled'))
    }
    // The commit point is the completion callback for this process's one line write, not a close from
    // the parent. The parent is allowed to hold its side open after it has accepted the complete line.
    const timer = setTimeout(() => {
      socket.destroy()
      finish(new DesktopProtocolError('desktop readiness announcement timed out'))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, {once: true})
    if (signal?.aborted === true) onAbort()
    socket.once('error', error => finish(error))
    socket.once('connect', () => {
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      writeStarted = true
      socket.end(line, () => {
        finish()
        socket.destroy()
      })
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

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  return data.byteLength
}

function rawBinaryBytes(data: RawData): Uint8Array {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
  return new Uint8Array(bytes)
}

function validateAndCopyPcm(bytes: Uint8Array): Uint8Array {
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
