import assert from 'node:assert/strict'
import {test} from 'node:test'
import {ConfigurationError} from '../src/config.js'
import {CascadedRealtimeAdapter} from '../src/realtime/cascaded/adapter.js'
import type {
  AsrClient, AsrSession, EndpointingEvent, TtsAudio, TtsClient, TtsSession,
} from '../src/realtime/cascaded/ports.js'
import type {
  CascadedLlmEvent,
  CascadedLlmSession,
} from '../src/realtime/cascaded/llm.js'
import {
  SilenceVolcEndpointing,
  type SilenceVolcEndpointingConfig,
} from '../src/realtime/volcengine/silence-endpointing.js'

type LlmStreamInput = Parameters<CascadedLlmSession['stream']>[0]

const WINDOW_BYTES = 1_024
const silent = pcmWindow(0)
const active = pcmWindow(1_200)
const activationBoundary = pcmWindow(1_147)
const belowActivation = pcmWindow(1_146)
const continuationBoundary = pcmWindow(656)
const belowContinuation = pcmWindow(655)

function config(overrides: Partial<SilenceVolcEndpointingConfig> = {}): SilenceVolcEndpointingConfig {
  return {
    vadPreRollMs: 260,
    vadMinSpeechMs: 250,
    vadSilenceEndMs: 560,
    vadSpeechPadMs: 30,
    vadMaxUtteranceMs: 15_000,
    ...overrides,
  }
}

function pcmWindow(sample: number): Uint8Array {
  const pcm = new Uint8Array(WINDOW_BYTES)
  const view = new DataView(pcm.buffer)
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    view.setInt16(offset, sample, true)
  }
  return pcm
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function repeat(part: Uint8Array, count: number): Uint8Array {
  return concat(...Array.from({length: count}, () => part))
}

async function feedAll(
  endpointing: SilenceVolcEndpointing,
  chunks: readonly Uint8Array[],
  signal = new AbortController().signal,
): Promise<EndpointingEvent[]> {
  const events: EndpointingEvent[] = []
  for (const chunk of chunks) events.push(...await endpointing.feed(chunk, signal))
  return events
}

function pcmEvents(events: readonly EndpointingEvent[]): Uint8Array {
  return concat(...events.flatMap(event => event.kind === 'speech_end' ? [] : [event.pcm]))
}

test('all silence and a seven-window pulse never commit speech', async () => {
  const endpointing = new SilenceVolcEndpointing(config())
  assert.deepEqual(await feedAll(endpointing, [repeat(silent, 64), repeat(silent, 36)]), [])
  assert.deepEqual(await feedAll(endpointing, [repeat(active, 7), repeat(silent, 18)]), [])
})

test('default minimum commits on the eighth window and honors both exact RMS thresholds', async () => {
  const below = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  assert.deepEqual(await feedAll(below, [repeat(belowActivation, 8)]), [])

  const activation = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  const activated = await feedAll(activation, [activationBoundary, repeat(continuationBoundary, 7)])
  assert.equal(activated.length, 1)
  assert.equal(activated[0]?.kind, 'speech_start')
  assert.deepEqual(pcmEvents(activated), concat(activationBoundary, repeat(continuationBoundary, 7)))

  const brokenContinuation = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  assert.deepEqual(await feedAll(
    brokenContinuation,
    [activationBoundary, repeat(continuationBoundary, 6), belowContinuation, repeat(silent, 18)],
  ), [])

  const hysteresisOnly = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  assert.deepEqual(await feedAll(hysteresisOnly, [repeat(continuationBoundary, 8)]), [])
})

test('default silence ends on the eighteenth window with exactly 30 ms of copied pad', async () => {
  const endpointing = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  const start = await endpointing.feed(repeat(active, 8), new AbortController().signal)
  assert.equal(start[0]?.kind, 'speech_start')
  assert.deepEqual(await endpointing.feed(repeat(silent, 17), new AbortController().signal), [])

  const ended = await endpointing.feed(silent, new AbortController().signal)
  assert.deepEqual(ended.map(event => event.kind), ['speech_audio', 'speech_end'])
  assert.equal(ended[0]?.kind === 'speech_audio' ? ended[0].pcm.byteLength : -1, 960)
  assert.deepEqual(ended[1], {kind: 'speech_end', commit: true})
})

