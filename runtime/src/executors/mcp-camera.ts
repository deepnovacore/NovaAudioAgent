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
import {CAMERA_MAX_IMAGE_BYTES, projectCameraMcpResult, type CameraMcpCallToolResult} from './camera-mcp-result.js'
import type {Frame, FrameSource, ObservationAdmission} from './watcher.js'

export const MCP_CAMERA_EXECUTOR = 'mcp__nova_camera'
export const MCP_CAMERA_SNAPSHOT = 'snapshot'
const MAX_TEXT_CHARS = 400

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
  if (!plain(input) || input.isError === true || !Array.isArray(input.content) || input.content.length !== 1) {
    return {kind: 'invalid'}
  }
  if (Object.keys(input).some(key => key !== 'content' && key !== 'structuredContent')) return {kind: 'invalid'}
  const [content] = input.content as readonly unknown[]
  if (!plain(content)) return {kind: 'invalid'}
  if (content.type === 'text') {
    if (typeof content.text !== 'string' || content.text.length === 0 || content.text.length > MAX_TEXT_CHARS
      || Object.keys(content).some(key => key !== 'type' && key !== 'text')) {
      return {kind: 'invalid'}
    }
    return {kind: 'text', text: content.text}
  }
  if (content.type !== 'image' || typeof content.data !== 'string' || typeof content.mimeType !== 'string'
    || Object.keys(content).some(key => key !== 'type' && key !== 'data' && key !== 'mimeType')
    || !canonicalImage(content.data, content.mimeType)) {
    return {kind: 'invalid'}
  }
  // `projectCameraMcpResult` owns strict base64, MIME, size, and metadata validation.
  return {kind: 'image', result: {content: [{type: 'image', data: content.data, mimeType: content.mimeType}],
    ...(Object.prototype.hasOwnProperty.call(input, 'structuredContent')
      ? {structuredContent: input.structuredContent} : {})}}
}

function canonicalImage(data: string, mimeType: string): boolean {
  if (!new Set(['image/jpeg', 'image/png', 'image/webp']).has(mimeType) || data === '') return false
  try {
    const decoded = Buffer.from(data, 'base64')
    return decoded.byteLength > 0 && decoded.byteLength <= CAMERA_MAX_IMAGE_BYTES
      && decoded.toString('base64') === data
  } catch { return false }
}

interface AdmissionGatedFrameSource extends FrameSource {
  admitObservation(): Promise<ObservationAdmission>
}

function isAdmissionGated(source: FrameSource): source is AdmissionGatedFrameSource {
  return 'admitObservation' in source && typeof source.admitObservation === 'function'
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
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
      this.#connection ??= (async () => {
        await closed
        if (this.#closed === closed) {
          this.#closed = undefined
          this.#replaceClosedConnection()
        }
        await this.#server.connect(this.#serverTransport)
        await this.#client.connect(this.#clientTransport)
      })()
      return await this.#connection
    }
    this.#connection ??= (async () => {
      await this.#server.connect(this.#serverTransport)
      await this.#client.connect(this.#clientTransport)
    })()
    return await this.#connection
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
    if (captured === null) return cameraError('capture_unavailable')
    return {
      content: [{type: 'image', data: Buffer.from(captured.payload).toString('base64'), mimeType: captured.media_type}],
      structuredContent: {captured_at: captured.captured_at, width: captured.width, height: captured.height},
    }
  }
}

function cameraResultError(input: unknown): ExecutorHandoff | null {
  if (!plain(input) || input.isError !== true || !Array.isArray(input.content) || input.content.length !== 1) return null
  const [block] = input.content as readonly unknown[]
  if (!plain(block) || block.type !== 'text' || typeof block.text !== 'string'
    || Object.keys(block).some(key => key !== 'type' && key !== 'text')) return failure('camera_mcp_invalid_result')
  if (block.text === 'cancelled') return cancelled()
  if (block.text === 'camera_permission_denied' || block.text === 'camera_permission_restricted') {
    return {outcome: 'refused', trust: 'untrusted_external', content: {error: block.text}}
  }
  if (block.text === 'capture_unavailable') {
    return {outcome: 'unknown', trust: 'untrusted_external', content: {error: block.text}}
  }
  return failure('camera_mcp_invalid_result')
}

function cameraError(code: string): CallToolResult {
  return {isError: true, content: [{type: 'text', text: code}]}
}
