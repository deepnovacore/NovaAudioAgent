/**
 * Executor manifests used only by the committed fixtures.
 *
 * These are NOT the ported simulators: `sims.ts` carries those, with the ops the oracle's
 * `executors/sims.py` declares. This manifest exists to give the fixture scenarios the
 * exact ops they were exported against, including a sensitive-parameter op that the real
 * simulators do not have. Keeping the two apart is why the names differ.
 */

import { handoffPolicySchema } from './memory.js'
import { executorManifestSchema } from './ports.js'

export const fixtureSlowSimManifest = executorManifestSchema.parse({
  name: 'slow_sim',
  policy: handoffPolicySchema.parse({
    channel: 'slow_sim',
    priority: 50,
    wake: 'fast',
    typical_latency: 5,
    compress_watermark: 8,
    progress_via_surrogate: true,
  }),
  ops: [{
    name: 'set_light',
    description: 'set light brightness',
    params: {},
    deadline_budget: 5,
  }, {
    name: 'set_credential',
    description: 'exercise sensitive parameter handling',
    params: {
      type: 'object',
      properties: {
        mode: {type: 'string'},
        token: {type: 'string'},
      },
      required: ['mode', 'token'],
    },
    sensitive_params: ['token'],
    deadline_budget: 5,
  }],
})

export const fixtureManifestRegistry = [fixtureSlowSimManifest] as const
