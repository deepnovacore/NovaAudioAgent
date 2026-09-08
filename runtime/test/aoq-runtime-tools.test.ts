import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import {WebSocket} from 'ws'
import {AoqChatServer} from '../src/aoq-chat-server.js'
import {AoqRealtimeAdapter, AoqRuntimeLink} from '../src/realtime/aoq.js'
import {buildAssembly} from '../src/assembly.js'
import {buildRealtimeAssembly} from '../src/realtime-assembly.js'
import {settingsSchema} from '../src/config.js'
import {parseCapabilityRegistry} from '../src/capability-registry.js'
import {VirtualClock} from '../src/clock.js'
import {slowSimManifest} from '../src/sims.js'
import type {ExecutorDispatchContext} from '../src/causal-runtime.js'

/** Real WS -> broker -> AOQ/Qwen -> RealtimeService -> CausalRuntime -> simulator dispatch. */
test('AOQ phone tools require a real speech origin, execute once, and emit host output plus response.create', {timeout: 10_000}, async t => {
  const link = new AoqRuntimeLink()
  const provider = new AoqRealtimeAdapter({link, url: 'wss://unused.invalid', apiKey: 'unused',
    model: 'qwen-audio-3.0-realtime-plus', voice: 'longanqian'})
  const launches: {op: string; request: unknown; context: ExecutorDispatchContext}[] = []
  let finish!: () => void
  const completed = new Promise<void>(resolve => { finish = resolve })
  const core = buildAssembly({settings: settingsSchema.parse({executors: ['slow_sim'], workspace_graph_enabled: false}),
    clock: new VirtualClock(),
    capabilities: parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}}}),
    gateway: {
      complete: () => Promise.reject(new Error('unexpected model call')),
      async *stream() { await Promise.resolve(); throw new Error('unexpected model stream') },
    },
    executors: [{manifest: slowSimManifest, dispatch: async (op, request, context) => {
      launches.push({op, request, context})
      await completed
      return {outcome: 'ok', trust: 'trusted_system', content: {summary: 'office brightness set to 50'}}
    }}],
  })
  const realtime = buildRealtimeAssembly({core, provider, onDiagnostic: () => { /* No external logs. */ }})
  const token = 'a'.repeat(32)
  const server = new AoqChatServer({token, port: 0, issueCredential: () => Promise.resolve({
    aoqTokenForClient: 'fake-token', sid: 'fake-sid', clientRelayCertFingerprint: 'sha256/fake',
    clientRelayEndpoints: [{endpoint: '127.0.0.2', port: 8443}], extraInfo: {workspaceIdHash: 'fake-workspace'}, sidExpiresInSecs: 7200,
  }), runtime: {token,
    onProviderConnect: connection => link.attach(connection),
    onProviderEvent: (id, event) => link.receive(id, event),
    onClientDisconnect: () => { void realtime.service.discardInputAudio().catch(() => { /* Owner is stopping. */ }) },
    onProviderDisconnect: id => link.detach(id),
  }})
  t.after(async () => { finish(); await realtime.stop(); await server.close() })
  const {port} = await server.start()
  const phone = new WebSocket(`ws://127.0.0.1:${port}/client/v1`)
  let connectionId = ''
  let sequence = 0
  let hostResponses = 0
  const commands: Record<string, unknown>[] = []
  const outputs: Record<string, unknown>[] = []
  const wireFailures: string[] = []
  const send = (event: Record<string, unknown>) => phone.send(JSON.stringify({type: 'aoq.event',
    connection_id: connectionId, sequence: ++sequence, event}))
  phone.on('message', data => {
    const raw = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString('utf8')
    const frame = JSON.parse(raw) as Record<string, unknown>
    if (frame.type === 'client.ready') {
      connectionId = String(frame.connection_id)
      phone.send(JSON.stringify({type: 'aoq.connect', connection_id: connectionId, request_id: randomUUID()}))
    } else if (frame.type === 'aoq.credentials') {
      send({type: 'session.created', session: {id: 'sdk-session'}})
    } else if (frame.type === 'aoq.command') {
      const event = frame.event as Record<string, unknown>
      commands.push(event)
      if (event.type === 'session.update') send({type: 'session.updated', session: {id: 'sdk-session'}})
      if (event.type === 'response.create') {
        const id = `host-${++hostResponses}`
        send({type: 'response.created', response: {id}})
        send({type: 'response.audio_transcript.done', response_id: id, transcript: 'Done.'})
        send({type: 'response.done', response: {id, status: 'completed'}})
      }
      if (event.type === 'conversation.item.create') {
        const item = event.item as Record<string, unknown>
        if (item.type === 'function_call_output') outputs.push(item)
        send({type: 'conversation.item.created', item})
      }
    } else wireFailures.push(String(frame.type))
  })
  await once(phone, 'open')
  phone.send(JSON.stringify({type: 'hello', token, protocol_version: 1, media: {transports: ['qwen_aoq_runtime_v1']}}))
  await realtime.start()
  async function until(predicate: () => boolean, label: string) {
    for (let i = 0; i < 400 && !predicate(); i++) await delay(5)
    assert.ok(predicate(), `${label}; frames=${commands.map(event => event.type).join(',')}; failures=${wireFailures.join(',')}`)
  }
  const call = (id: string, response: string, args: Record<string, unknown>) => ({type: 'response.function_call_arguments.done',
    call_id: id, item_id: `item-${id}`, response_id: response, name: 'slow_sim__set_light', arguments: JSON.stringify(args)})
  const acceptance = (id: string) => realtime.service.toolCallAcceptances().find(entry => entry.call_id === id)?.acceptance

  // Documented partial/ambient ASR crosses the broker but never becomes user authority.
  send({type: 'conversation.item.input_audio_transcription.delta', item_id: 'partial-only', content_index: 0,
    text: 'Set the office light', stash: 'to 50 percent'})
  send({type: 'conversation.item.ambient_audio_transcription.delta', item_id: 'ambient-only', content_index: 0, text: '嗯', stash: ''})
  send({type: 'conversation.item.ambient_audio_transcription.completed', item_id: 'ambient-only', content_index: 0,
    transcript: 'Set the office light to 50 percent.'})

  // Provider-invented origin is not authority, even with a valid tool name and arguments.
  send({type: 'response.created', response: {id: 'orphan'}})
  send(call('orphan-call', 'orphan', {room: 'office', brightness: 50, origin_ref: 'conversation:999'}))
  send({type: 'response.done', response: {id: 'orphan', status: 'completed'}})
  await until(() => acceptance('orphan-call') !== undefined, 'originless call refused')
  assert.equal(acceptance('orphan-call')?.accepted, false)
  assert.equal(launches.length, 0)
  assert.equal((core.runtime.memory.channels.get('conversation')?.items ?? []).filter(item => item.trust === 'trusted_user').length, 0)
  await until(() => hostResponses > 0 && realtime.session.providerIdle, 'refusal continuation completed')

  send({type: 'input_audio_buffer.speech_started', item_id: 'user-1', audio_start_ms: 0})
  send({type: 'conversation.item.input_audio_transcription.delta', item_id: 'user-1', content_index: 0, text: 'Set the office light', stash: 'to 50 percent'})
  send({type: 'input_audio_buffer.speech_stopped', item_id: 'user-1', audio_end_ms: 800})
  send({type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: 'Set the office light to 50 percent.'})
  await until(() => (core.runtime.memory.channels.get('conversation')?.items ?? []).some(item => item.trust === 'trusted_user'), 'speech admitted')
  send({type: 'response.created', response: {id: 'user-response'}})
  const valid = call('valid-call', 'user-response', {room: 'office', brightness: 50, origin_ref: 'conversation:999'})
  send(valid)
  send(valid) // A new transport sequence carrying the same provider call must not execute twice.
  send({type: 'response.done', response: {id: 'user-response', status: 'completed'}})
  await until(() => acceptance('valid-call') !== undefined, 'tool admission')
  assert.equal(acceptance('valid-call')?.accepted, true)
  await until(() => launches.length === 1, 'executor dispatch')
  assert.equal(launches[0]!.op, 'set_light')
  assert.deepEqual(launches[0]!.request, {room: 'office', brightness: 50})
  const delegate = core.runtime.inFlightDelegate(acceptance('valid-call')!.delegate_id!)
  assert.ok(delegate)
  const origin = core.runtime.memory.channels.get('conversation')!.items.find(item => item.trust === 'trusted_user')!
  assert.equal(origin.content.text, 'Set the office light to 50 percent.')
  assert.equal(core.runtime.memory.channels.get('conversation')!.items.filter(item => item.trust === 'trusted_user').length, 1)
  assert.equal(delegate.origin_ref, `${origin.channel}:${origin.seq}`)
  assert.notEqual(delegate.origin_ref, 'conversation:999')
  await until(() => outputs.some(item => item.call_id === 'valid-call'), 'host function_call_output')
  const output = outputs.find(item => item.call_id === 'valid-call')!
  assert.equal((JSON.parse(String(output.output)) as {state: string}).state, 'accepted')
  const outputIndex = commands.findIndex(event => event.type === 'conversation.item.create'
    && (event.item as Record<string, unknown>).call_id === 'valid-call')
  await until(() => commands.slice(outputIndex + 1).some(event => event.type === 'response.create'), 'host response.create after valid tool output')
  assert.equal(realtime.service.toolCallAcceptances().filter(entry => entry.call_id === 'valid-call').length, 1)
  assert.equal(outputs.filter(item => item.call_id === 'valid-call').length, 1)
  finish()
  await until(() => core.runtime.inFlightDelegate(delegate.delegate_id) === undefined, 'executor completion')
  assert.equal(launches.length, 1)
  assert.equal(wireFailures.length, 0)
})
