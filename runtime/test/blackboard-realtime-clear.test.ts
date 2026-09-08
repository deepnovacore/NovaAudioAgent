import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {buildAssembly, type Assembly} from '../src/assembly.js'
import {VirtualClock} from '../src/clock.js'
import {settingsSchema} from '../src/config.js'
import type {Frame, FrameSource} from '../src/executors/watcher.js'
import type {BlackboardSessionOptions} from '../src/memory/blackboard-session.js'
import type {
  PersonalMemoryAdmissionReceipt,
  PersonalMemoryRecallResult,
  PersonalMemoryResource,
  PersonalMemoryRememberTurn,
} from '../src/memory/personal-memory.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model-gateway.js'
import {buildRealtimeAssembly, type RealtimeAssembly} from '../src/realtime-assembly.js'
import type {SearchTransport} from '../src/executors/search.js'
import type {HostContextItem, HostResponseIntent, JsonObject, RealtimeProvider} from '../src/realtime/protocol.js'

class SilentFrameSource implements FrameSource {
  start(): Promise<void> { return Promise.resolve() }
  stop(): Promise<void> { return Promise.resolve() }
  snapshot(): Promise<Frame | null> { return Promise.resolve(null) }
}

class NeverCalledGateway implements ModelGateway {
  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    void request
    await Promise.reject(new Error('model gateway stream was not expected'))
  }

  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    void request
    return Promise.reject(new Error('model gateway completion was not expected'))
  }
}

class NeverCalledSearch implements SearchTransport {
  search(query: string, options: {readonly maxResults: number}): Promise<Record<string, unknown>> {
    void query
    void options
    return Promise.reject(new Error('search was not expected'))
  }
}

class EpochProvider implements RealtimeProvider {
  connectCalls = 0
  closeCalls = 0

  connect(options: {readonly tools: readonly JsonObject[]; readonly signal: AbortSignal}): Promise<unknown> {
    assert.equal(options.signal.aborted, false)
    this.connectCalls += 1
    return Promise.resolve({epoch: this.connectCalls, provider_session_id: `provider-${this.connectCalls}`})
  }

  sendAudio(pcm: Uint8Array, signal: AbortSignal): Promise<void> {
    void pcm
    assert.equal(signal.aborted, false)
    return Promise.resolve()
  }

  injectHostItem(
    item: HostContextItem,
    options: {readonly confirmationTimeout: number | null; readonly asUserActivation: boolean; readonly signal: AbortSignal},
  ): Promise<unknown> {
    void options.confirmationTimeout
    void options.asUserActivation
    assert.equal(options.signal.aborted, false)
    return Promise.resolve({session_epoch: this.connectCalls, host_item_id: item.host_item_id, provider_item_id: item.host_item_id})
  }

  createResponse(intent: HostResponseIntent, signal: AbortSignal): Promise<void> {
    void intent
    assert.equal(signal.aborted, false)
    return Promise.resolve()
  }

  cancelResponse(responseId: string, signal: AbortSignal): Promise<void> {
    void responseId
    assert.equal(signal.aborted, false)
    return Promise.resolve()
  }

  async *events(signal: AbortSignal): AsyncIterable<unknown> {
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), {once: true}) })
  }

  close(): Promise<void> {
    this.closeCalls += 1
    return Promise.resolve()
  }
}

class LongLivedPersonalMemory implements PersonalMemoryResource {
  readonly records = ['long-lived personal fact']
  opens = 0
  closes = 0
  clearCalls = 0

  open(): Promise<void> { this.opens += 1; return Promise.resolve() }
  close(): Promise<void> { this.closes += 1; return Promise.resolve() }
  clear(): void { this.clearCalls += 1 }

  recall(): Promise<PersonalMemoryRecallResult> {
    return Promise.resolve({source: 'personal', state: 'empty', scope: 'recent', hits: [], degraded: false})
  }

  remember(turn: PersonalMemoryRememberTurn): Promise<PersonalMemoryAdmissionReceipt> {
    this.records.push(turn.text)
    return Promise.resolve({sourceId: turn.sourceId, state: 'stored'})
  }
}

