/** Digital audio live acceptance. Uses production factories; never records the microphone.
 * node runtime/scripts/cascaded-live-smoke.mjs --env-file /path/to/.env --output /tmp/report.json
 * Requires ARK_API_KEY and DOUBAO_BIGMODEL_API_KEY (optional DOUBAO_ASR_API_KEY).
 */
import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {parseArgs, parseEnv} from 'node:util'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {loadSettings} from '../dist/src/config.js'
import {environmentContract} from '../dist/src/environment-contract.js'
import {requireSelectedCascadedRealtimeConfig} from '../dist/src/cascaded-realtime-config.js'
import {buildCascadedRealtimeAssembly, cascadedProviderRegistries as registry} from '../dist/src/cascaded-realtime-assembly.js'
import {parseCapabilityRegistry} from '../dist/src/capability-registry.js'
import {CascadedRealtimeProvider} from '../dist/src/realtime/cascaded/provider.js'
import {RealClock} from '../dist/src/clock.js'
import {NullTelemetry} from '../dist/src/realtime/telemetry.js'

const {values} = parseArgs({options: {'env-file': {type: 'string'}, output: {type: 'string'}}})
const report = {startedAt: new Date().toISOString(), cases: [], scope: 'digital audio; no microphone or speaker playback'}
const stop = new AbortController()
const deadline = setTimeout(() => stop.abort(new Error('live_smoke_timeout')), 180_000)
let provider
let reader
let readerError
let assembly
const events = []
const telemetry = new NullTelemetry()
let phase = 'configuration'

async function waitFor(label, predicate, milliseconds = 40_000) {
  const until = Date.now() + milliseconds
  while (!predicate()) {
    stop.signal.throwIfAborted()
    if (readerError) throw readerError
    const failure = events.find(event => event.kind === 'provider_error')
    if (failure) throw Object.assign(new Error('provider_failure'), {code: failure.code})
    assert.ok(Date.now() < until, `${label}_timeout`)
    await delay(20, undefined, {signal: stop.signal})
  }
}
function passed(name, details = {}) {
  report.cases.push({name, status: 'passed', ...details})
  console.log(JSON.stringify(report.cases.at(-1)))
}
function watch() {
  events.length = 0
  readerError = undefined
  reader = (async () => {
    for await (const event of provider.events(stop.signal)) {
      // Keep bounded diagnostic metadata; do not retain output PCM or credentials.
      const {pcm, ...rest} = event
      events.push(pcm ? {...rest, audioBytes: pcm.byteLength} : rest)
      assert.ok(events.length < 10_000, 'event_limit')
      if (event.kind === 'user_transcript_final') {
        assert.equal(await provider.ensureResponse(stop.signal, event.item_id), true, 'host_request_admitted')
      }
    }
  })().catch(error => { readerError = error })
}
async function host(id, content) {
  const item = {kind: 'final', host_item_id: id, event_id: id, content, call_id: null}
  await provider.injectHostItem(item, {confirmationTimeout: null, asUserActivation: true, signal: stop.signal})
  await provider.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false}, stop.signal)
}

async function synthesizeInput(factory, text) {
  const source = await factory.openClient().open(stop.signal)
  const chunks = []
  const sourceReader = (async () => {
    for await (const frame of source.events(stop.signal)) {
      chunks.push(Buffer.from(frame.pcm))
      assert.ok(chunks.reduce((n, chunk) => n + chunk.length, 0) < 2_000_000, 'source_audio_limit')
    }
  })()
  void sourceReader.catch(() => undefined)
  try {
    await source.sendText(text, stop.signal)
    await source.finish(stop.signal)
    await sourceReader
  } finally { await source.close() }
  const original = Buffer.concat(chunks)
  assert.ok(original.length > 4800, 'empty_source_audio')
  // Test fixture conversion only: 24 kHz PCM16 -> 16 kHz by linear interpolation.
  const pcm = Buffer.alloc(Math.floor(original.length / 2 * 2 / 3) * 2)
  for (let i = 0; i < pcm.length / 2; i++) {
    const position = i * 1.5
    const left = Math.floor(position)
    const right = Math.min(left + 1, original.length / 2 - 1)
    const fraction = position - left
    pcm.writeInt16LE(Math.round(original.readInt16LE(left * 2) * (1 - fraction)
      + original.readInt16LE(right * 2) * fraction), i * 2)
  }
  return pcm
}

