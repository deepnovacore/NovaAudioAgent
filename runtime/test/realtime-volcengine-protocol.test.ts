import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import {
  ConfigurationError,
  loadSettings,
  requireVolcengineRealtime,
  type Settings,
  type VolcengineRealtimeConfig,
} from '../src/config.js'
import { volcengineInputPcm } from '../src/realtime/volcengine/audio.js'
import { MAX_VOLCENGINE_WIRE_FRAME_BYTES } from '../src/realtime/volcengine/audio.js'
import { MAX_REALTIME_PCM_BYTES } from '../src/realtime/protocol.js'
import {
  DoubaoAsrError,
  DoubaoAsrProtocol,
  MAX_VOLCENGINE_JSON_BYTES,
} from '../src/realtime/volcengine/asr.js'
import {
  EventType,
  MessageType,
  VolcMessage,
  VolcProtocolError,
} from '../src/realtime/volcengine/protocol.js'
import { TextChunker } from '../src/realtime/volcengine/tts.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/realtime/volcengine/v1')
const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'protocol.json'), 'utf8')) as Fixture
const expected = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'protocol-expected.json'), 'utf8'),
) as Expected

interface FixtureCase {readonly id: string; readonly [key: string]: unknown}
interface Fixture {
  readonly schema_version: number
  readonly config: readonly FixtureCase[]
  readonly asr_encode: readonly FixtureCase[]
  readonly asr_decode: readonly FixtureCase[]
  readonly tts_codec: readonly FixtureCase[]
  readonly text_chunker: readonly FixtureCase[]
}
interface Expected {
  readonly schema_version: number
  readonly config: Readonly<Record<string, unknown>>
  readonly asr_encode: Readonly<Record<string, unknown>>
  readonly asr_decode: Readonly<Record<string, {readonly frame_b64: string; readonly result: unknown}>>
  readonly tts_codec: Readonly<Record<string, {readonly frame_b64: string; readonly result: unknown}>>
  readonly text_chunker: Readonly<Record<string, unknown>>
}

const settingEnvironment: Readonly<Record<string, string>> = {
  ark_api_key: 'ARK_API_KEY',
  doubao_asr_api_key: 'DOUBAO_ASR_API_KEY',
  doubao_bigmodel_api_key: 'DOUBAO_BIGMODEL_API_KEY',
  volcengine_ark_base_url: 'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL',
  volcengine_ark_model: 'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL',
  volcengine_ark_support_model: 'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL',
  doubao_asr_endpoint: 'NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT',
  doubao_asr_resource_id: 'NOVA_AUDIO_AGENT_DOUBAO_ASR_RESOURCE_ID',
  doubao_asr_chunk_ms: 'NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS',
  doubao_tts_endpoint: 'NOVA_AUDIO_AGENT_DOUBAO_TTS_ENDPOINT',
  doubao_tts_resource_id: 'NOVA_AUDIO_AGENT_DOUBAO_TTS_RESOURCE_ID',
  doubao_tts_voice: 'NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE',
  doubao_tts_output_sample_rate: 'NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE',
  volcengine_vad_threshold: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD',
  volcengine_vad_pre_roll_ms: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS',
  volcengine_vad_min_speech_ms: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS',
  volcengine_vad_silence_end_ms: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS',
  volcengine_vad_speech_pad_ms: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS',
  volcengine_vad_max_utterance_ms: 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS',
}
const keyValues: Readonly<Record<string, string>> = {
  ark: 'fixture-ark-key', asr_dedicated: 'fixture-asr-key', tts_fallback: 'fixture-tts-key',
}
const keyLabels = new Map(Object.entries(keyValues).map(([label, value]) => [value, label]))
const secretFields = new Set(['ark_api_key', 'doubao_asr_api_key', 'doubao_bigmodel_api_key'])

function environmentFor(raw: Record<string, unknown>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
    NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark',
  }
  for (const [field, rawValue] of Object.entries(raw)) {
    const variable = settingEnvironment[field]!
    let value = String(rawValue)
    if (secretFields.has(field)) {
      for (const [label, secret] of Object.entries(keyValues)) value = value.replace(label, secret)
    }
    environment[variable] = value
  }
  return environment
}

