import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {MediaStore} from '../src/media-store.js'
import {
  CameraMcpAdapter,
  CAMERA_MCP_MANIFEST,
  parseMcpToolResult,
} from '../src/executors/mcp-camera.js'
import type {ExecutorDispatchContext} from '../src/causal-runtime.js'
import {VirtualClock} from '../src/clock.js'
import {delegateSchema} from '../src/ports.js'
import type {Frame, FrameSource} from '../src/executors/watcher.js'

const frame: Frame = {
  payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  media_type: 'image/jpeg', width: 2, height: 2, captured_at: 1_700_000_000,
}

function context(signal = new AbortController().signal): ExecutorDispatchContext {
  return {
    clock: new VirtualClock(), signal, progress: () => undefined,
    delegate: delegateSchema.parse({
      delegate_id: 'camera-1', executor: 'mcp__nova_camera', op: 'snapshot', request: {},
      origin_ref: 'conversation:1', deadline: 7, routing_class: 'user_awaited', dispatched_at: 0,
    }),
  }
}

function source(value: Frame | null = frame): FrameSource {
  return {
    start: () => Promise.resolve(), stop: () => Promise.resolve(), snapshot: () => Promise.resolve(value),
  }
}

test('built-in camera serves snapshot through the actual linked MCP client with metadata and idempotent close', async () => {
  const adapter = new CameraMcpAdapter({source: source(), mediaStore: new MediaStore(), model: 'watch-model',
    gateway: {complete() { return Promise.resolve({text: '{"observation":"desk"}'}) }}})
  assert.deepEqual(adapter.manifest, CAMERA_MCP_MANIFEST)
  await adapter.connect()
  const client = adapter.clientForTest() as Client
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map(tool => ({name: tool.name, inputSchema: tool.inputSchema, annotations: tool.annotations})), [{
    name: 'snapshot', inputSchema: {$schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {}, additionalProperties: false}, annotations: {readOnlyHint: true},
  }])
  const result = await client.callTool({name: 'snapshot', arguments: {}})
  assert.deepEqual(result.structuredContent, {captured_at: frame.captured_at, width: 2, height: 2})
  const content = result.content as readonly unknown[]
  assert.equal(content.length, 1)
  assert.deepEqual(content[0], {type: 'image', data: Buffer.from(frame.payload).toString('base64'), mimeType: 'image/jpeg'})
  const closing = adapter.close()
  assert.equal(adapter.close(), closing)
  await closing
  await adapter.connect()
  assert.deepEqual((await (adapter.clientForTest() as Client).listTools()).tools.map(tool => tool.name), ['snapshot'])
  await adapter.close()
})

test('camera MCP adapter projects only objective evidence and preserves identity', async () => {
  const adapter = new CameraMcpAdapter({source: source(), mediaStore: new MediaStore(), model: 'watch-model', objective: 'describe the room',
    gateway: {complete() { return Promise.resolve({text: '{"observation":"desk"}'}) }}})
  await adapter.connect()
  const handoff = await adapter.dispatch('snapshot', {}, context())
  assert.deepEqual(handoff, {
    outcome: 'ok', trust: 'untrusted_external', refs: ['camera.snapshot://sha256/32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af'],
    content: {observation: 'desk', captured_at: frame.captured_at, width: 2, height: 2,
      evidence_ref: 'camera.snapshot://sha256/32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af'},
  })
  assert.doesNotMatch(JSON.stringify(handoff), /base64|media:|private|path|jpeg/i)
  await adapter.close()
})

test('camera admission and cancellation happen before capture and late grants cannot hand off', async () => {
  let captureCalls = 0
  let resolveAdmission: (value: 'granted') => void = () => undefined
  const pending = new Promise<'granted'>(resolve => { resolveAdmission = resolve })
  const gated = Object.assign(source(), {
    admitObservation: () => pending,
    snapshot: () => { captureCalls += 1; return Promise.resolve(frame) },
  })
  const adapter = new CameraMcpAdapter({source: gated, mediaStore: new MediaStore(), model: 'watch-model',
    gateway: {complete() { return Promise.resolve({text: '{"observation":"desk"}'}) }}})
  await adapter.connect()
  const controller = new AbortController()
  const outcome = adapter.dispatch('snapshot', {}, context(controller.signal))
  controller.abort()
  resolveAdmission('granted')
  assert.deepEqual(await outcome, {outcome: 'cancelled', trust: 'untrusted_external', content: {error: 'cancelled'}})
  assert.equal(captureCalls, 0)
  await adapter.close()
})

test('MCP foundation accepts bounded plain text or one image only and fails closed for other shapes', () => {
  assert.deepEqual(parseMcpToolResult({content: [{type: 'text', text: 'ok'}]}), {kind: 'text', text: 'ok'})
  assert.equal(parseMcpToolResult({content: []}).kind, 'invalid')
  assert.equal(parseMcpToolResult({content: [{type: 'audio', data: 'a', mimeType: 'audio/wav'}]}).kind, 'invalid')
  assert.equal(parseMcpToolResult({content: [{type: 'text', text: 'one'}, {type: 'text', text: 'two'}]}).kind, 'invalid')
  assert.equal(parseMcpToolResult({content: [{type: 'image', data: '', mimeType: 'image/jpeg'}]}).kind, 'invalid')
  const hostile = new Proxy({}, {get() { throw new Error('hostile MCP response') }})
  assert.deepEqual(parseMcpToolResult(hostile), {kind: 'invalid'})
})
