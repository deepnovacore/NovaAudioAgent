import type {ReadableStreamDefaultReader} from 'node:stream/web'
import {z} from 'zod'
import {PersonalMemoryError, type PersonalMemoryRecallResult, type PersonalMemoryResource, type PersonalMemoryRememberTurn, type PersonalMemoryRecallPort, type PersonalMemoryResponseAdaptation} from './personal-memory.js'

const id = z.string().min(1).max(4096)
const text = z.string().min(1).max(40000)
const evidence = z.array(id).max(256)
const adaptationSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  replyPreferences: z.array(z.object({id, text, evidenceIds: evidence}).strict()).max(128),
}).strict()
const hitSchema = z.object({
  memoryId: id, text, evidenceIds: evidence,
  kind: z.enum(['fact', 'experience', 'trait']).optional(),
  subject: z.string().max(40000).optional(), attributedTo: z.string().max(40000).optional(), attribute: z.string().max(40000).optional(),
  emotion: z.string().max(40000).optional(), occurredAt: z.string().max(256).nullable().optional(),
  recordedAt: z.string().max(256).optional(), score: z.number().finite().optional(),
}).strict()
const recallSchema = z.object({
  source: z.literal('personal'), state: z.enum(['ok', 'empty']), scope: z.enum(['recent', 'any']),
  hits: z.array(hitSchema).max(20), contextHits: z.array(hitSchema).max(20).optional(),
  degraded: z.boolean(),
}).strict().refine(result => (result.hits.length + (result.contextHits?.length ?? 0) > 0) === (result.state === 'ok'))
const receiptSchema = z.object({sourceId: id, state: z.enum(['stored', 'deleted'])}).strict()
const turnSchema = z.object({sourceId: id, sessionId: id, sequence: z.number().int().nonnegative(), text,
  occurredAt: z.string().max(256).nullable(), previousAssistantReply: z.string().max(40000).optional()}).strict()

export interface RemotePersonalMemoryOptions {
  readonly url: string
  /** Host credential; never a model argument. */
  readonly token: string
  readonly timeoutMs?: number
}

/** One credential fixes the remote identity. No request can select a different user. */
export class RemotePersonalMemoryResource implements PersonalMemoryResource {
  readonly #url: URL
  readonly #token: string
  readonly #timeoutMs: number
  #lifetime: AbortController | undefined
  #opening: Promise<void> | undefined
  #adaptation: PersonalMemoryResponseAdaptation | undefined

  constructor(options: RemotePersonalMemoryOptions) {
    try {
      const url = new URL(options.url)
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
        || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error()
      if (!options.token || options.token.length > 8192 || /\s/.test(options.token)) throw new Error()
      const timeout = options.timeoutMs ?? 5000
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error()
      this.#url = url
      this.#token = options.token
      this.#timeoutMs = timeout
    } catch {throw new PersonalMemoryError('unavailable')}
  }