function normalizeConfig(config: VolcengineRealtimeConfig): Record<string, unknown> {
  return {
    ark_base_url: config.arkBaseUrl,
    ark_model: config.arkModel,
    ark_support_model: config.arkSupportModel,
    ark_api_key: keyLabels.get(config.arkApiKey),
    asr_endpoint: config.asrEndpoint,
    asr_resource_id: config.asrResourceId,
    asr_api_key: keyLabels.get(config.asrApiKey),
    asr_chunk_ms: config.asrChunkMs,
    tts_endpoint: config.ttsEndpoint,
    tts_resource_id: config.ttsResourceId,
    tts_voice: config.ttsVoice,
    tts_api_key: keyLabels.get(config.ttsApiKey),
    tts_output_sample_rate: config.ttsOutputSampleRate,
    vad_threshold: config.vadThreshold,
    vad_pre_roll_ms: config.vadPreRollMs,
    vad_min_speech_ms: config.vadMinSpeechMs,
    vad_silence_end_ms: config.vadSilenceEndMs,
    vad_speech_pad_ms: config.vadSpeechPadMs,
    vad_max_utterance_ms: config.vadMaxUtteranceMs,
  }
}

function safeConfig(case_: FixtureCase): unknown {
  try {
    const fixtureSettings = case_.settings as Record<string, unknown>
    const loaded = loadSettings(environmentFor(fixtureSettings))
    const arkModel = fixtureSettings.volcengine_ark_model
    const arkSupportModel = fixtureSettings.volcengine_ark_support_model
    const settings: Settings = {
      ...loaded,
      ...(typeof arkModel === 'string' ? {volcengine_ark_model: arkModel} : {}),
      ...(typeof arkSupportModel === 'string'
        ? {volcengine_ark_support_model: arkSupportModel}
        : {}),
    }
    if (case_.action === 'load') return {ok: true}
    return {ok: true, config: normalizeConfig(requireVolcengineRealtime(settings))}
  } catch (error) {
    if (error instanceof ConfigurationError && error.message.startsWith('invalid configuration: ')) {
      return {
        ok: false,
        error: 'ValidationError',
        fields: error.message.slice('invalid configuration: '.length).split(', ')
          .map(field => field.startsWith('NOVA_AUDIO_AGENT_')
            ? field.slice('NOVA_AUDIO_AGENT_'.length)
            : field),
      }
    }
    return {ok: false, error: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error)}
  }
}

function readInt32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset)
}
function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

test('Volcengine config resolution matches the Python-exported golden', () => {
  const produced = Object.fromEntries(fixture.config.map(case_ => [case_.id, safeConfig(case_)]))
  assert.equal(canonicalJson(produced), canonicalJson(expected.config))
})

test('ASR encoding and decoding match the Python-exported golden', () => {
  const protocol = new DoubaoAsrProtocol()
  const encoded: Record<string, unknown> = {}
  for (const case_ of fixture.asr_encode) {
    const wire = case_.kind === 'full'
      ? protocol.fullRequest({sequence: case_.sequence as number, sampleRate: 16_000,
        userId: 'fixture-user-id'})
      : protocol.audio({sequence: case_.sequence as number,
        audio: volcengineInputPcm(Buffer.from(case_.pcm_b64 as string, 'base64')),
        final: case_.final as boolean})
    const size = readUint32(wire, 8)
    const payload = Buffer.from(wire.subarray(12, 12 + size))
    const plain = (awaitImportGunzip(payload))
    const normalizedPayload: unknown = case_.kind === 'full'
      ? JSON.parse(plain.toString('utf8')) as unknown
      : plain.toString('base64')
    encoded[case_.id] = {
      header: [...wire.subarray(0, 4)], sequence: readInt32(wire, 4),
      payload_size_matches: size === wire.byteLength - 12,
      payload: normalizedPayload,
    }
  }
  const decoded: Record<string, unknown> = {}
  for (const [id, row] of Object.entries(expected.asr_decode)) {
    try {
      decoded[id] = {frame_b64: row.frame_b64,
        result: protocol.decode(Buffer.from(row.frame_b64, 'base64'))}
    } catch (error) {
      decoded[id] = {frame_b64: row.frame_b64,
        result: {error: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error)}}
    }
  }
  assert.equal(canonicalJson(encoded), canonicalJson(expected.asr_encode))
  assert.equal(canonicalJson(decoded), canonicalJson(expected.asr_decode))
})

