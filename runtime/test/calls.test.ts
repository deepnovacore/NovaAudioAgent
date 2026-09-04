import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifySurrogateVerdict, runSurrogateCall } from '../src/calls.js'
import type { Affordance, ContextView } from '../src/context-view.js'
import { wakeReasonSchema } from '../src/slots.js'

const view: ContextView = {
  channels: [],
  in_flight: [],
  affordances: [
    {source: 'suggestion', ref: 's-1', content: {kind: 'notify'}, conclusive: null},
    {source: 'suggestion', ref: 's-2', content: {kind: 'question'}, conclusive: null},
  ],
  floor: 'idle',
  now: 1,
  trigger_kind: 'user_input',
}

const reason = wakeReasonSchema.parse({kind: 'user_input', priority: 100})

test('the Surrogate records the suggestion table it actually saw', async () => {
  const record = await runSurrogateCall({
    watch: () => Promise.resolve({
      speak: true, suggestion_id: 's-2', progress_class: 'milestone', reason: '因为',
    }),
  }, {view, reason, trigger: {
    suggestion_id: 's-2', delegate_id: 'd-1', channel: 'codex', memory_ref: 'codex:3',
  }})

  // Only suggestion affordances, in view order, and no non-suggestion refs.
  assert.deepEqual(record.offered, ['s-1', 's-2'])
  assert.equal(record.output.suggestion_id, 's-2')
  assert.equal(record.trigger?.delegate_id, 'd-1')
  assert.equal(record.reason, reason)
})

test('the Surrogate table is captured before the call, not after it', async () => {
  // A suggestion that rearms mid-flight must not appear in `offered`, otherwise a
  // selection the Surrogate never saw would pass the core check.
  const affordances: Affordance[] = [...view.affordances]
  const mutable: ContextView = {...view, affordances}
  const record = await runSurrogateCall({
    watch: () => {
      affordances.push({
        source: 'suggestion', ref: 's-3-arrived-late', content: {}, conclusive: null,
      })
      return Promise.resolve({speak: false, suggestion_id: null, progress_class: null, reason: 'no'})
    },
  }, {view: mutable, reason})

  assert.deepEqual(record.offered, ['s-1', 's-2'])
  assert.ok(!record.offered.includes('s-3-arrived-late'))
})

test('Surrogate verdict attribution distinguishes silence from invalid and selected output', () => {
  const base = {reason, trigger: null} as const
  assert.equal(classifySurrogateVerdict({
    ...base,
    offered: ['s-1'],
    output: {speak: false, suggestion_id: null, progress_class: null, reason: 'routine'},
  }), 'silent')
  assert.equal(classifySurrogateVerdict({
    ...base,
    offered: ['s-1'],
    output: {speak: true, suggestion_id: null, progress_class: null, reason: 'missing'},
  }), 'missing_selection')
  assert.equal(classifySurrogateVerdict({
    ...base,
    offered: ['s-1'],
    output: {speak: true, suggestion_id: 's-2', progress_class: null, reason: 'wrong'},
  }), 'selection_not_offered')
  assert.equal(classifySurrogateVerdict({
    ...base,
    offered: ['s-1'],
    output: {speak: true, suggestion_id: 's-1', progress_class: null, reason: 'selected'},
  }), 'selected')
})
