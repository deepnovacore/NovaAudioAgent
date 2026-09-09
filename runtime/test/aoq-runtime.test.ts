import assert from 'node:assert/strict'
import {test} from 'node:test'
import {AoqRuntimeLink, AoqRealtimeAdapter} from '../src/realtime/aoq.js'

test('AOQ waits for the phone, uses its session and replaces only the data connection', async () => {
  const link = new AoqRuntimeLink()
  let now = 0
  const adapter = new AoqRealtimeAdapter({link, url: 'wss://unused.invalid', apiKey: 'unused',
    model: 'qwen-audio-3.0-realtime-plus', voice: 'longanqian', connectTimeout: 0.03, now: () => now})
  const abort = new AbortController()
  const sent: Record<string, unknown>[] = []
  const connect = adapter.connect({tools: [{type: 'function', name: 'dispatch'}], signal: abort.signal})
  // Waiting for a human to attach must not consume the provider handshake timeout.
  now += 0.05
  const attach = (id: string) => {
    link.attach({id, disconnect: () => link.detach(id), send: event => {
      sent.push(event)
      if (event.type === 'session.update') link.receive(id, {type: 'session.updated', session: {id}})
      return Promise.resolve()
    }})
    link.receive(id, {type: 'session.created', session: {id}})
  }
  attach('first')
  const first = await connect
  assert.equal(first.provider_session_id, 'first')
  assert.deepEqual((sent[0]?.session as Record<string, unknown>).tools, [{type: 'function', name: 'dispatch'}])
  await assert.rejects(adapter.sendAudio(new Uint8Array([0, 0]), abort.signal), /phone owns/u)
  link.detach('first')
  await adapter.close()
  const next = adapter.connect({tools: [], signal: abort.signal})
  attach('second')
  link.receive('first', {type: 'error'}) // A delayed old connection cannot contaminate the new session.
  const second = await next
  assert.ok(second.epoch > first.epoch)
  assert.equal(second.provider_session_id, 'second')
  await adapter.close()
  const pending = adapter.connect({tools: [], signal: abort.signal})
  abort.abort()
  await assert.rejects(pending)
})

test('AOQ attachment queues are bounded and closing a detached socket cannot close its successor', async () => {
  const link = new AoqRuntimeLink()
  const closed: string[] = []
  const abort = new AbortController()
  link.attach({id: 'a', send: () => Promise.resolve(), disconnect: () => { closed.push('a'); link.detach('a') }})
  const old = await link.take(abort.signal)
  link.detach('a')
  link.attach({id: 'b', send: () => Promise.resolve(), disconnect: () => { closed.push('b'); link.detach('b') }})
  await old.close()
  assert.deepEqual(closed, [])
  for (let i = 0; i < 130; i++) link.receive('b', {type: 'session.created', session: {id: 'b'}})
  assert.deepEqual(closed, ['b'])
})
