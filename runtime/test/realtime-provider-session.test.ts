import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  hostContextItemSchema,
  hostFact,
  RealtimeProtocolError,
  type HostContextItem,
  type HostResponseIntent,
  type JsonObject,
  type RealtimeProvider,
} from '../src/realtime/protocol.js'
import { RealtimeProviderSession } from '../src/realtime/provider-session.js'

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>(accept => { resolve = accept })
  return {promise, resolve: value => resolve?.(value)}
}

class FakeProvider implements RealtimeProvider {
  identities: unknown[] = [{epoch: 1, provider_session_id: 'session-1'}]
  emitted: unknown[] = []
  sentAudio: Uint8Array[] = []
  injected: HostContextItem[] = []
  responses: HostResponseIntent[] = []
  cancelled: string[] = []
  tools: readonly (readonly JsonObject[])[] = []
  closeCount = 0
  failure: Error | null = null
  eventGate: Promise<void> | null = null
  ignoreEventAbort = false
  itemIdentityPromise: Promise<unknown> | null = null
  itemIdentity: unknown = {
    session_epoch: 1,
    host_item_id: 'host-1',
    provider_item_id: 'provider-1',
  }

  connect(options: {
    readonly tools: readonly JsonObject[]
    readonly signal: AbortSignal
  }): Promise<unknown> {
    assert.equal(options.signal.aborted, false)
    this.tools = [...this.tools, options.tools]
    return Promise.resolve(this.identities.shift())
  }

  sendAudio(pcm: Uint8Array, signal: AbortSignal): Promise<void> {
    assert.equal(signal.aborted, false)
    if (this.failure !== null) return Promise.reject(this.failure)
    this.sentAudio.push(pcm)
    return Promise.resolve()
  }

  injectHostItem(
    item: HostContextItem,
    options: {
      readonly confirmationTimeout: number | null
      readonly asUserActivation: boolean
      readonly signal: AbortSignal
    },
  ): Promise<unknown> {
    assert.equal(options.signal.aborted, false)
    this.injected.push(item)
    return this.itemIdentityPromise ?? Promise.resolve(this.itemIdentity)
  }

  createResponse(intent: HostResponseIntent, signal: AbortSignal): Promise<void> {
    assert.equal(signal.aborted, false)
    this.responses.push(intent)
    return Promise.resolve()
  }

  cancelResponse(responseId: string, signal: AbortSignal): Promise<void> {
    assert.equal(signal.aborted, false)
    this.cancelled.push(responseId)
    return Promise.resolve()
  }

  async *events(signal: AbortSignal): AsyncIterable<unknown> {
    await Promise.resolve()
    if (this.failure !== null) throw this.failure
    await this.eventGate
    for (const event of this.emitted) {
      if (signal.aborted && !this.ignoreEventAbort) return
      yield event
    }
  }

  close(): Promise<void> {
    this.closeCount += 1
    return Promise.resolve()
  }
}

const hostItem = hostContextItemSchema.parse({
  kind: 'final',
  host_item_id: 'host-1',
  event_id: 'event-1',
  content: 'done',
})

test('provider session requires increasing epochs and resets through one reconnect path', async () => {
  const provider = new FakeProvider()
  provider.identities.push({epoch: 2, provider_session_id: 'session-2'})
  const session = new RealtimeProviderSession(provider)

  assert.deepEqual(await session.connect([{type: 'function', name: 'search'}]), {
    epoch: 1,
    provider_session_id: 'session-1',
  })
  assert.equal(session.state, 'connected')
  assert.deepEqual(await session.reconnect(), {epoch: 2, provider_session_id: 'session-2'})
  assert.equal(provider.closeCount, 1)

  await session.close()
  await session.close()
  assert.equal(provider.closeCount, 2)
  assert.equal(session.state, 'closed')
})

test('provider session rejects a reused epoch without exposing provider output', async () => {
  const provider = new FakeProvider()
  provider.identities.push({epoch: 1, provider_session_id: 'reused'})
  const session = new RealtimeProviderSession(provider)
  await session.connect()

  await assert.rejects(session.reconnect(), error => (
    error instanceof RealtimeProtocolError && error.message === 'provider session epoch must increase'
  ))
  assert.equal(session.state, 'disconnected')
  assert.equal(provider.closeCount, 2)
  await session.close()
})

test('provider event stream drops stale epochs and clones accepted PCM', async () => {
  const provider = new FakeProvider()
  const pcm = new Uint8Array([1, 2])
  provider.emitted = [
    {kind: 'response_started', session_epoch: 2, response_id: 'future'},
    {kind: 'response_started', session_epoch: 1, response_id: 'current'},
    {kind: 'response_audio_delta', session_epoch: 1, response_id: 'current', pcm},
  ]
  const session = new RealtimeProviderSession(provider)
  await session.connect()

  const accepted = []
  for await (const event of session.events()) accepted.push(event)
  pcm[0] = 9

  assert.deepEqual(accepted.map(event => event.kind), [
    'response_started',
    'response_audio_delta',
  ])
  assert.deepEqual(
    [...(accepted[1] as {readonly pcm: Uint8Array}).pcm],
    [1, 2],
  )
  await session.close()
})