test('pre-roll keeps the exact final 4,160 samples and preserves byte order', async () => {
  const endpointing = new SilenceVolcEndpointing(config())
  const history = concat(...Array.from({length: 9}, (_unused, index) => pcmWindow(100 + index)))
  await endpointing.feed(history, new AbortController().signal)
  const expectedPreRoll = history.slice(history.byteLength - 8_320)
  const started = await endpointing.feed(repeat(active, 8), new AbortController().signal)
  assert.equal(started[0]?.kind, 'speech_start')
  assert.deepEqual(pcmEvents(started), concat(expectedPreRoll, repeat(active, 8)))
})

test('custom pad is sample-exact, its remainder becomes pre-roll, and pause replay is ordered once', async () => {
  const endpointing = new SilenceVolcEndpointing(config({
    vadPreRollMs: 64,
    vadMinSpeechMs: 32,
    vadSilenceEndMs: 64,
    vadSpeechPadMs: 45,
    vadMaxUtteranceMs: 1_000,
  }))
  const lowOne = pcmWindow(100)
  const lowTwo = pcmWindow(200)
  assert.deepEqual((await endpointing.feed(active, new AbortController().signal)).map(event => event.kind), [
    'speech_start',
  ])
  assert.deepEqual(await endpointing.feed(lowOne, new AbortController().signal), [])
  const ended = await endpointing.feed(lowTwo, new AbortController().signal)
  assert.equal(ended[0]?.kind === 'speech_audio' ? ended[0].pcm.byteLength : -1, 1_440)
  assert.deepEqual(pcmEvents(ended), concat(lowOne, lowTwo.slice(0, 416)))
  assert.deepEqual(ended[1], {kind: 'speech_end', commit: true})

  const restarted = await endpointing.feed(active, new AbortController().signal)
  assert.deepEqual(pcmEvents(restarted), concat(lowTwo.slice(416), active))

  const pausing = new SilenceVolcEndpointing(config({
    vadPreRollMs: 0,
    vadMinSpeechMs: 32,
    vadSilenceEndMs: 96,
    vadSpeechPadMs: 30,
    vadMaxUtteranceMs: 1_000,
  }))
  await pausing.feed(active, new AbortController().signal)
  assert.deepEqual(await pausing.feed(lowOne, new AbortController().signal), [])
  assert.deepEqual(await pausing.feed(lowTwo, new AbortController().signal), [])
  const resumed = await pausing.feed(active, new AbortController().signal)
  assert.deepEqual(resumed.map(event => event.kind), ['speech_audio', 'speech_audio'])
  assert.deepEqual(pcmEvents(resumed), concat(lowOne, lowTwo, active))
})

test('split even chunks and multi-window feeds preserve every source byte exactly once', async () => {
  const waveform = repeat(active, 8)
  const endpointing = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  const chunks = [waveform.slice(0, 2), waveform.slice(2, 602), waveform.slice(602, 4_700),
    waveform.slice(4_700)]
  const events = await feedAll(endpointing, chunks)
  assert.deepEqual(events.map(event => event.kind), ['speech_start'])
  assert.deepEqual(pcmEvents(events), waveform)

  const oneFeed = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  const oneFeedEvents = await oneFeed.feed(waveform, new AbortController().signal)
  assert.deepEqual(oneFeedEvents.map(event => event.kind), ['speech_start'])
  assert.deepEqual(pcmEvents(oneFeedEvents), waveform)
})

test('invalid input rejects before mutation and the per-feed limit remains 64 KiB', async () => {
  const endpointing = new SilenceVolcEndpointing(config({vadPreRollMs: 32, vadMinSpeechMs: 32}))
  await endpointing.feed(pcmWindow(100), new AbortController().signal)
  await assert.rejects(async () => endpointing.feed(new Uint8Array([1, 2, 3]),
    new AbortController().signal))
  await assert.rejects(async () => endpointing.feed(new Uint8Array(65_538),
    new AbortController().signal))
  assert.deepEqual(await endpointing.feed(new Uint8Array(65_536),
    new AbortController().signal), [])
  const started = await endpointing.feed(active, new AbortController().signal)
  assert.deepEqual(pcmEvents(started), concat(new Uint8Array(WINDOW_BYTES), active))
})