  open(): Promise<void> {
    if (this.#opening) return this.#opening
    if (this.#adaptation) return Promise.resolve()
    const lifetime = new AbortController()
    this.#lifetime = lifetime
    const opening = this.#refresh(lifetime).catch(() => {
      if (this.#lifetime === lifetime) {this.#lifetime = undefined; this.#adaptation = undefined}
      lifetime.abort()
      throw new PersonalMemoryError('unavailable')
    }).finally(() => {if (this.#opening === opening) this.#opening = undefined})
    this.#opening = opening
    return opening
  }

  close(): Promise<void> {
    this.#lifetime?.abort()
    this.#lifetime = undefined
    this.#opening = undefined
    this.#adaptation = undefined
    return Promise.resolve()
  }

  readonly responseAdaptation = (): PersonalMemoryResponseAdaptation => {
    this.#ready()
    return this.#adaptation!
  }

  async remember(turn: PersonalMemoryRememberTurn) {
    const lifetime = this.#ready()
    const parsed = turnSchema.safeParse(turn)
    if (!parsed.success) throw new PersonalMemoryError('error')
    const receipt = await this.#request('/v1/remember', receiptSchema, lifetime, parsed.data)
    if (receipt.sourceId !== turn.sourceId) throw new PersonalMemoryError('unavailable')
    await this.#refresh(lifetime)
    return receipt
  }

  async forget(sourceId: string) {
    const lifetime = this.#ready()
    if (!id.safeParse(sourceId).success) throw new PersonalMemoryError('error')
    try {
      const receipt = await this.#request('/v1/forget', receiptSchema, lifetime, {sourceId})
      if (receipt.sourceId !== sourceId || receipt.state !== 'deleted') throw new PersonalMemoryError('unavailable')
      await this.#refresh(lifetime)
      return receipt
    } catch {
      // An uncertain deletion must never leave a deleted preference available from cache.
      if (this.#lifetime === lifetime) await this.close()
      throw new PersonalMemoryError('unavailable')
    }
  }

  readonly recall: PersonalMemoryRecallPort['recall'] = async (query, options = {}) => {
    const lifetime = this.#ready()
    const scope = options.scope ?? 'recent'
    const limit = options.limit ?? 5
    if (!text.safeParse(query).success || !['recent', 'any'].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new PersonalMemoryError('error')
    const result = await this.#request('/v1/recall', recallSchema, lifetime, {query, scope, limit}, options.signal)
    if (result.scope !== scope || result.hits.length > limit || (result.contextHits?.length ?? 0) > limit) throw new PersonalMemoryError('unavailable')
    await this.#refresh(lifetime, options.signal)
    // Empty optional metadata means unavailable; preserve the bridge's nonempty-field contract.
    for (const hit of [...result.hits, ...(result.contextHits ?? [])]) {
      for (const field of ['subject', 'attributedTo', 'attribute', 'emotion', 'occurredAt', 'recordedAt'] as const) {
        if (hit[field] === '') delete hit[field]
      }
    }
    // JSON cannot carry present-but-undefined optional fields.
    return result as PersonalMemoryRecallResult
  }

  #ready(): AbortController {
    if (!this.#lifetime || this.#lifetime.signal.aborted || !this.#adaptation) throw new PersonalMemoryError('unavailable')
    return this.#lifetime
  }

  async #refresh(lifetime: AbortController, signal?: AbortSignal): Promise<void> {
    const snapshot = await this.#request('/v1/preferences', adaptationSchema, lifetime, undefined, signal)
    if (this.#lifetime !== lifetime || lifetime.signal.aborted) throw new PersonalMemoryError('unavailable')
    if (this.#adaptation && snapshot.revision < this.#adaptation.revision) return
    this.#adaptation = Object.freeze({revision: snapshot.revision,
      replyPreferences: Object.freeze(snapshot.replyPreferences.map(preference => Object.freeze({...preference, evidenceIds: Object.freeze(preference.evidenceIds)})))})
  }

  async #request<T>(path: string, schema: z.ZodType<T>, lifetime: AbortController, body?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.#timeoutMs)
    try {
      const response = await fetch(new URL(path, this.#url), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {authorization: `Bearer ${this.#token}`, 'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        redirect: 'error',
        signal: AbortSignal.any([lifetime.signal, timeout.signal, ...(signal ? [signal] : [])]),
      })
      if (!response.ok || !response.body) {await response.body?.cancel(); throw new Error()}
      // Bound bytes before JSON parsing, including chunked or dishonest Content-Length replies.
      const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (!(chunk.value instanceof Uint8Array)) throw new Error()
          size += chunk.value.byteLength
          if (size > 1024 * 1024) {await reader.cancel(); throw new Error()}
          chunks.push(chunk.value)
        }
      } finally {reader.releaseLock()}
      if (this.#lifetime !== lifetime || lifetime.signal.aborted || timeout.signal.aborted || signal?.aborted) throw new Error()
      return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch {throw new PersonalMemoryError('unavailable')}
    finally {clearTimeout(timer)}
  }
}