test('ASR audio revalidates the provider-neutral PCM byte cap', () => {
  const protocol = new DoubaoAsrProtocol()
  assert.doesNotThrow(() => protocol.audio({
    sequence: 1,
    audio: volcengineInputPcm(new Uint8Array(MAX_REALTIME_PCM_BYTES)),
    final: false,
  }))
  assert.throws(() => protocol.audio({
    sequence: 1,
    audio: {
      format: {encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1},
      pcm: new Uint8Array(MAX_REALTIME_PCM_BYTES + 2),
    },
    final: false,
  }), DoubaoAsrError)
})

function awaitImportGunzip(payload: Uint8Array): Buffer {
  // zlib is sync by design in this pure codec test; this helper keeps parsing visible at the callsite.
  return Buffer.from(requireGunzip(payload))
}
import { gunzipSync as requireGunzip } from 'node:zlib'

function normalizeMessage(message: VolcMessage): Record<string, unknown> {
  return {
    message_type: message.messageType,
    event: message.event,
    payload_b64: Buffer.from(message.payload).toString('base64'),
    session_id: message.sessionId,
    connect_id: message.connectId,
    sequence: message.sequence,
    error_code: message.errorCode,
  }
}

test('shared TTS frames and text chunks match the Python-exported golden', () => {
  const codec: Record<string, unknown> = {}
  for (const case_ of fixture.tts_codec) {
    let wire: Uint8Array
    if (case_.action === 'marshal-roundtrip') {
      wire = new VolcMessage({
        messageType: case_.message_type as MessageType,
        event: case_.event as EventType,
        payload: Buffer.from(case_.payload_b64 as string, 'base64'),
        sessionId: (case_.session_id as string | undefined) ?? null,
        connectId: (case_.connect_id as string | undefined) ?? null,
      }).marshal()
    } else {
      wire = Buffer.from(expected.tts_codec[case_.id]!.frame_b64, 'base64')
    }
    try {
      codec[case_.id] = {frame_b64: Buffer.from(wire).toString('base64'),
        result: normalizeMessage(VolcMessage.unmarshal(wire))}
    } catch (error) {
      codec[case_.id] = {frame_b64: Buffer.from(wire).toString('base64'),
        result: {error: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error)}}
    }
  }
  const chunks = Object.fromEntries(fixture.text_chunker.map(case_ => {
    const options = {
      ...(case_.soft_limit === undefined ? {} : {softLimit: case_.soft_limit as number}),
      ...(case_.hard_limit === undefined ? {} : {hardLimit: case_.hard_limit as number}),
    }
    const chunker = new TextChunker(options)
    return [case_.id, {push: (case_.push as string[]).map(delta => chunker.push(delta)),
      finish: case_.finish === true ? chunker.finish() : []}]
  }))
  assert.equal(canonicalJson(codec), canonicalJson(expected.tts_codec))
  assert.equal(canonicalJson(chunks), canonicalJson(expected.text_chunker))
})

test('ASR decoder enforces bounded inflation, strict JSON, redaction, and ownership', () => {
  const protocol = new DoubaoAsrProtocol()
  const oversizedJson = Buffer.from(JSON.stringify({text: 'a'.repeat(MAX_VOLCENGINE_JSON_BYTES)}))
  const compressed = gzipSync(oversizedJson)
  const frame = Buffer.alloc(12 + compressed.byteLength)
  frame.set([0x11, 0x91, 0x11, 0], 0)
  new DataView(frame.buffer, frame.byteOffset).setInt32(4, 1)
  new DataView(frame.buffer, frame.byteOffset).setUint32(8, compressed.byteLength)
  frame.set(compressed, 12)
  assert.throws(() => protocol.decode(frame), DoubaoAsrError)

  const invalidJson = Buffer.from('{"text":NaN}')
  const raw = Buffer.alloc(12 + invalidJson.byteLength)
  raw.set([0x11, 0x91, 0x10, 0], 0)
  new DataView(raw.buffer, raw.byteOffset).setInt32(4, 1)
  new DataView(raw.buffer, raw.byteOffset).setUint32(8, invalidJson.byteLength)
  raw.set(invalidJson, 12)
  assert.throws(() => protocol.decode(raw), error => error instanceof DoubaoAsrError
    && !error.message.includes('NaN'))
})

