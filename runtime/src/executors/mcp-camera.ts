/**
 * The local camera is exposed through the same small MCP boundary future external
 * tools use.  It is deliberately in-process: camera authority remains owned by
 * the main process and the MCP connection is only a typed transport boundary.
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import {z} from 'zod'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../causal-runtime.js'
import type {JsonValue} from '../events.js'
import type {MediaStore} from '../media-store.js'
import type {ModelGateway} from '../model-gateway.js'
import {handoffPolicySchema} from '../memory.js'
import {executorManifestSchema, opSpecSchema, type ExecutorManifest} from '../ports.js'
import {
  CAMERA_MAX_HEIGHT,
  CAMERA_MAX_IMAGE_BYTES,
  CAMERA_MAX_PIXELS,
  CAMERA_MAX_WIDTH,
  CAMERA_MAX_CAPTURED_AT,
  CAMERA_MIN_CAPTURED_AT,
  canonicalBase64ByteLength,
  projectCameraMcpResult,
  type CameraMcpCallToolResult,
} from './camera-mcp-result.js'
import type {Frame, FrameSource, ObservationAdmission} from './watcher.js'

export const MCP_CAMERA_EXECUTOR = 'mcp__nova_camera'
export const MCP_CAMERA_SNAPSHOT = 'snapshot'
const MAX_TEXT_CHARS = 400
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_BASE64_CHARS = Math.ceil(CAMERA_MAX_IMAGE_BYTES / 3) * 4

export const CAMERA_MCP_MANIFEST: ExecutorManifest = executorManifestSchema.parse({
  name: MCP_CAMERA_EXECUTOR,
  display_name: 'Camera',
  ops: [opSpecSchema.parse({
    name: MCP_CAMERA_SNAPSHOT,
    description: '查看当前摄像头画面。',
    params: {type: 'object', properties: {}, required: [], additionalProperties: false},
    readonly: true,
    deadline_budget: 7,
    verifies: ['snapshot'],
  })],
  policy: handoffPolicySchema.parse({
    channel: MCP_CAMERA_EXECUTOR,
    priority: 40,
    wake: 'surrogate',
    typical_latency: 0.05,
    compress_watermark: 20,
  }),
})

type ParsedMcpResult =
  | {readonly kind: 'text'; readonly text: string}
  | {readonly kind: 'image'; readonly result: CameraMcpCallToolResult}
  | {readonly kind: 'invalid'}

/** Fail closed before an MCP response becomes an executor handoff. */
export function parseMcpToolResult(input: unknown): ParsedMcpResult {
  try {
    return parseMcpToolResultUnchecked(input)
  } catch {
    return {kind: 'invalid'}
  }
}

function parseMcpToolResultUnchecked(input: unknown): ParsedMcpResult {
  const top = exactPlainData(input, ['content'], ['structuredContent'])
  if (top === null) return {kind: 'invalid'}
  const structuredContent = 'structuredContent' in top
    ? exactPlainData(top.structuredContent, ['captured_at', 'width', 'height'], [])
    : undefined
  if ('structuredContent' in top && structuredContent === null) return {kind: 'invalid'}
  const content = singletonDataArray(top.content)
  if (content === null) return {kind: 'invalid'}
  const block = exactPlainData(content.value, ['type'], ['text', 'data', 'mimeType'])
  if (block === null) return {kind: 'invalid'}
  if (block.type === 'text') {
    if (Object.keys(block).length !== 2 || typeof block.text !== 'string'
      || block.text.length === 0 || block.text.length > MAX_TEXT_CHARS) return {kind: 'invalid'}
    return {kind: 'text', text: block.text}
  }
  if (Object.keys(block).length !== 3 || block.type !== 'image'
    || typeof block.data !== 'string' || typeof block.mimeType !== 'string'
    || !canonicalImage(block.data, block.mimeType)) return {kind: 'invalid'}
  // `projectCameraMcpResult` owns strict base64, MIME, size, and metadata validation.
  return {kind: 'image', result: {content: [{type: 'image', data: block.data, mimeType: block.mimeType}],
    ...(structuredContent === undefined ? {} : {structuredContent})}}
}

function canonicalImage(data: string, mimeType: string): boolean {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || data === '' || data.length > MAX_BASE64_CHARS) return false
  const byteLength = canonicalBase64ByteLength(data)
  if (byteLength === null || byteLength > CAMERA_MAX_IMAGE_BYTES) return false
  try {
    const decoded = Buffer.from(data, 'base64')
    return decoded.byteLength === byteLength
  } catch { return false }
}