test('an old event iterator cannot yield after reconnect even when its adapter ignores abort', async () => {
  const provider = new FakeProvider()
  provider.identities.push({epoch: 2, provider_session_id: 'session-2'})
  provider.emitted = [{kind: 'response_started', session_epoch: 1, response_id: 'stale'}]
  const eventGate = deferred<void>()
  provider.eventGate = eventGate.promise
  provider.ignoreEventAbort = true
  const session = new RealtimeProviderSession(provider)
  await session.connect()

  const oldNext = session.events().next()
  await Promise.resolve()
  await Promise.resolve()
  await session.reconnect()
  provider.eventGate = null
  provider.emitted = [{kind: 'response_started', session_epoch: 2, response_id: 'current'}]

  const currentEvents = session.events()
  assert.deepEqual(await currentEvents.next(), {
    done: false,
    value: {kind: 'response_started', session_epoch: 2, response_id: 'current'},
  })
  await currentEvents.return(undefined)
  eventGate.resolve()

  assert.deepEqual(await oldNext, {done: true, value: undefined})
  assert.equal(session.identity?.epoch, 2)
  await session.close()
})

test('provider event stream turns malformed adapter output into a bounded contract error', async () => {
  const provider = new FakeProvider()
  provider.emitted = [{kind: 'response_terminal', raw_secret: 'must-not-leak'}]
  const session = new RealtimeProviderSession(provider)
  await session.connect()

  await assert.rejects(async () => {
    for await (const event of session.events()) {
      void event
      assert.fail('invalid event was yielded')
    }
  }, error => (
    error instanceof RealtimeProtocolError
    && error.message === 'provider emitted an invalid realtime event'
    && !error.message.includes('must-not-leak')
  ))
  await session.close()
})

test('audio and host delivery are validated and correlated before crossing the provider boundary', async () => {
  const provider = new FakeProvider()
  const session = new RealtimeProviderSession(provider)

  await assert.rejects(session.sendAudio(new Uint8Array([1])), /PCM16/u)
  await session.connect()
  const pcm = new Uint8Array([1, 2])
  await session.sendAudio(pcm)
  pcm[0] = 9
  assert.deepEqual([...provider.sentAudio[0]!], [1, 2])

  assert.deepEqual(await session.injectHostItem(hostItem), provider.itemIdentity)
  await session.createResponse(hostFact(hostItem))
  await session.cancelResponse('response-1')
  assert.equal(provider.injected.length, 1)
  assert.equal(provider.responses.length, 1)
  assert.deepEqual(provider.cancelled, ['response-1'])

  provider.itemIdentity = {
    session_epoch: 2,
    host_item_id: 'host-1',
    provider_item_id: 'wrong-epoch',
  }
  await assert.rejects(session.injectHostItem(hostItem), /identity mismatch/u)
  await session.close()
})

test('an old host-item confirmation cannot commit after reconnect', async () => {
  const provider = new FakeProvider()
  provider.identities.push({epoch: 2, provider_session_id: 'session-2'})
  const itemGate = deferred<unknown>()
  provider.itemIdentityPromise = itemGate.promise
  const session = new RealtimeProviderSession(provider)
  await session.connect()

  const injection = session.injectHostItem(hostItem)
  await Promise.resolve()
  await session.reconnect()
  itemGate.resolve({
    session_epoch: 1,
    host_item_id: 'host-1',
    provider_item_id: 'provider-old',
  })

  await assert.rejects(injection, /stale session/u)
  assert.equal(session.identity?.epoch, 2)
  await session.close()
})

test('provider failures cross the lifecycle boundary with fixed credential-safe messages', async () => {
  const secret = 'provider-secret-must-not-leak'
  const provider = new FakeProvider()
  const session = new RealtimeProviderSession(provider)
  await session.connect()
  provider.failure = new RealtimeProtocolError(secret)

  await assert.rejects(session.sendAudio(new Uint8Array([0, 0])), error => (
    error instanceof RealtimeProtocolError
    && error.message === 'provider audio send failed'
    && !error.message.includes(secret)
    && error.cause === undefined
  ))
  await assert.rejects(async () => {
    for await (const event of session.events()) void event
  }, error => (
    error instanceof RealtimeProtocolError
    && error.message === 'provider event stream failed'
    && !error.message.includes(secret)
    && error.cause === undefined
  ))
  await session.close()
})
