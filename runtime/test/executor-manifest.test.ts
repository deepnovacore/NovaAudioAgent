import assert from 'node:assert/strict'
import {test} from 'node:test'

import {fixtureSlowSimManifest} from '../src/sim.js'
import {executorManifestSchema} from '../src/ports.js'
import {handoffPolicySchema} from '../src/memory.js'

test('executor manifests require display_name', () => {
  assert.throws(() => executorManifestSchema.parse({
    name: 'demo',
    policy: handoffPolicySchema.parse({
      channel: 'demo', priority: 50, wake: 'fast', typical_latency: 1, compress_watermark: 1,
    }),
    ops: [{
      name: 'peek',
      description: 'peek',
      params: {type: 'object', properties: {}},
      readonly: true,
      deadline_budget: 1,
    }],
  }))
})

test('fixture slow sim manifest carries a display_name', () => {
  assert.equal(fixtureSlowSimManifest.display_name, 'Slow Sim')
})