interface AdmissionGatedFrameSource extends FrameSource {
  admitObservation(): Promise<ObservationAdmission>
}

function isAdmissionGated(source: FrameSource): source is AdmissionGatedFrameSource {
  return 'admitObservation' in source && typeof source.admitObservation === 'function'
}

function exactPlainData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length < required.length || keys.some(key => typeof key !== 'string')) return null
    const stringKeys = keys as readonly string[]
    const allowed = new Set([...required, ...optional])
    if (stringKeys.some(key => !allowed.has(key)) || required.some(key => !stringKeys.includes(key))) return null
    const result: Record<string, unknown> = {}
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch {
    return null
  }
}

function singletonDataArray(value: unknown): Readonly<{readonly value: unknown}> | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')) return null
    const length = Object.getOwnPropertyDescriptor(value, 'length')
    const item = Object.getOwnPropertyDescriptor(value, '0')
    if (length === undefined || !('value' in length) || length.value !== 1
      || item === undefined || !item.enumerable || !('value' in item)) return null
    return {value: item.value}
  } catch {
    return null
  }
}

function cancelled(): ExecutorHandoff {
  return {outcome: 'cancelled', trust: 'untrusted_external', content: {error: 'cancelled'}}
}

function failure(error: string): ExecutorHandoff {
  return {outcome: 'failed', trust: 'untrusted_external', content: {error}}
}

/**
 * A reusable client-shaped adapter.  The constructor owns both linked transports;
 * callers cannot replace this server or bypass its permission/capture boundary.
 */
export class CameraMcpAdapter implements ExecutorAdapter {
  readonly manifest = CAMERA_MCP_MANIFEST
  readonly #source: FrameSource
  readonly #mediaStore: MediaStore
  readonly #gateway: Pick<ModelGateway, 'complete'>
  readonly #model: string
  readonly #objective: string
  #server: McpServer
  #client: Client
  #serverTransport: InMemoryTransport
  #clientTransport: InMemoryTransport
  #connection: Promise<void> | undefined
  #closed: Promise<void> | undefined

