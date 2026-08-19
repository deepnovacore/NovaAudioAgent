import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_REALTIME_TEXT,
  MAX_REALTIME_PCM_BYTES,
  ItemDeliveryUncertainError,
  delegationAcknowledgement,
  hostContextItemSchema,
  hostFact,
  hostResponseIntentSchema,
  realtimeProviderEventSchema,
  toolResult,
} from '../src/realtime/protocol.js'

const toolOutput = hostContextItemSchema.parse({
  kind: 'tool_output',
  host_item_id: 'host-1',
  event_id: 'event-1',
  call_id: 'call-1',
  content: '{"ok":true}',
})

test('host context items enforce Python conditional fields and Unicode character bounds', () => {
  const emojiContent = '🙂'.repeat(MAX_REALTIME_TEXT)
  const item = hostContextItemSchema.parse({
    kind: 'final',
    host_item_id: 'host-emoji',
    event_id: 'event-emoji',
    content: emojiContent,
  })
  assert.equal([...item.content].length, MAX_REALTIME_TEXT)
  assert.equal(item.call_id, null)

  assert.throws(() => hostContextItemSchema.parse({
    kind: 'tool_output',
    host_item_id: 'host-1',
    event_id: 'event-1',
    content: 'missing call identity',
  }), /call_id/u)
  assert.throws(() => hostContextItemSchema.parse({
    kind: 'progress',
    host_item_id: 'host-1',
    event_id: 'event-1',
    call_id: 'not-allowed',
    content: 'working',
  }), /call_id/u)
  assert.throws(() => hostContextItemSchema.parse({
    kind: 'final',
    host_item_id: 'host-long',
    event_id: 'event-long',
    content: `${emojiContent}🙂`,
  }), /exceeds/u)

  for (const whitespace of ['\u0085', '\u001c']) {
    assert.throws(() => hostContextItemSchema.parse({
      kind: 'final',
      host_item_id: whitespace,
      event_id: 'event-whitespace',
      content: 'content',
    }), /identifier/u)
  }
  assert.equal(hostContextItemSchema.parse({
    kind: 'final',
    host_item_id: '\ufeff',
    event_id: 'event-feff',
    content: '\ufeff',
  }).host_item_id, '\ufeff')
})

test('host response intents retain only valid item and continuation combinations', () => {
  const progress = hostContextItemSchema.parse({
    kind: 'progress',
    host_item_id: 'host-progress',
    event_id: 'event-progress',
    content: 'working',
  })
  assert.equal(hostFact(progress).kind, 'host_fact')
  assert.equal(toolResult(toolOutput).kind, 'tool_result')
  assert.deepEqual(delegationAcknowledgement(toolOutput, 'run tests', true), {
    kind: 'delegation_acknowledgement',
    item: toolOutput,
    task_summary: 'run tests',
    origin_spoken: true,
  })

  assert.throws(() => toolResult(progress), /tool output/u)
  assert.throws(() => hostFact(toolOutput), /host fact/u)
  assert.throws(() => hostResponseIntentSchema.parse({
    kind: 'host_fact',
    item: progress,
    origin_spoken: true,
  }), /origin_spoken/u)
})

test('normalized provider events reject malformed identities, text, JSON and PCM', () => {
  assert.deepEqual(realtimeProviderEventSchema.parse({
    kind: 'provider_error',
    session_epoch: 1,
    code: 'disconnected',
  }), {
    kind: 'provider_error',
    session_epoch: 1,
    code: 'disconnected',
    recoverable: false,
  })
  assert.throws(() => realtimeProviderEventSchema.parse({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'response-1',
    pcm: new Uint8Array([0]),
  }), /PCM16/u)
  // Inbound audio is bounded by alignment, not by size: `ResponseAudioDelta.__post_init__`
  // accepts any aligned length, and the playback registry splits an oversized delta into
  // MAX_PLAYBACK_FRAME_BYTES frames. Refusing it here would make that split unreachable from the
  // provider path and would narrow the accepted domain on one leg only.
  assert.doesNotThrow(() => realtimeProviderEventSchema.parse({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'response-1',
    pcm: new Uint8Array(MAX_REALTIME_PCM_BYTES + 2),
  }))
  assert.throws(() => realtimeProviderEventSchema.parse({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'item-1',
    name: 'run',
    arguments: {bad: Number.NaN},
  }))
  assert.throws(() => realtimeProviderEventSchema.parse({
    kind: 'response_terminal',
    session_epoch: 0,
    response_id: 'response-1',
    status: 'completed',
    reason: 'completed',
  }))
})

test('uncertain delivery preserves the Python correlation surface without payload details', () => {
  const error = new ItemDeliveryUncertainError({
    session_epoch: 2,
    host_item_id: 'host-1',
    provider_item_id: 'provider-1',
    item_kind: 'progress',
  })

  assert.equal(error.message, 'host item confirmation timed out; delivery is uncertain')
  assert.equal(error.session_epoch, 2)
  assert.equal(error.host_item_id, 'host-1')
  assert.equal(error.provider_item_id, 'provider-1')
  assert.equal(error.item_kind, 'progress')
})
