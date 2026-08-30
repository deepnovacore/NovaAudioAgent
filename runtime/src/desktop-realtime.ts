import {
  DesktopSocketBridge,
  type DesktopBridgeOptions,
  type DesktopDelivery,
} from './desktop-bridge.js'
import {
  DesktopOutboundValidationError,
  DesktopProtocolError,
  NodeDesktopServer,
  type DesktopReadiness,
  type DesktopServerOptions,
} from './desktop.js'
import type {RealtimeTelemetry} from './realtime/telemetry.js'
import type {MemoryBoardDetail} from './realtime/memory-board.js'
import {workspaceGraphBoardMessage} from './realtime/workspace-graph-board.js'

const READY_FRAME = '{"type":"desktop.ready"}'

/** The authenticated writer surface used by the bridge pump. */
export interface DesktopServerTransport {
  sendText(raw: string): Promise<void>
  sendBinary(raw: Uint8Array): Promise<void>
  disconnectClient(): Promise<void>
  start(): Promise<DesktopReadiness>
  close(): Promise<void>
}

export interface DesktopRealtimeOptions extends DesktopBridgeOptions {
  readonly memoryBoard?: (requestId: string, detail?: MemoryBoardDetail) => string
  readonly workspaceGraphBoard?: (requestId: string) => string
  readonly createServer?: (options: DesktopServerOptions) => DesktopServerTransport
  /** Optional lifecycle observation after bridge connection state has been released. */
  readonly onConnectionReleased?: () => void
}

/**
 * Owns the narrow connection-generation boundary between desktop policy and the socket writer.
 * Realtime service/provider construction intentionally lives elsewhere.
 */
export class DesktopRealtime {
  readonly bridge: DesktopSocketBridge
  readonly server: DesktopServerTransport
  readonly serverOptions: DesktopServerOptions

  readonly #stop: {abort(): void}
  readonly #onConnectionReleased: (() => void) | undefined
  readonly #telemetry: RealtimeTelemetry | undefined
  #generation = 0
  #activeGeneration: number | null = null
  #drainRequested = false
  #draining = false

  constructor(options: DesktopRealtimeOptions) {
    const {
      createServer,
      onConnectionReleased,
      memoryBoard,
      workspaceGraphBoard,
      ...bridgeOptions
    } = options
    this.#stop = options.stop
    this.#onConnectionReleased = onConnectionReleased
    this.#telemetry = options.telemetry
    this.bridge = new DesktopSocketBridge({
      ...bridgeOptions,
      onOutboundAvailable: () => this.#requestDrain(),
    })
    this.serverOptions = {
      token: options.token,
      bootstrapTextFrames: [READY_FRAME],
      onClientAuthenticated: () => this.#authenticated(),
      onClientDisconnect: () => this.#disconnected(),
      onDebugBoardRequest: request => {
        if (request.board === 'memory') {
          if (memoryBoard === undefined) {
            throw new DesktopProtocolError('desktop memory board is unavailable')
          }
          return memoryBoard(request.request_id, request.detail)
        }
        return workspaceGraphBoard?.(request.request_id)
          ?? workspaceGraphBoardMessage(request.request_id, null, 'disabled')
      },
      onAudio: pcm => this.bridge.receiveAudio(pcm),
      onControl: control => this.bridge.receiveControl(control),
    }
    this.server = (createServer ?? (serverOptions => new NodeDesktopServer(serverOptions)))(
      this.serverOptions,
    )
  }

  #authenticated(): void {
    if (!this.bridge.claim()) {
      throw new DesktopProtocolError('desktop bridge connection is unavailable')
    }
    this.#activeGeneration = ++this.#generation
    this.bridge.markAuthenticated()
    this.#requestDrain()
  }

  #disconnected(): void {
    const generation = this.#activeGeneration
    if (generation !== null) this.#release(generation)
  }

  #release(generation: number): void {
    if (this.#activeGeneration !== generation) return
    this.#activeGeneration = null
    this.#generation += 1
    this.bridge.release()
    this.#onConnectionReleased?.()
  }

  #requestDrain(): void {
    this.#drainRequested = true
    if (this.#activeGeneration !== null && !this.#draining) void this.#drain()
  }

  async #drain(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    try {
      while (this.#activeGeneration !== null && this.#drainRequested) {
        this.#drainRequested = false
        for (;;) {
          const generation: number | null = this.#activeGeneration
          if (generation === null) break
          const delivery = this.bridge.takeNextDelivery()
          if (delivery === null) break
          try {
            await this.#send(delivery)
          } catch (error) {
            if (delivery.policy === 'required') this.#stop.abort()
            else if (error instanceof DesktopOutboundValidationError) {
              this.#telemetry?.record('desktop.outbound_validation_dropped', {
                policy: delivery.policy,
                frame_kind: typeof delivery.frame === 'string' ? 'text' : 'binary',
              })
              continue
            } else {
              await this.server.disconnectClient()
              this.#release(generation)
            }
            break
          }
          if (this.#activeGeneration !== generation) break
        }
      }
    } finally {
      this.#draining = false
      if (this.#activeGeneration !== null && this.#drainRequested) void this.#drain()
    }
  }

  #send(delivery: DesktopDelivery): Promise<void> {
    return typeof delivery.frame === 'string'
      ? this.server.sendText(delivery.frame)
      : this.server.sendBinary(delivery.frame)
  }
}