test('the default 15 s cap ends on window 469 and later bytes form a second utterance', async () => {
  const endpointing = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  const events: EndpointingEvent[] = []
  for (let remaining = 469; remaining > 0;) {
    const count = Math.min(64, remaining)
    events.push(...await endpointing.feed(repeat(active, count), new AbortController().signal))
    remaining -= count
  }
  assert.equal(events.filter(event => event.kind === 'speech_start').length, 1)
  assert.equal(events.filter(event => event.kind === 'speech_end').length, 1)
  assert.deepEqual(events.at(-1), {kind: 'speech_end', commit: true})
  assert.equal(pcmEvents(events).byteLength, 469 * WINDOW_BYTES)

  const second = await endpointing.feed(repeat(active, 8), new AbortController().signal)
  assert.deepEqual(second.map(event => event.kind), ['speech_start'])
})

test('two adjacent utterances and custom non-window timings use sample-count boundaries', async () => {
  const endpointing = new SilenceVolcEndpointing(config({
    vadPreRollMs: 0,
    vadMinSpeechMs: 33,
    vadSilenceEndMs: 33,
    vadSpeechPadMs: 1,
    vadMaxUtteranceMs: 97,
  }))
  const firstStart = await endpointing.feed(active, new AbortController().signal)
  assert.deepEqual(firstStart, [])
  const events = await endpointing.feed(concat(active, silent, silent, active, active, silent, silent),
    new AbortController().signal)
  assert.deepEqual(events.map(event => event.kind), [
    'speech_start', 'speech_audio', 'speech_end', 'speech_start', 'speech_audio', 'speech_end',
  ])
  assert.equal(events[1]?.kind === 'speech_audio' ? events[1].pcm.byteLength : -1, 32)
  assert.equal(events[4]?.kind === 'speech_audio' ? events[4].pcm.byteLength : -1, 32)
})

