import {Worker} from 'node:worker_threads'
import {z} from 'zod'
import {memoryChannelSnapshotSchema, memoryItemSchema} from '../memory.js'

export const BLACKBOARD_BATCH_ITEMS = 256
export const BLACKBOARD_BATCH_BYTES = 4 * 1024 * 1024

const integer = z.number().int().nonnegative()
const identifier = z.string().min(1).max(512).refine(value => !value.includes('\0'))
export const blackboardOptionsSchema = z.object({
  path: z.string().min(1), ownerId: identifier, conversationId: identifier,
  channels: z.array(identifier).min(1).max(128).refine(values => new Set(values).size === values.length),
  retention: z.object({
    ttlMs: z.number().int().positive().default(7 * 24 * 60 * 60 * 1000),
    maxItems: z.number().int().positive().max(10_000).default(1000),
    maxBytes: z.number().int().positive().max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  }).strict().prefault({}),
}).strict()
export type BlackboardOptions = z.input<typeof blackboardOptionsSchema>

export const blackboardBatchSchema = z.object({
  generation: integer, revision: z.number().int().positive(),
  mutations: z.array(z.discriminatedUnion('kind', [
    z.object({kind: z.literal('append'), item: memoryItemSchema}).strict(),
    z.object({kind: z.literal('summary'), channel: identifier, text: z.string().min(1).max(65_536),
      throughSequence: z.number().int().positive(), retentionRevision: integer}).strict(),
    z.object({kind: z.literal('clear')}).strict(),
  ])).max(BLACKBOARD_BATCH_ITEMS),
}).strict().refine(batch => !batch.mutations.some(mutation => mutation.kind === 'clear') || batch.mutations.length === 1)
export type BlackboardBatch = z.infer<typeof blackboardBatchSchema>

export const blackboardReceiptSchema = z.object({
  generation: integer, revision: integer,
  retention: z.array(z.object({channel: identifier, retentionRevision: integer,
    prunedThroughSequence: integer}).strict()).max(128),
}).strict()
export type BlackboardReceipt = z.infer<typeof blackboardReceiptSchema>

export const blackboardSnapshotSchema = z.object({
  generation: integer, revision: integer,
  channels: z.array(memoryChannelSnapshotSchema).max(128),
}).strict()
export type BlackboardSnapshot = z.infer<typeof blackboardSnapshotSchema>

export const blackboardErrorCodeSchema = z.enum([
  'closed', 'busy', 'unavailable', 'invalid_input', 'owner', 'schema', 'revision_conflict',
  'revision_gap', 'generation', 'sequence', 'retention', 'capacity', 'storage',
])
export class BlackboardStoreError extends Error {
  constructor(readonly code: z.infer<typeof blackboardErrorCodeSchema>) {
    super(`blackboard ${code}`)
    this.name = 'BlackboardStoreError'
  }
}

const responseSchema = z.discriminatedUnion('ok', [
  z.object({id: integer, ok: z.literal(true), result: z.unknown()}).strict(),
  z.object({id: integer, ok: z.literal(false), error: blackboardErrorCodeSchema}).strict(),
])

/** One host scope, one unacknowledged operation. Failed/uncertain writes never hide behind a queue. */
export class BlackboardStore {
  readonly #options: z.output<typeof blackboardOptionsSchema>
  #worker: Worker | undefined
  #sequence = 0
  #closed = false
  #opened = false
  #termination: Promise<unknown> | undefined
  #inflight: Promise<unknown> | undefined
  #closing: Promise<void> | undefined
  #pending: {id: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout} | undefined

  constructor(options: BlackboardOptions) {
    this.#options = blackboardOptionsSchema.parse(options)
  }

  async open(): Promise<BlackboardSnapshot> {
    if (this.#closed || this.#closing !== undefined || this.#worker !== undefined) throw new BlackboardStoreError('closed')
    this.#worker = new Worker(new URL('./blackboard-worker.js', import.meta.url), {workerData: this.#options})
    this.#worker.on('message', value => {
      const parsed = responseSchema.safeParse(value)
      const pending = this.#pending
      if (!parsed.success || parsed.data.id !== pending?.id) {
        this.#fail(new BlackboardStoreError('unavailable'))
        return
      }
      clearTimeout(pending.timer)
      this.#pending = undefined
      if (parsed.data.ok) pending.resolve(parsed.data.result)
      else pending.reject(new BlackboardStoreError(parsed.data.error))
    })
    this.#worker.on('error', () => this.#fail(new BlackboardStoreError('unavailable')))
    this.#worker.on('exit', () => this.#fail(new BlackboardStoreError('closed')))
    try {
      const snapshot = await this.#request('open', blackboardSnapshotSchema)
      this.#opened = true
      return snapshot
    } catch (error) {
      this.#fail(new BlackboardStoreError('closed'))
      await this.#termination
      throw error
    }
  }

  load(): Promise<BlackboardSnapshot> {
    if (!this.#opened) return Promise.reject(new BlackboardStoreError('closed'))
    return this.#request('load', blackboardSnapshotSchema)
  }

  commit(input: BlackboardBatch): Promise<BlackboardReceipt> {
    if (!this.#opened) return Promise.reject(new BlackboardStoreError('closed'))
    const parsed = blackboardBatchSchema.safeParse(input)
    if (!parsed.success) return Promise.reject(new BlackboardStoreError('invalid_input'))
    return this.#request('commit', blackboardReceiptSchema, parsed.data)
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      const timer = setTimeout(() => this.#fail(new BlackboardStoreError('unavailable')), 400)
      try { await this.#close() } finally { clearTimeout(timer) }
    })()
    return this.#closing
  }

  async #close(): Promise<void> {
    // Preserve the actual commit outcome; the existing RPC timeout bounds this drain.
    try { await this.#inflight } catch { /* the operation's caller receives its failure */ }
    if (this.#closed) { await this.#termination; return }
    try {
      if (this.#worker !== undefined) await this.#request('close', z.null())
    } finally {
      this.#fail(new BlackboardStoreError('closed'))
      await this.#termination
    }
  }

  async #request<T>(operation: string, schema: z.ZodType<T>, batch?: BlackboardBatch): Promise<T> {
    if (this.#closed || this.#worker === undefined) throw new BlackboardStoreError('closed')
    if (this.#closing !== undefined && operation !== 'close') throw new BlackboardStoreError('closed')
    if (this.#pending !== undefined) throw new BlackboardStoreError('busy')
    const id = ++this.#sequence
    const request = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new BlackboardStoreError('unavailable')), 10_000)
      this.#pending = {id, resolve, reject, timer}
      try { this.#worker!.postMessage({id, operation, ...(batch === undefined ? {} : {batch})}) }
      catch { this.#fail(new BlackboardStoreError('unavailable')) }
    })
    const validated = request.then(result => {
      const parsed = schema.safeParse(result)
      if (!parsed.success) {
        this.#fail(new BlackboardStoreError('unavailable'))
        throw new BlackboardStoreError('unavailable')
      }
      return parsed.data
    })
    this.#inflight = validated
    try { return await validated }
    finally { if (this.#inflight === validated) this.#inflight = undefined }
  }

  #fail(error: BlackboardStoreError): void {
    this.#closed = true
    const pending = this.#pending
    this.#pending = undefined
    if (pending !== undefined) { clearTimeout(pending.timer); pending.reject(error) }
    const worker = this.#worker
    this.#worker = undefined
    if (worker !== undefined) {
      worker.unref()
      this.#termination = Promise.race([
        worker.terminate().catch(() => undefined),
        new Promise<void>(resolve => { setTimeout(resolve, 200) }),
      ])
    }
  }
}
