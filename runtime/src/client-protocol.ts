import {z} from 'zod'
import {DesktopProtocolError, MAX_DESKTOP_JSON_BYTES, parseDesktopControl, type DesktopControl} from './desktop.js'
import {decodeAudioFrame} from './desktop-wire.js'
import type {PlaybackFrame} from './playback.js'

export const CLIENT_PATH = '/client/v1'
export const CLIENT_COMMAND_LIMIT = 256

/** Only implemented/validated transports belong here. AOQ is not a wire-compatible relay. */
export const clientMediaSchema = z.object({
  transport: z.literal('host_pcm_v1'),
  path: z.literal('relay'),
  audio_owner: z.literal('client'),
  pipeline: z.enum(['integrated', 'cascaded']),
}).strict()
export type ClientMedia = z.infer<typeof clientMediaSchema>
const mediaOfferSchema = z.object({
  transports: z.array(z.string().min(1).max(64)).min(1).max(8),
}).strict()

/** Omitted offer is the original v1 relay client. Explicit incompatible offers fail closed. */
export function acceptsClientMedia(offer: unknown): boolean {
  if (offer === undefined) return true
  const parsed = mediaOfferSchema.safeParse(offer)
  return parsed.success && parsed.data.transports.includes('host_pcm_v1')
}

export function decodeClientAudioFrame(raw: Uint8Array): PlaybackFrame {
  const frame = decodeAudioFrame(raw)
  if (!Number.isSafeInteger(frame.generation_epoch) || !Number.isSafeInteger(frame.sequence)) {
    throw new DesktopProtocolError('client audio integer is unsafe')
  }
  return frame
}
const identifier = z.string().min(1).max(128)
const commandSchema = z.object({
  type: z.literal('client.command'),
  request_id: identifier,
  connection_id: identifier,
  payload: z.record(z.string(), z.unknown()),
}).strict()

export interface ClientCommandResult {
  readonly type: 'client.command_result'
  readonly request_id: string
  /** Delivery acknowledgement only. Host state, never this receipt, proves approval/execution. */
  readonly status: 'applied' | 'rejected' | 'stale'
}

export function clientReady(serverInstanceId: string, connectionId: string, media?: ClientMedia): string {
  return JSON.stringify({
    type: 'client.ready', protocol_version: 1,
    server_instance_id: serverInstanceId, connection_id: connectionId, media,
    input_audio: {encoding: 'pcm_s16le', sample_rate: 16_000, channels: 1},
    output_audio: {encoding: 'pcm_s16le', sample_rate: 24_000, channels: 1},
    capabilities: ['audio', 'captions', 'projects', 'executor', ...(media?.pipeline === 'cascaded' ? ['text_input', 'dictation'] : [])],
  })
}

/** Call serially per connection. Entries survive errors: retries must never repeat a side effect. */
export class ClientCommands {
  readonly #connectionId: string
  // ponytail: 256 requests per connection; reconnect with a fresh state snapshot at capacity.
  readonly #results = new Map<string, {payload: string; result: ClientCommandResult}>()

  constructor(connectionId: string) { this.#connectionId = connectionId }

  get full(): boolean { return this.#results.size >= CLIENT_COMMAND_LIMIT }

  async receive(raw: string, deliver: (control: DesktopControl) => void | Promise<void>): Promise<ClientCommandResult> {
    if (Buffer.byteLength(raw) > MAX_DESKTOP_JSON_BYTES) throw new DesktopProtocolError('client command too large')
    const command = commandSchema.parse(JSON.parse(raw) as unknown)
    const result = (status: ClientCommandResult['status']): ClientCommandResult => ({
      type: 'client.command_result', request_id: command.request_id, status,
    })
    if (command.connection_id !== this.#connectionId) return result('stale')
    // Desktop timestamps may be fractional, but neither Swift nor JS may round protocol integers.
    for (const value of Object.values(command.payload)) {
      if (typeof value === 'number' && (!Number.isFinite(value)
        || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        throw new DesktopProtocolError('client control number is unsafe')
      }
    }
    const control = parseDesktopControl(JSON.stringify(command.payload))
    const payload = JSON.stringify(control)
    const previous = this.#results.get(command.request_id)
    if (previous !== undefined) return previous.payload === payload ? previous.result : result('rejected')
    if (this.full) return result('rejected')
    const entry = {payload, result: result('rejected')}
    this.#results.set(command.request_id, entry)
    try {
      await deliver(control)
      entry.result = result('applied')
    } catch { /* Preserve rejected receipt; host state decides whether anything took effect. */ }
    return entry.result
  }
}