  constructor(options: {
    readonly source: FrameSource
    readonly mediaStore: MediaStore
    readonly gateway: Pick<ModelGateway, 'complete'>
    readonly model: string
    readonly objective?: string
  }) {
    this.#source = options.source
    this.#mediaStore = options.mediaStore
    this.#gateway = options.gateway
    this.#model = options.model
    this.#objective = options.objective ?? '描述当前摄像头画面中的客观场景。'
    this.#server = new McpServer({name: 'nova-camera', version: '0.2.0'})
    this.#client = new Client({name: 'nova-camera-client', version: '0.2.0'})
    ;[this.#clientTransport, this.#serverTransport] = InMemoryTransport.createLinkedPair()
    this.#registerSnapshotTool()
  }

  #registerSnapshotTool(): void {
    this.#server.registerTool(MCP_CAMERA_SNAPSHOT, {
      description: '查看当前摄像头画面。',
      inputSchema: z.object({}).strict(),
      annotations: {readOnlyHint: true},
    }, async (_args, extra) => await this.#serveSnapshot(extra.signal))
  }

  #replaceClosedConnection(): void {
    this.#server = new McpServer({name: 'nova-camera', version: '0.2.0'})
    this.#client = new Client({name: 'nova-camera-client', version: '0.2.0'})
    ;[this.#clientTransport, this.#serverTransport] = InMemoryTransport.createLinkedPair()
    this.#registerSnapshotTool()
  }

  async connect(): Promise<void> {
    if (this.#closed !== undefined) {
      const closed = this.#closed
      await closed
      if (this.#closed === closed) {
        this.#closed = undefined
        this.#replaceClosedConnection()
      }
    }
    if (this.#connection !== undefined) return await this.#connection
    const server = this.#server
    const client = this.#client
    const pending: {attempt: Promise<void> | undefined} = {attempt: undefined}
    pending.attempt = (async () => {
      try {
        await server.connect(this.#serverTransport)
        await client.connect(this.#clientTransport)
      } catch (error) {
        await Promise.allSettled([client.close(), server.close()])
        if (pending.attempt !== undefined && this.#connection === pending.attempt) {
          this.#connection = undefined
          if (this.#server === server && this.#client === client) this.#replaceClosedConnection()
        }
        throw error
      }
    })()
    this.#connection = pending.attempt
    return await pending.attempt
  }

  close(): Promise<void> {
    this.#closed ??= (async () => {
      await Promise.allSettled([this.#client.close(), this.#server.close()])
    })()
    this.#connection = undefined
    return this.#closed
  }

  /** Test-only inspection of the real, linked client. */
  clientForTest(): unknown { return this.#client }

  async dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    ctx: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    if (op !== MCP_CAMERA_SNAPSHOT) return failure('unknown_op')
    if (Object.keys(request).length !== 0) return failure('invalid_params')
    if (ctx.signal.aborted) return cancelled()
    try {
      await this.connect()
      const raw = await this.#client.callTool({name: MCP_CAMERA_SNAPSHOT, arguments: {}}, undefined, {signal: ctx.signal})
      if (ctx.signal.aborted) return cancelled()
      const stableError = cameraResultError(raw)
      if (stableError !== null) return stableError
      const parsed = parseMcpToolResult(raw)
      if (parsed.kind !== 'image') return failure('camera_mcp_invalid_result')
      return await projectCameraMcpResult(parsed.result, {
        gateway: this.#gateway,
        model: this.#model,
        objective: this.#objective,
        mediaStore: this.#mediaStore,
        signal: ctx.signal,
      })
    } catch {
      return ctx.signal.aborted ? cancelled() : failure('camera_mcp_unavailable')
    }
  }

  async #serveSnapshot(signal: AbortSignal): Promise<CallToolResult> {
    if (signal.aborted) return cameraError('cancelled')
    if (isAdmissionGated(this.#source)) {
      let admission: ObservationAdmission
      try { admission = await this.#source.admitObservation() } catch { admission = 'unavailable' }
      if (signal.aborted) return cameraError('cancelled')
      if (admission === 'denied') return cameraError('camera_permission_denied')
      if (admission === 'restricted') return cameraError('camera_permission_restricted')
      if (admission !== 'granted') return cameraError('capture_unavailable')
    }
    let captured: Frame | null
    try { captured = await this.#source.snapshot() } catch { return cameraError('capture_unavailable') }
    if (signal.aborted) return cameraError('cancelled')
    const valid = validFrame(captured)
    if (valid === null) return cameraError('capture_unavailable')
    return {
      content: [{type: 'image', data: Buffer.from(valid.payload).toString('base64'), mimeType: valid.media_type}],
      structuredContent: {captured_at: valid.captured_at, width: valid.width, height: valid.height},
    }
  }
}

function cameraResultError(input: unknown): ExecutorHandoff | null {
  const top = exactPlainData(input, ['isError', 'content'], [])
  if (top?.isError !== true) return null
  const content = singletonDataArray(top.content)
  const block = exactPlainData(content?.value, ['type', 'text'], [])
  if (block?.type !== 'text' || typeof block.text !== 'string') return failure('camera_mcp_invalid_result')
  if (block.text === 'cancelled') return cancelled()
  if (block.text === 'camera_permission_denied' || block.text === 'camera_permission_restricted') {
    return {outcome: 'refused', trust: 'trusted_system', content: {error: 'camera_permission_denied'}}
  }
  if (block.text === 'capture_unavailable') return {outcome: 'unknown', trust: 'untrusted_external', content: {error: 'capture_unavailable'}}
  return failure('camera_mcp_invalid_result')
}

function validFrame(value: Frame | null): Frame | null {
  try {
    if (value === null || !(value.payload instanceof Uint8Array)
      || !SUPPORTED_IMAGE_MIME_TYPES.has(value.media_type)
      || value.payload.byteLength === 0 || value.payload.byteLength > CAMERA_MAX_IMAGE_BYTES
      || !Number.isSafeInteger(value.width) || value.width <= 0 || value.width > CAMERA_MAX_WIDTH
      || !Number.isSafeInteger(value.height) || value.height <= 0 || value.height > CAMERA_MAX_HEIGHT
      || value.width * value.height > CAMERA_MAX_PIXELS
      || !Number.isFinite(value.captured_at) || value.captured_at < CAMERA_MIN_CAPTURED_AT
      || value.captured_at > CAMERA_MAX_CAPTURED_AT) return null
    return {
      payload: new Uint8Array(value.payload), media_type: value.media_type,
      width: value.width, height: value.height, captured_at: value.captured_at,
    }
  } catch {
    return null
  }
}

function cameraError(code: string): CallToolResult {
  return {isError: true, content: [{type: 'text', text: code}]}
}