try {
  const file = values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {}
  const environment = {...file, ...process.env}
  const ignored = environmentContract.filter(entry => entry.owner.startsWith('retired_') && entry.name in environment)
  for (const entry of ignored) delete environment[entry.name]
  const settings = loadSettings({...environment,
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded', NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark'})
  const config = requireSelectedCascadedRealtimeConfig(settings)
  passed(phase, {ignoredRetiredKeys: ignored.map(entry => entry.name)})
  const clock = new RealClock()
  const ids = {next: () => randomUUID()}
  const ttsFactory = registry.tts.volcengine({config: config.tts, ids})
  const llmFactory = registry.llm.ark({config: config.llm.config, clock, ids,
    instructions: '你是语音测试助手。普通问题用一句中文简短回答。要求列举时逐条列举。要求调用工具时只调用指定工具，得到结果后用一句话报告。'})
  provider = new CascadedRealtimeProvider({
    endpointingFactory: registry.endpointing.auto({config: config.endpointing, clock}),
    asrFactory: registry.asr.volcengine({config: config.asr, ids}),
    llmFactory, ttsFactory, telemetry, idFactory: randomUUID,
  })
  const tools = [{type: 'function', function: {name: 'smoke_echo',
    description: '测试工具，返回测试值。', parameters: {type: 'object', properties: {}, additionalProperties: false}}}]

  phase = 'tts_input_generation'
  const pcm = await synthesizeInput(ttsFactory, '你好，请告诉我一加一等于几。')
  passed(phase, {inputAudioMs: Math.round(pcm.length / 32)})

  phase = 'audio_asr_llm_tts'
  const identity = await provider.connect({tools, signal: stop.signal})
  watch()
  const started = Date.now()
  const input = Buffer.concat([Buffer.alloc(32000), pcm, Buffer.alloc(64000)])
  for (let offset = 0; offset < input.length; offset += 1024) {
    await provider.sendAudio(input.subarray(offset, offset + 1024), stop.signal)
    await delay(32, undefined, {signal: stop.signal})
  }
  await waitFor(phase, () => events.some(event => event.kind === 'response_terminal'))
  assert.ok(events.some(event => event.kind === 'user_speech_started'))
  assert.ok(events.some(event => event.kind === 'user_speech_ended'))
  assert.ok(events.some(event => event.kind === 'user_transcript_final' && /一|1/.test(event.text)))
  assert.ok(events.some(event => event.kind === 'response_audio_delta' && event.audioBytes > 0))
  assert.equal(events.find(event => event.kind === 'response_terminal').status, 'completed')
  assert.deepEqual(events.find(event => event.kind === 'response_started').origin, {
    kind: 'user_item', item_id: events.find(event => event.kind === 'user_transcript_final').item_id,
  })
  passed(phase, {elapsedMs: Date.now() - started,
    audioBytes: events.reduce((n, event) => n + (event.audioBytes ?? 0), 0)})

  phase = 'cancel_live_response'
  events.length = 0
  await host('cancel-test', '请详细列举从一到一百的数字，每个数字另起一句。')
  await waitFor(phase, () => events.some(event => event.kind === 'response_audio_delta'))
  const activeId = events.find(event => event.kind === 'response_started').response_id
  assert.deepEqual(events.find(event => event.kind === 'response_started').origin,
    {kind: 'host_request', host_item_id: 'cancel-test'})
  await provider.cancelResponse(activeId, stop.signal)
  await waitFor(phase, () => events.some(event => event.kind === 'response_terminal' && event.response_id === activeId))
  assert.equal(events.filter(event => event.kind === 'response_terminal' && event.response_id === activeId).length, 1)
  assert.equal(events.find(event => event.kind === 'response_terminal' && event.response_id === activeId).status, 'cancelled')
  passed(phase)

  phase = 'reconnect_and_tool_continuation'
  await provider.close()
  await reader
  const next = await provider.connect({tools, signal: stop.signal})
  assert.equal(next.epoch, identity.epoch + 1)
  watch()
  const toolPcm = await synthesizeInput(ttsFactory, '请调用测试工具，读取测试值，然后告诉我结果。')
  const toolInput = Buffer.concat([Buffer.alloc(32000), toolPcm, Buffer.alloc(64000)])
  for (let offset = 0; offset < toolInput.length; offset += 1024) {
    await provider.sendAudio(toolInput.subarray(offset, offset + 1024), stop.signal)
    await delay(32, undefined, {signal: stop.signal})
  }
  await waitFor(phase, () => events.some(event => event.kind === 'tool_call_ready'))
  const call = events.find(event => event.kind === 'tool_call_ready')
  await waitFor(phase, () => events.some(event => event.kind === 'response_terminal'))
  const item = {kind: 'tool_output', host_item_id: 'tool-result', event_id: 'tool-result',
    content: JSON.stringify({value: '测试成功'}), call_id: call.call_id}
  await provider.injectHostItem(item, {confirmationTimeout: null, asUserActivation: false, signal: stop.signal})
  const previousCount = events.filter(event => event.kind === 'response_terminal').length
  await provider.createResponse({kind: 'tool_result', item, task_summary: null, origin_spoken: false}, stop.signal)
  await waitFor(phase, () => events.filter(event => event.kind === 'response_terminal').length > previousCount)
  assert.ok(events.every(event => event.session_epoch === next.epoch))
  assert.deepEqual(events.filter(event => event.kind === 'response_started').map(event => event.origin), [
    {kind: 'user_item', item_id: events.find(event => event.kind === 'user_transcript_final').item_id},
    {kind: 'host_request', host_item_id: 'tool-result'},
  ])
  assert.ok(events.some(event => event.kind === 'response_audio_delta'))
  assert.equal(events.filter(event => event.kind === 'response_terminal').at(-1).status, 'completed')
  passed(phase)

  // Exercise the production host graph with a digital renderer acknowledgement seam.
  // No external executors are exposed, and no user workspace state is opened.
  await provider.close()
  await reader
  events.length = 0
  phase = 'host_playback_barge_in_and_recovery'
  const frames = []
  const clears = []
  const deliveries = []
  let acknowledgeCompletion = false
  assembly = buildCascadedRealtimeAssembly({
    settings: {...settings, executors: [], workspace_graph_enabled: false, camera_module_enabled: false},
    capabilities: parseCapabilityRegistry({version: 1, modules: {
      coding: {enabled: false}, camera: {enabled: false}, search: {enabled: false},
    }}, {}),
    telemetry,
    onDiagnostic: () => undefined,
    onAudioFrame: frame => {
      frames.push({utteranceId: frame.utterance_id, epoch: frame.generation_epoch, bytes: frame.pcm.length})
      assembly.service.playbackStarted(frame.utterance_id, frame.generation_epoch)
    },
    onAudioClear: (utteranceId, epoch) => {
      clears.push({utteranceId, epoch, frameIndex: frames.length})
      queueMicrotask(() => assembly.service.playbackCleared(utteranceId, epoch, 0))
    },
    onAudioTerminal: (utteranceId, epoch) => {
      if (acknowledgeCompletion) queueMicrotask(() => assembly.service.playbackDone(utteranceId, epoch, null))
    },
    onDelivery: delivery => deliveries.push(delivery),
  })
  await assembly.start()
  const feedHost = async audio => {
    for (let offset = 0; offset < audio.length; offset += 1024) {
      stop.signal.throwIfAborted()
      await assembly.service.sendAudio(audio.subarray(offset, offset + 1024))
      await delay(32, undefined, {signal: stop.signal})
    }
  }
  await feedHost(Buffer.alloc(64000))
  assert.equal(frames.length, 0, 'silence_must_not_generate_audio')
  await feedHost(input)
  await waitFor('host_first_audio', () => frames.length > 0)
  const interrupted = frames[0]
  await assembly.service.localSpeechOnset('smoke-local-onset')
  await waitFor('host_clear', () => clears.some(clear => clear.utteranceId === interrupted.utteranceId))
  await waitFor('host_interrupted_delivery', () => deliveries.some(delivery => delivery.disposition === 'interrupted'))
  const afterClear = clears.find(clear => clear.utteranceId === interrupted.utteranceId).frameIndex
  acknowledgeCompletion = true
  await feedHost(input)
  await waitFor('host_recovered_delivery', () => deliveries.some(delivery => delivery.disposition === 'spoken'))
  assert.ok(frames.slice(afterClear).every(frame => frame.utteranceId !== interrupted.utteranceId), 'stale_audio_after_clear')
  assert.ok(frames.slice(afterClear).some(frame => frame.bytes > 0), 'missing_recovery_audio')
  passed(phase, {clears: clears.length, deliveries: deliveries.map(delivery => delivery.disposition)})

  phase = 'host_fact_attribution_and_queue_reuse'
  for (let index = 1; index <= 2; index++) {
    const eventId = `host-fact-${index}`
    const item = {kind: 'final', host_item_id: eventId, event_id: eventId, call_id: null,
      content: `第${index}条系统测试结果已经就绪。`}
    assembly.service.queueHostItem({kind: 'host_fact', item, task_summary: null, origin_spoken: false})
    await waitFor(phase, () => assembly.service.session.snapshot().spoken_event_ids.includes(eventId))
  }
  assert.equal(assembly.service.session.providerIdle, true, 'host_queue_must_release_after_terminal')
  passed(phase, {spokenEvents: assembly.service.session.snapshot().spoken_event_ids.filter(id => id.startsWith('host-fact-'))})
} catch (error) {
  // Error messages from transports may contain URLs or headers. Emit only stable codes.
  report.eventSummary = events.map(event => ({kind: event.kind,
    ...(event.kind === 'response_terminal' ? {status: event.status, reason: event.reason} : {}),
  }))
  report.cases.push({name: phase, status: 'failed', error: error?.code ?? error?.name ?? 'Error',
    ...(error?.code === 'ERR_ASSERTION' && error.generatedMessage === false ? {check: error.message} : {})})
  console.error(JSON.stringify(report.cases.at(-1)))
  process.exitCode = 1
} finally {
  stop.abort()
  try { await assembly?.stop(); await provider?.close(); await reader } catch {
    report.cases.push({name: 'cleanup', status: 'failed', error: 'close_failed'})
    process.exitCode = 1
  }
  clearTimeout(deadline)
  report.endpointing = telemetry.diagnostics().records.filter(record => /endpointing/.test(record.kind))
  report.finishedAt = new Date().toISOString()
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600})
}
