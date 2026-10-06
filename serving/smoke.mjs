// Build runtime first. Usage: node serving/smoke.mjs preset.json input.s16le
// Input must be prerecorded, mono PCM16 at 16 kHz; no microphone is opened.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {parseVoicePreset} from '../clients/desktop/src/renderer/voice-preset.mjs'
import {SelfHostedAsrClient} from '../runtime/dist/src/realtime/cascaded/self-hosted-asr.js'
import {SelfHostedTtsClient} from '../runtime/dist/src/realtime/cascaded/self-hosted-tts.js'
import {createChatCompletionsLlmFactory} from '../runtime/dist/src/realtime/cascaded/chat-completions-llm.js'
import {loadSettings} from '../runtime/dist/src/config/config.js'
import {buildConversationVoiceProvider} from '../runtime/dist/src/conversation-voice-provider.js'
import {RealClock} from '../runtime/dist/src/core/clock.js'

const raw = await readFile(process.argv[2], 'utf8')
parseVoicePreset(raw)
const preset = JSON.parse(raw)
assert.ok(preset.asr && preset.llm && preset.tts, 'Smoke requires all three stages')
const pcm = await readFile(process.argv[3])
assert.ok(pcm.length > 0 && pcm.length % 2 === 0 && pcm.length <= 2080000, 'Expected at most 65 seconds of PCM16')
const signal = AbortSignal.timeout(180000)
const result = {asr: {}, llm: {}, tts: {}}
const asr = await new SelfHostedAsrClient({endpoint: preset.asr.url, apiKey: process.env.SELF_HOSTED_ASR_API_KEY ?? ''}).open(signal)
try {
  const events = Array.fromAsync(asr.events(signal))
  void events.catch(() => {})
  for (let offset = 0; offset < pcm.length; offset += 32000) await asr.append(pcm.subarray(offset, offset + 32000), signal)
  await asr.finish(signal)
  const transcripts = await events
  assert.equal(transcripts.at(-1)?.final, true)
  assert.ok(transcripts.at(-1).text.trim(), 'ASR returned empty text')
  // Do not print fixture transcripts, which may contain private speech.
  result.asr = {final: true, characters: transcripts.at(-1).text.length}
} finally { await asr.close() }

const llm = createChatCompletionsLlmFactory({provider: 'self-hosted', baseUrl: preset.llm.baseUrl,
  apiKey: process.env.SELF_HOSTED_LLM_API_KEY ?? '', model: preset.llm.model,
  instructions: 'You are a test assistant. Call echo when requested; briefly acknowledge tool results.'}).open()
try {
  const events = await Array.fromAsync(llm.stream({inputs: [{kind: 'user_text', text: 'Call echo with text exactly nova smoke.'}],
    tools: [{name: 'echo', description: 'Echo text', parameters: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}}], signal}))
  const call = events.find(event => event.kind === 'tool_call')
  assert.equal(call?.name, 'echo')
  assert.equal(call.arguments.text, 'nova smoke')
  const response = await Array.fromAsync(llm.stream({inputs: [{kind: 'tool_result', call_id: call.call_id, output: {text: 'nova smoke', success: true}}], tools: [], signal}))
  assert.ok(response.some(event => event.kind === 'text_delta' && event.text))
  assert.ok(response.some(event => event.kind === 'response_completed'))
  result.llm = {toolCall: true, toolResult: true}
} finally { await llm.close() }

const tts = new SelfHostedTtsClient({endpoint: preset.tts.url, apiKey: process.env.SELF_HOSTED_TTS_API_KEY ?? ''})
const session = await tts.open(signal)
try {
  let frames = 0
  const reading = (async () => {
    for await (const audio of session.events(signal)) {
      assert.ok(audio.pcm.length > 0 && audio.pcm.length % 2 === 0)
      frames++
      if (frames === 1) await session.cancel()
    }
  })()
  void reading.catch(() => {})
  await session.sendText('这是一段取消测试，第一段音频收到后立即停止。后面的内容不应继续播放。', signal)
  const finish = session.finish(signal).catch(error => { if (error.name !== 'AbortError') throw error })
  await reading.catch(error => { if (error.name !== 'AbortError') throw error })
  await finish
  assert.equal(frames, 1, 'Late audio after cancellation')
  result.tts.cancel = true
} finally { await session.close() }
const next = await tts.open(signal)
try {
  const audio = Array.fromAsync(next.events(signal))
  void audio.catch(() => {})
  await next.sendText('取消后的新请求成功。', signal)
  await next.finish(signal)
  result.tts.afterCancelBytes = (await audio).reduce((sum, frame) => sum + frame.pcm.length, 0)
  assert.ok(result.tts.afterCancelBytes > 0)
} finally { await next.close() }

// Exercise the production composition as well as individual wire contracts.
const settings = loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_ASR_PROVIDER: 'self-hosted',
  CASCADE_LLM_PROVIDER: 'self-hosted', CASCADE_TTS_PROVIDER: 'self-hosted',
  CASCADE_LLM_MODEL: preset.llm.model, SELF_HOSTED_ASR_URL: preset.asr.url,
  SELF_HOSTED_LLM_BASE_URL: preset.llm.baseUrl, SELF_HOSTED_TTS_URL: preset.tts.url,
  SELF_HOSTED_ASR_API_KEY: process.env.SELF_HOSTED_ASR_API_KEY ?? '',
  SELF_HOSTED_LLM_API_KEY: process.env.SELF_HOSTED_LLM_API_KEY ?? '',
  SELF_HOSTED_TTS_API_KEY: process.env.SELF_HOSTED_TTS_API_KEY ?? ''})
const provider = buildConversationVoiceProvider({settings, clock: new RealClock(), idFactory: randomUUID})
let reading
try {
  await provider.connect({tools: [], signal})
  await provider.replaceResponseAdaptation({revision: 1, content: 'Test preference: answer in one short Chinese sentence, at most twenty characters.'}, signal)
  result.pipeline = {final: false, audioBytes: 0, completed: false}
  reading = (async () => {
    for await (const event of provider.events(signal)) {
      if (event.kind === 'user_transcript_final') {
        assert.ok(event.text.trim())
        result.pipeline.final = true
        await provider.ensureResponse(signal, event.item_id)
      }
      if (event.kind === 'response_audio_delta') result.pipeline.audioBytes += event.pcm.length
      if (event.kind === 'provider_error') throw new Error(`Pipeline provider error: ${event.code}`)
      if (event.kind === 'response_terminal') {
        assert.equal(event.status, 'completed')
        result.pipeline.completed = true
        return
      }
    }
  })()
  void reading.catch(() => {})
  for (let offset = 0; offset < pcm.length; offset += 640) {
    await provider.sendAudio(pcm.subarray(offset, offset + 640), signal)
    await delay(20, undefined, {signal})
  }
  for (let frame = 0; frame < 40; frame++) {
    await provider.sendAudio(new Uint8Array(3200), signal)
    await delay(100, undefined, {signal})
  }
  await reading
  assert.ok(result.pipeline.final && result.pipeline.completed && result.pipeline.audioBytes > 0)
} finally { await provider.close(); await reading?.catch(() => {}) }
console.log(JSON.stringify(result, null, 2))
