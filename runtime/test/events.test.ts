import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EVENT_KINDS,
  EventQueue,
  eventInputSchema,
  eventRecordSchema,
} from '../src/events.js'

test('event registry covers the Python spine table in the same order', () => {
  assert.deepEqual(EVENT_KINDS, [
    'user_input',
    'handoff',
    'progress',
    'observation',
    'deadline',
    'compress',
    'model_done',
    'compress_done',
    'speak_start',
    'speak_end',
    'assistant_spoken',
  ])
})

test('queue stamps timestamps and globally monotone sequences', () => {
  const queue = new EventQueue()
  const first = queue.push({kind: 'user_input', payload: {text: 'hello'}}, 1.5)
  const second = queue.push({kind: 'compress', payload: {channel: 'conversation'}}, 1.5)
  assert.deepEqual([first.ts, first.seq], [1.5, 1])
  assert.deepEqual([second.ts, second.seq], [1.5, 2])
})

test('deadline is processed last at the same virtual instant', () => {
  const queue = new EventQueue()
  queue.push({kind: 'deadline', payload: {delegate_id: 'd-1'}}, 5)
  queue.push({
    kind: 'handoff',
    payload: {
      channel: 'slow_sim',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {brightness: 30},
      refs: ['slow_sim:1'],
    },
  }, 5)

  assert.equal(queue.popReady(5)?.kind, 'handoff')
  assert.equal(queue.popReady(5)?.kind, 'deadline')
})

test('non-deadline events retain FIFO order at the same instant', () => {
  const queue = new EventQueue()
  queue.push({kind: 'compress', payload: {channel: 'conversation'}}, 2)
  queue.push({kind: 'user_input', payload: {text: 'next'}}, 2)
  queue.push({kind: 'model_done', payload: {slot: 'fast', job_id: 'j-1'}}, 2)
  assert.deepEqual(
    [queue.popReady(2)?.kind, queue.popReady(2)?.kind, queue.popReady(2)?.kind],
    ['compress', 'user_input', 'model_done'],
  )
})

test('event contracts reject extra fields and non-finite timestamps', () => {
  assert.throws(() => eventRecordSchema.parse({
    seq: 1,
    ts: Number.NaN,
    kind: 'deadline',
    payload: {delegate_id: 'd-1'},
  }))
  assert.throws(() => eventRecordSchema.parse({
    seq: 1,
    ts: 0,
    kind: 'deadline',
    payload: {delegate_id: 'd-1', model_owned_deadline: true},
  }))
})

test('event payloads normalize empty collections exactly like Python records', () => {
  assert.deepEqual(
    eventInputSchema.parse({
      kind: 'user_input',
      payload: {text: 'hello', media_refs: []},
    }),
    {kind: 'user_input', payload: {text: 'hello'}},
  )
  assert.deepEqual(
    eventInputSchema.parse({
      kind: 'observation',
      payload: {
        channel: 'slow_sim',
        delegate_id: 'd-1',
        op: 'watch',
        origin_ref: 'conversation:1',
        trust: 'trusted_system',
        content: {state: 'working'},
      },
    }).payload,
    {
      channel: 'slow_sim',
      delegate_id: 'd-1',
      op: 'watch',
      origin_ref: 'conversation:1',
      trust: 'trusted_system',
      content: {state: 'working'},
      refs: [],
    },
  )
})
