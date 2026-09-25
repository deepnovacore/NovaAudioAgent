import {z} from 'zod'

/** Plain HTTP is only allowed on loopback; remote servers use TLS or a tunnel. */
export const servingEndpoint = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  } catch { return false }
}, 'serving endpoint must use HTTPS or loopback HTTP')
const connection = z.object({baseUrl: servingEndpoint, model: z.string().min(1).max(256), apiKey: z.string().min(1).max(4096).default('local')}).strict()
export const localServingSchema = z.object({
  llm: connection,
  endpointing: z.object({maxSilenceMs:z.number().int().min(300).max(2500).default(1200),minSpeechMs:z.number().int().min(1).max(1000).default(100),minSilenceMs:z.number().int().min(100).max(2000).default(250)}).strict().default({maxSilenceMs:1200,minSpeechMs:100,minSilenceMs:250}),
  asr: z.object({endpoint: servingEndpoint, apiKey: z.string().max(4096).default('')} ).strict(),
  tts: z.object({endpoint: servingEndpoint, instruction: z.string().max(2000).default('自然、清晰的中文语音'), apiKey: z.string().max(4096).default('')} ).strict(),
  extraction: connection.optional(),
  embedding: connection.extend({dimensions:z.number().int().min(1).max(4096).default(1024)}),
}).strict()
export type LocalServing = z.infer<typeof localServingSchema>
