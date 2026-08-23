import {
  QwenAudioRealtimeAdapter,
  type QwenSocket,
} from '../../src/realtime/qwen.js'

const inbound = [
  {type: 'session.created', session: {id: 'session'}},
  {type: 'session.updated', session: {id: 'session'}},
]
let parked = false
const socket: QwenSocket = {
  send: () => Promise.resolve(),
  receive: () => {
    const next = inbound.shift()
    if (next !== undefined) return Promise.resolve(JSON.stringify(next))
    parked = true
    return new Promise<string>(() => undefined)
  },
  close: () => Promise.resolve(),
}
const adapter = new QwenAudioRealtimeAdapter({
  url: 'wss://example.invalid/realtime',
  apiKey: 'k',
  model: 'm',
  voice: 'v',
  idFactory: () => 'id',
  connector: () => Promise.resolve(socket),
  closeTimeout: 0.05,
})
const signal = new AbortController().signal
await adapter.connect({tools: [], signal})
void (async () => {
  for await (const event of adapter.events(signal)) void event
})()
while (!parked) await new Promise(resolve => setImmediate(resolve))
await adapter.close()
process.stdout.write('closed\n')