test('absolute timing ceilings are inclusive and each overage names only its environment field', () => {
  assert.doesNotThrow(() => new SilenceVolcEndpointing(config({
    vadPreRollMs: 2_000,
    vadMinSpeechMs: 10_000,
    vadSilenceEndMs: 10_000,
    vadSpeechPadMs: 2_000,
    vadMaxUtteranceMs: 60_000,
  })))
  const cases: readonly [keyof SilenceVolcEndpointingConfig, number, string][] = [
    ['vadPreRollMs', 2_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS'],
    ['vadMinSpeechMs', 10_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS'],
    ['vadSilenceEndMs', 10_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS'],
    ['vadSpeechPadMs', 2_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS'],
    ['vadMaxUtteranceMs', 60_001, 'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS'],
  ]
  for (const [field, value, variable] of cases) {
    assert.throws(() => new SilenceVolcEndpointing(config({[field]: value})), error => {
      assert.ok(error instanceof ConfigurationError)
      assert.equal(error.message, `invalid configuration: ${variable}`)
      for (const other of cases) {
        const otherVariable = other[2]
        if (otherVariable !== variable) assert.equal(error.message.includes(otherVariable), false)
      }
      return true
    })
  }
})

test('reset clears partial frames and candidates while keeping the instance reusable', async () => {
  const endpointing = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  await endpointing.feed(active.slice(0, 512), new AbortController().signal)
  await endpointing.reset()
  assert.deepEqual(await endpointing.feed(repeat(active, 7), new AbortController().signal), [])
  assert.deepEqual(await endpointing.feed(active.slice(0, 512),
    new AbortController().signal), [])
  const started = await endpointing.feed(active.slice(512), new AbortController().signal)
  assert.deepEqual(started.map(event => event.kind), ['speech_start'])
  assert.equal(pcmEvents(started).byteLength, 8 * WINDOW_BYTES)
})

test('concurrent feeds serialize copied caller bytes and one aborted feed cannot poison the next', async () => {
  const endpointing = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  const firstCaller = repeat(active, 4)
  const secondCaller = repeat(active, 4)
  const expected = concat(firstCaller.slice(), secondCaller.slice())
  const first = endpointing.feed(firstCaller, new AbortController().signal)
  const second = endpointing.feed(secondCaller, new AbortController().signal)
  firstCaller.fill(0)
  secondCaller.fill(0)
  assert.deepEqual(await first, [])
  const started = await second
  assert.deepEqual(pcmEvents(started), expected)

  await endpointing.reset()
  const aborted = new AbortController()
  const cancelled = endpointing.feed(active, aborted.signal)
  const following = endpointing.feed(repeat(active, 8), new AbortController().signal)
  aborted.abort()
  await assert.rejects(cancelled, {name: 'AbortError'})
  assert.deepEqual((await following).map(event => event.kind), ['speech_start'])
})

test('event bytes are independently owned, idle retention stays at pre-roll, and close is terminal', async () => {
  const endpointing = new SilenceVolcEndpointing(config({vadMinSpeechMs: 32}))
  for (let count = 0; count < 40; count += 1) {
    await endpointing.feed(new Uint8Array(65_536), new AbortController().signal)
  }
  const caller = active.slice()
  const expected = concat(new Uint8Array(8_320), caller.slice())
  const pending = endpointing.feed(caller, new AbortController().signal)
  caller.fill(0)
  const started = await pending
  assert.deepEqual(pcmEvents(started), expected)
  assert.notEqual(started[0]?.kind === 'speech_start' ? started[0].pcm : null, caller)

  if (started[0]?.kind === 'speech_start') started[0].pcm.fill(255)
  await endpointing.reset()
  const fresh = await endpointing.feed(active, new AbortController().signal)
  assert.deepEqual(pcmEvents(fresh), active)

  await endpointing.close()
  await endpointing.close()
  await assert.rejects(async () => endpointing.feed(active, new AbortController().signal))
})

class RecordingAsrSession implements AsrSession {
  append(): Promise<void> { return Promise.resolve() }
  finish(): Promise<void> { return Promise.resolve() }
  close(): Promise<void> { return Promise.resolve() }
  async *events(signal?: AbortSignal): AsyncIterable<never> {
    if (signal !== undefined && !signal.aborted) {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}))
    }
  }
}

class RecordingAsrClient implements AsrClient {
  opens = 0
  open(): Promise<AsrSession> {
    this.opens += 1
    return Promise.resolve(new RecordingAsrSession())
  }
}

class UnusedTtsSession implements TtsSession {
  cancel(): Promise<void> { return Promise.resolve() }
  close(): Promise<void> { return Promise.resolve() }
  finish(): Promise<void> { return Promise.resolve() }
  sendText(): Promise<void> { return Promise.resolve() }
  async *events(): AsyncIterable<TtsAudio> { await Promise.resolve(); return }
}

const unusedTts: TtsClient = {open: () => Promise.resolve(new UnusedTtsSession())}

class EmptyLlm implements CascadedLlmSession {
  async *stream(input: LlmStreamInput): AsyncIterable<CascadedLlmEvent> {
    void input
    await Promise.resolve()
    return
  }
  close(): Promise<void> { return Promise.resolve() }
}

test('the real cascaded adapter opens ASR zero times for silence and once for committed speech', async () => {
  const asr = new RecordingAsrClient()
  const endpointing = new SilenceVolcEndpointing(config({vadPreRollMs: 0}))
  const adapter = new CascadedRealtimeAdapter({
    endpointing,
    asr,
    tts: unusedTts,
    llm: new EmptyLlm(),
    idFactory: (() => {
      let id = 0
      return () => `silence-endpointing-id-${++id}`
    })(),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  try {
    await adapter.sendAudio(repeat(silent, 18), new AbortController().signal)
    assert.equal(asr.opens, 0)
    await adapter.sendAudio(repeat(active, 8), new AbortController().signal)
    assert.equal(asr.opens, 1)
  } finally {
    await adapter.close()
    await endpointing.close()
  }
})
