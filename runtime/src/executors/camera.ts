import type { ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff } from '../causal-runtime.js'
import type { JsonValue } from '../events.js'
import type { MediaStore } from '../media-store.js'
import { handoffPolicySchema } from '../memory.js'
import { executorManifestSchema, opSpecSchema, type ExecutorManifest } from '../ports.js'
import type { FrameSource } from './watcher.js'

export const SNAPSHOT = opSpecSchema.parse({
  name: 'snapshot',
  description: '查看当前摄像头画面，返回带观察时间的图片引用',
  params: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  readonly: true,
  deadline_budget: 7,
  verifies: ['snapshot'],
})

export const CAMERA_POLICY = handoffPolicySchema.parse({
  channel: 'cam',
  priority: 40,
  wake: 'surrogate',
  typical_latency: 0.05,
  compress_watermark: 20,
})

export const CAMERA_MANIFEST: ExecutorManifest = executorManifestSchema.parse({
  name: 'cam',
  ops: [SNAPSHOT],
  policy: CAMERA_POLICY,
})

/** A credential-free local capture failure. */
export class CameraError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'CameraError'
  }
}

export class CamAdapter implements ExecutorAdapter {
  readonly manifest = CAMERA_MANIFEST
  readonly #source: FrameSource
  readonly #store: MediaStore

  constructor(source: FrameSource, store: MediaStore) {
    this.#source = source
    this.#store = store
  }

  async dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    ctx: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    void ctx
    if (op !== 'snapshot') return failure('failed', 'unknown_op', op)
    if (Object.keys(request).length > 0) return failure('failed', 'invalid_params', 'snapshot')

    let frame
    try {
      frame = await this.#source.snapshot()
    } catch (cause) {
      if (cause instanceof CameraError) frame = null
      else return failure('unknown', 'adapter_exception', 'snapshot')
    }
    if (frame === null) {
      return {
        outcome: 'unknown',
        trust: 'untrusted_external',
        content: {
          error: 'capture_unavailable',
          op: 'snapshot',
          recheck: 'not_useful_until_capture_recovers',
        },
      }
    }

    try {
      const entry = this.#store.put(frame.payload, {
        mediaType: frame.media_type,
        width: frame.width,
        height: frame.height,
        capturedAt: frame.captured_at,
      })
      return {
        outcome: 'ok',
        trust: 'untrusted_external',
        content: {
          media_ref: entry.ref,
          digest: entry.digest,
          media_type: entry.media_type,
          width: entry.width,
          height: entry.height,
          captured_at: entry.captured_at,
        },
      }
    } catch (cause) {
      if (cause instanceof RangeError) return failure('failed', 'media_store_rejected', 'snapshot')
      return failure('unknown', 'adapter_exception', 'snapshot')
    }
  }
}

function failure(
  outcome: 'failed' | 'unknown',
  error: string,
  op: string,
): ExecutorHandoff {
  return {outcome, trust: 'untrusted_external', content: {error, op}}
}