test('ASR enforces exact JSON and wire bounds plus signed big-endian sequence limits', () => {
  const protocol = new DoubaoAsrProtocol()
  assert.throws(() => protocol.fullRequest({sequence: 0, sampleRate: 16_000, userId: 'user'}))
  assert.throws(() => protocol.fullRequest({sequence: 1, sampleRate: 16_000, userId: '\ud800'}))

  const exactJson = Buffer.from(`{"text":"${'a'.repeat(MAX_VOLCENGINE_JSON_BYTES - 11)}"}`)
  assert.equal(exactJson.byteLength, MAX_VOLCENGINE_JSON_BYTES)
  const exactFrame = Buffer.alloc(12 + exactJson.byteLength)
  exactFrame.set([0x11, 0x91, 0x10, 0], 0)
  new DataView(exactFrame.buffer, exactFrame.byteOffset).setInt32(4, 2_147_483_647)
  new DataView(exactFrame.buffer, exactFrame.byteOffset).setUint32(8, exactJson.byteLength)
  exactFrame.set(exactJson, 12)
  assert.equal(protocol.decode(exactFrame)?.text.length, MAX_VOLCENGINE_JSON_BYTES - 11)

  const overJson = Buffer.concat([exactJson, Buffer.from(' ')])
  const overFrame = Buffer.alloc(12 + overJson.byteLength)
  overFrame.set([0x11, 0x91, 0x10, 0], 0)
  new DataView(overFrame.buffer, overFrame.byteOffset).setInt32(4, 1)
  new DataView(overFrame.buffer, overFrame.byteOffset).setUint32(8, overJson.byteLength)
  overFrame.set(overJson, 12)
  assert.throws(() => protocol.decode(overFrame), DoubaoAsrError)

  const exactWire = new Uint8Array(MAX_VOLCENGINE_WIRE_FRAME_BYTES)
  exactWire.set([0x11, 0x90, 0, 0])
  assert.equal(protocol.decode(exactWire), null)
  const overWire = new Uint8Array(MAX_VOLCENGINE_WIRE_FRAME_BYTES + 1)
  overWire.set([0x11, 0x90, 0, 0])
  assert.throws(() => protocol.decode(overWire), DoubaoAsrError)
})

test('VolcMessage owns payload bytes and rejects malformed UTF-8 and trailing data', () => {
  const caller = new Uint8Array([1, 2])
  const message = new VolcMessage({messageType: MessageType.FULL_CLIENT_REQUEST,
    event: EventType.START_CONNECTION, payload: caller})
  caller[0] = 9
  assert.deepEqual([...message.payload], [1, 2])
  const wire = message.marshal()
  wire[wire.byteLength - 1] = 9
  assert.deepEqual([...message.payload], [1, 2])

  const badSession = Buffer.from([0x11, 0x94, 0, 0, 0, 0, 0, 150, 0, 0, 0, 1, 0xff, 0, 0, 0, 0])
  assert.throws(() => VolcMessage.unmarshal(badSession), VolcProtocolError)
})

test('VolcMessage accepts extended headers and exact frame bounds but rejects over-bound frames', () => {
  const extendedHeader = Uint8Array.from([0x12, 0xb0, 0, 0, 9, 8, 7, 6, 0, 0, 0, 0])
  assert.deepEqual(normalizeMessage(VolcMessage.unmarshal(extendedHeader)), {
    message_type: MessageType.AUDIO_ONLY_SERVER,
    event: null,
    payload_b64: '',
    session_id: null,
    connect_id: null,
    sequence: null,
    error_code: null,
  })

  const exact = new Uint8Array(MAX_VOLCENGINE_WIRE_FRAME_BYTES)
  exact.set([0x11, 0xb0, 0, 0])
  new DataView(exact.buffer).setUint32(4, MAX_VOLCENGINE_WIRE_FRAME_BYTES - 8)
  assert.equal(VolcMessage.unmarshal(exact).payload.byteLength,
    MAX_VOLCENGINE_WIRE_FRAME_BYTES - 8)
  assert.throws(() => VolcMessage.unmarshal(
    new Uint8Array(MAX_VOLCENGINE_WIRE_FRAME_BYTES + 1),
  ), VolcProtocolError)

  assert.throws(() => new VolcMessage({
    messageType: MessageType.FULL_CLIENT_REQUEST,
    event: EventType.START_SESSION,
    sessionId: '\ud800',
  }).marshal(), VolcProtocolError)
})
