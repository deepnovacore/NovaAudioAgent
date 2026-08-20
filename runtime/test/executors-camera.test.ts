import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff } from '../src/causal-runtime.js'
import { VirtualClock } from '../src/clock.js'
import { CamAdapter, CameraError, CAMERA_MANIFEST } from '../src/executors/camera.js'
import { MediaStore } from '../src/media-store.js'
import { delegateSchema } from '../src/ports.js'
import type { Frame, FrameSource } from '../src/executors/watcher.js'

function context(): ExecutorDispatchContext {
  const clock = new VirtualClock()
  return {
    clock,
    delegate: delegateSchema.parse({
      delegate_id: 'd-cam-1', executor: 'cam', op: 'snapshot', request: {},
      origin_ref: 'conversation:1', deadline: 7, routing_class: 'user_awaited', dispatched_at: 0,
    }),
    signal: new AbortController().signal,
    progress: () => undefined,
  }
}

const frame: Frame = {
  payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  media_type: 'image/jpeg',
  width: 1280,
  height: 720,
  captured_at: 4.5,
}

function sourceFor(value: Frame | null): FrameSource {
  return {snapshot: () => Promise.resolve(value)}
}

test('camera is a registry adapter with the Python snapshot manifest', () => {
  // This fails if CamAdapter has no registry manifest, or if a stale manifest changes the operation
  // that the runtime may dispatch.
  const adapter: ExecutorAdapter = new CamAdapter(sourceFor(frame), new MediaStore())

  assert.equal(adapter.manifest, CAMERA_MANIFEST)
  assert.deepEqual(CAMERA_MANIFEST, {
    name: 'cam',
    ops: [{
      name: 'snapshot',
      description: '查看当前摄像头画面，返回带观察时间的图片引用',
      params: {type: 'object', properties: {}, required: [], additionalProperties: false},
      readonly: true,
      confirm: false,
      deadline_budget: 7,
      verifies: ['snapshot'],
      sensitive_params: [],
      sync_result: false,
    }],
    policy: {
      channel: 'cam', priority: 40, wake: 'surrogate', typical_latency: 0.05, compress_watermark: 20,
      suggest: false, progress_via_surrogate: false,
    },
    confirm_ttl: 0,
  })
})

test('camera snapshot stores a frame and hands back its external evidence', async () => {
  // This fails if snapshot skips MediaStore, uses a wrong frame field, or changes the evidence trust.
  const store = new MediaStore(1_024, {idFactory: () => 'frame'})
  const adapter = new CamAdapter(sourceFor(frame), store)

  const handoff = await adapter.dispatch('snapshot', {}, context())

  assert.deepEqual(handoff, {
    outcome: 'ok',
    trust: 'untrusted_external',
    content: {
      media_ref: 'media:frame',
      digest: '32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af',
      media_type: 'image/jpeg',
      width: 1280,
      height: 720,
      captured_at: 4.5,
    },
  })
  assert.deepEqual(store.peek('media:frame'), {
    ref: 'media:frame',
    digest: '32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af',
    media_type: 'image/jpeg',
    width: 1280,
    height: 720,
    captured_at: 4.5,
    payload: frame.payload,
  })
})

test('camera rejects an unknown operation and non-empty snapshot request', async () => {
  // This fails if a caller can dispatch an undeclared operation or smuggle snapshot parameters through.
  const adapter = new CamAdapter(sourceFor(null), new MediaStore())

  assert.deepEqual(await adapter.dispatch('not-real', {}, context()), {
    outcome: 'failed', trust: 'untrusted_external', content: {error: 'unknown_op', op: 'not-real'},
  })
  assert.deepEqual(await adapter.dispatch('snapshot', {unexpected: true}, context()), {
    outcome: 'failed', trust: 'untrusted_external', content: {error: 'invalid_params', op: 'snapshot'},
  })
})

test('camera reports a missing frame and CameraError as unavailable capture', async () => {
  // This fails if a local capture failure leaks as an adapter fault or masquerades as a successful frame.
  const unavailable: ExecutorHandoff = {
    outcome: 'unknown',
    trust: 'untrusted_external',
    content: {
      error: 'capture_unavailable', op: 'snapshot', recheck: 'not_useful_until_capture_recovers',
    },
  }

  assert.deepEqual(await new CamAdapter(sourceFor(null), new MediaStore()).dispatch('snapshot', {}, context()), unavailable)
  const cameraErrorSource: FrameSource = {
    snapshot: () => Promise.reject(new CameraError('camera is offline')),
  }
  assert.deepEqual(
    await new CamAdapter(cameraErrorSource, new MediaStore()).dispatch('snapshot', {}, context()),
    unavailable,
  )
})

test('camera classifies rejected storage and unexpected boundary errors', async () => {
  // This fails if a store capacity refusal becomes retryable, or an implementation exception leaks detail.
  const rejected = new CamAdapter(sourceFor(frame), new MediaStore(3))
  assert.deepEqual(await rejected.dispatch('snapshot', {}, context()), {
    outcome: 'failed', trust: 'untrusted_external', content: {error: 'media_store_rejected', op: 'snapshot'},
  })

  const explodingSource: FrameSource = {snapshot: () => Promise.reject(new Error('private detail'))}
  assert.deepEqual(await new CamAdapter(explodingSource, new MediaStore()).dispatch('snapshot', {}, context()), {
    outcome: 'unknown', trust: 'untrusted_external', content: {error: 'adapter_exception', op: 'snapshot'},
  })

  const explodingStore = {put: (): never => { throw new Error('private detail') }} as unknown as MediaStore
  assert.deepEqual(await new CamAdapter(sourceFor(frame), explodingStore).dispatch('snapshot', {}, context()), {
    outcome: 'unknown', trust: 'untrusted_external', content: {error: 'adapter_exception', op: 'snapshot'},
  })
})