function core(blackboard: BlackboardSessionOptions): Assembly {
  return buildAssembly({
    settings: settingsSchema.parse({executors: ['fast_sim']}),
    blackboard,
    clock: new VirtualClock(0),
    gateway: new NeverCalledGateway(),
    searchTransport: new NeverCalledSearch(),
    frameSource: new SilentFrameSource(),
  })
}

function realtime(
  coreAssembly: Assembly,
  provider = new EpochProvider(),
  personal?: LongLivedPersonalMemory,
  onAudioClear?: (utteranceId: string, generationEpoch: number) => void,
): RealtimeAssembly {
  return buildRealtimeAssembly({
    core: coreAssembly,
    provider,
    ...(personal === undefined ? {} : {createPersonalMemory: () => personal}),
    ...(onAudioClear === undefined ? {} : {onAudioClear}),
    onDiagnostic: () => undefined,
  })
}

test('service clear replaces a recovered SQLite conversation without clearing personal memory or retaining session delegate projection', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-realtime-clear-'))
  const blackboard = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  let active: RealtimeAssembly | undefined
  try {
    active = realtime(core(blackboard))
    await active.start()
    await active.runtime.ingestUserInput({text: 'old durable turn'})
    active.runtime.memory.channels.get('conversation')!.replaceSummary('old durable summary', 1, 0)
    await active.runtime.flushMemory()
    await active.stop()

    const personal = new LongLivedPersonalMemory()
    const provider = new EpochProvider()
    active = realtime(core(blackboard), provider, personal)
    await active.start()
    assert.deepEqual(active.runtime.memory.channels.get('conversation')!.items.map(item => item.content.text), ['old durable turn'])
    assert.equal(active.runtime.memory.channels.get('conversation')!.summary, 'old durable summary')
    active.session.registerDelegate('old-executor', {
      summary: 'old private executor control', state: 'running', channel: 'fast_sim', progress_summary: 'old progress',
    })

    const clearing = active.clearConversation()
    assert.equal(active.clearConversation(), clearing)
    assert.equal(active.service.clearingConversation, true)
    await clearing

    assert.equal(active.service.clearingConversation, false)
    assert.equal(active.session.sessionEpoch, 2)
    assert.equal(provider.connectCalls, 2)
    assert.deepEqual(active.runtime.memory.channels.get('conversation')!.items, [])
    assert.equal(active.runtime.memory.channels.get('conversation')!.summary, null)
    assert.deepEqual(active.session.snapshot().active_delegates, [])
    assert.equal(personal.clearCalls, 0)
    assert.deepEqual(personal.records, ['long-lived personal fact'])
    assert.equal(personal.opens, 1)

    await active.runtime.ingestUserInput({text: 'new durable turn'})
    await active.runtime.flushMemory()
    await active.stop()

    active = realtime(core(blackboard))
    await active.start()
    const conversation = active.runtime.memory.channels.get('conversation')!
    assert.deepEqual(conversation.items.map(item => item.content.text), ['new durable turn'])
    assert.equal(conversation.summary, null)
  } finally {
    await active?.stop().catch(() => undefined)
    await rm(directory, {recursive: true, force: true})
  }
})

test('assembly clear shares one promise with synchronous playback-clear reentrancy', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-realtime-clear-reentrant-'))
  const blackboard = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  const provider = new EpochProvider()
  let active: RealtimeAssembly | undefined
  let reentrant: Promise<void> | undefined
  let entered = false
  try {
    active = realtime(core(blackboard), provider, undefined, () => {
      if (entered) return
      entered = true
      reentrant = active!.clearConversation()
    })
    await active.start()
    await active.service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'old-response'})
    await active.service.handleEvent({
      kind: 'response_audio_delta', session_epoch: 1, response_id: 'old-response', pcm: new Uint8Array([0, 1]),
    })
    assert.notEqual(active.session.currentGeneration, null)

    const outer = active.clearConversation()
    assert.equal(reentrant, outer)
    assert.equal(active.clearConversation(), outer)
    await outer

    assert.equal(provider.connectCalls, 2)
  } finally {
    await active?.stop().catch(() => undefined)
    await rm(directory, {recursive: true, force: true})
  }
})
