import { handoffPolicySchema } from './memory.js'
import { executorManifestSchema } from './ports.js'

export const slowSimManifest = executorManifestSchema.parse({
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

export const fixtureManifestRegistry = [slowSimManifest] as const
