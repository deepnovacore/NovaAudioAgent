import {z} from 'zod'
import type {ModelGateway} from '../../model/model-gateway.js'

/** One bounded JSON completion for an intake slot; callers validate the returned value. */
export async function completeJson(gateway: ModelGateway, model: string, system: string, schema: z.ZodType,
  input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  const result = await gateway.complete({
    model, system: `${system}\nSchema: ${JSON.stringify(z.toJSONSchema(schema))}`,
    prompt: JSON.stringify(input), jsonSchema: {type: 'object'}, reasoning: 'disabled', signal,
  })
  signal.throwIfAborted()
  if (result.text.length > 32000) throw new TypeError('intake_output_too_large')
  return JSON.parse(result.text) as unknown
}
