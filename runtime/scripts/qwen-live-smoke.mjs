/**
 * Gated live smoke against the real DashScope Qwen realtime endpoint.
 *
 * Deliberately not a unit test: it needs a credential and the network, so it is a
 * separate command and it fails loudly rather than skipping when unconfigured.
 *
 *   NOVA_AUDIO_AGENT_MODEL_API_KEY=... node runtime/scripts/qwen-live-smoke.mjs
 *
 * Reads the same variables the Python runtime reads, so a working Python setup
 * needs no new configuration.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QwenAudioRealtimeAdapter } from '../dist/src/realtime/qwen.js'
import { webSocketQwenConnector } from '../dist/src/realtime/qwen-transport.js'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..')

/** Minimal .env reader so the smoke matches the Python runtime's configuration. */
function dotenv() {
  const values = {}
  try {
    for (const line of readFileSync(resolve(REPOSITORY_ROOT, '.env'), 'utf8').split('\n')) {
      const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim())
      if (match === null) continue
      values[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // Absent .env is fine; the environment may already carry the credential.
  }
  return values
}

const file = dotenv()
const setting = name => process.env[name] ?? file[name]

const apiKey = setting('DASHSCOPE_API_KEY') ?? setting('NOVA_AUDIO_AGENT_MODEL_API_KEY')
if (apiKey === undefined || apiKey === '') {
  console.error('missing DASHSCOPE_API_KEY or NOVA_AUDIO_AGENT_MODEL_API_KEY')
  process.exit(2)
}

const url = setting('NOVA_AUDIO_AGENT_QWEN_REALTIME_URL')
  ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const model = setting('NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL') ?? 'qwen-audio-3.0-realtime-plus'
const voice = setting('NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE') ?? 'longanqian'

const adapter = new QwenAudioRealtimeAdapter({
  url,
  apiKey,
  model,
  voice,
  connector: webSocketQwenConnector,
})

const stop = new AbortController()
const seen = []
let failure

/** One second of 16 kHz mono silence, which the provider accepts as input audio. */
function silence(milliseconds) {
  return new Uint8Array(2 * 16 * milliseconds)
}

try {
  const identity = await adapter.connect({tools: [], signal: stop.signal})
  console.log(`connected: epoch=${identity.epoch} session=${identity.provider_session_id}`)

  const reader = (async () => {
    for await (const event of adapter.events(stop.signal)) {
      seen.push(event.kind)
      const detail = event.kind === 'response_audio_delta'
        ? ` pcm=${event.pcm.byteLength}B`
        : event.kind === 'provider_error' ? ` code=${event.code}` : ''
      console.log(`event: ${event.kind}${detail}`)
      if (event.kind === 'response_terminal' || event.kind === 'provider_error') break
    }
  })()

  // A host fact plus an explicit response is the smallest exchange that proves the
  // full path: item injection is confirmed, a response is created, audio comes back.
  await adapter.injectHostItem({
    kind: 'final',
    host_item_id: 'smoke-1',
    event_id: 'smoke-event-1',
    content: '请用一句话确认你已连接。',
    call_id: null,
    // Qwen refuses response.create until a fresh conversation holds a user item, so
    // the smoke uses the Guard activation path whose role is `user`. Injecting the
    // same fact as a system item reproduces invalid_value.response.create.
  }, {confirmationTimeout: 10, asUserActivation: true, signal: stop.signal})
  console.log('host item confirmed')

  await adapter.sendAudio(silence(200), stop.signal)
  await adapter.createResponse({
    kind: 'host_fact',
    item: {
      kind: 'final',
      host_item_id: 'smoke-1',
      event_id: 'smoke-event-1',
      content: '请用一句话确认你已连接。',
      call_id: null,
    },
    task_summary: null,
    origin_spoken: false,
  }, stop.signal)
  console.log('response requested')

  await Promise.race([
    reader,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('live smoke timed out')),
      45_000)),
  ])
} catch (error) {
  failure = error
} finally {
  stop.abort()
  await adapter.close().catch(() => undefined)
}

const audible = seen.filter(kind => kind === 'response_audio_delta').length
console.log(`\nevents: ${seen.length}, audio deltas: ${audible}`)
if (failure !== undefined) {
  console.error(`live smoke FAILED: ${failure.message}`)
  process.exit(1)
}
if (audible === 0) {
  console.error('live smoke FAILED: the provider returned no audio')
  process.exit(1)
}
console.log('Qwen live smoke passed')
