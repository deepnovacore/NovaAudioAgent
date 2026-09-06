import {randomUUID} from 'node:crypto'
import {opendir, realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {z} from 'zod'
import {SensitivePathPolicy} from '../workspace-graph/sensitivity.js'
import {chunkKnowledgeText, fetchKnowledgeUrl, readKnowledgeFile} from './documents.js'
import type {EmbeddingProvider} from './embeddings.js'
import type {KnowledgeStoreClient} from './store-client.js'
import type {KnowledgeSource} from './types.js'

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u)
const ingestSchema = z.object({kind: z.enum(['file', 'url', 'folder']), locator: z.string().min(1).max(4096), consent: z.literal(true)}).strict()
const failure = (code: string): Error => new Error(code)

/** Host-only mutations; all public model surfaces receive read-only evidence. */
export class KnowledgeService {
  readonly #store: KnowledgeStoreClient
  readonly #embedding: EmbeddingProvider
  readonly #stop = new AbortController()
  #active: {id: string; abort: AbortController} | undefined
  #folderBusy = false
  #folderSignal: AbortSignal | undefined
  #queries = 0
  #fts = false

  constructor(options: {store: KnowledgeStoreClient; embedding: EmbeddingProvider}) {
    this.#store = options.store; this.#embedding = options.embedding
  }
  async open(): Promise<void> {this.#fts = (await this.#store.open()).fts}
  async close(): Promise<void> {
    this.#stop.abort(); this.#active?.abort.abort()
    await this.#store.close()
  }
  listSources(): Promise<readonly KnowledgeSource[]> {return this.#store.listSources()}
  getChunk(locator: string) {return this.#store.getChunk(locator)}

  async recall(query: string, k: number, signal?: AbortSignal) {
    if (this.#queries >= 4) throw failure('knowledge_busy')
    const input = z.object({query: z.string().trim().min(1).max(512), k: z.number().int().min(1).max(5)}).parse({query, k})
    const abort = AbortSignal.any([this.#stop.signal, ...(signal ? [signal] : []), AbortSignal.timeout(8000)])
    abort.throwIfAborted()
    this.#queries++
    try {
      if ((await this.#store.listSources()).length === 0) return []
      const [vector] = await this.#embedding.embed([input.query], abort)
      abort.throwIfAborted()
      if (vector === undefined) throw failure('embedding_invalid_result')
      const hits = await this.#store.recall(input.query, [...vector], this.#embedding.id, input.k)
      abort.throwIfAborted()
      return hits
    } finally {this.#queries--}
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    this.#stop.signal.throwIfAborted()
    if (method === 'knowledge.status') {
      if (!z.object({}).strict().safeParse(params).success) throw failure('invalid_request')
      const sources = await this.#store.listSources(), jobs = await this.#store.listJobs()
      return {fts: this.#fts, sources: sources.map(({id, title, kind, bytes, updated_at, status}) => ({id, title, kind, bytes, updated_at, status})), jobs}
    }
    if (method === 'knowledge.remove') {
      const parsed = z.object({id: idSchema}).strict().safeParse(params)
      if (!parsed.success) throw failure('invalid_request')
      if (this.#active?.id === parsed.data.id) this.#active.abort.abort()
      await this.#store.removeSource(parsed.data.id)
      return {ok: true}
    }
    if (method === 'knowledge.reindex') {
      const parsed = z.object({id: idSchema, consent: z.literal(true)}).strict().safeParse(params)
      if (!parsed.success) throw failure('invalid_request')
      if (this.#active || this.#folderBusy) return {error: 'knowledge_busy'}
      // Claim the id before any asynchronous read, so remove can fence this reindex.
      const active = {id: parsed.data.id, abort: new AbortController()}
      this.#active = active
      try {
        const source = (await this.#store.listSources()).find(value => value.id === active.id)
        if (source === undefined) return {error: 'source_gone'}
        return await this.#index(source.kind, source.locator, active, source)
      } finally {if (this.#active === active) this.#active = undefined}
    }
    if (method === 'knowledge.ingest') {
      const parsed = ingestSchema.safeParse(params)
      if (!parsed.success) throw failure('invalid_request')
      if (this.#active || this.#folderBusy) return {error: 'knowledge_busy'}
      if (parsed.data.kind === 'folder') return this.#folder(parsed.data.locator)
      return this.#ingest(parsed.data.kind, parsed.data.locator)
    }
    throw failure('invalid_request')
  }

  async #ingest(kind: KnowledgeSource['kind'], locator: string): Promise<unknown> {
    const active = {id: randomUUID(), abort: new AbortController()}
    this.#active = active
    try {return await this.#index(kind, locator, active)}
    finally {if (this.#active === active) this.#active = undefined}
  }

  async #index(kind: KnowledgeSource['kind'], locator: string, active: {id: string; abort: AbortController}, old?: KnowledgeSource) {
    const signal = AbortSignal.any([active.abort.signal, this.#stop.signal,
      ...(this.#folderSignal === undefined ? [] : [this.#folderSignal]), AbortSignal.timeout(120000)])
    const job = {id: randomUUID(), source_id: active.id, updated_at: Date.now(), error_code: null}
    try {
      signal.throwIfAborted()
      await this.#store.recordJob({...job, state: 'running'})
      const document = await (kind === 'url' ? fetchKnowledgeUrl(locator, signal) : readKnowledgeFile(locator, signal))
      signal.throwIfAborted()
      if (old === undefined && (await this.#store.listSources()).some(value => value.locator === document.locator)) throw failure('source_exists')
      const chunks = chunkKnowledgeText(document.text)
      const vectors = await this.#embedding.embed(chunks.map(chunk => chunk.text), signal)
      signal.throwIfAborted()
      if (vectors.length !== chunks.length) throw failure('embedding_invalid_result')
      const now = Date.now()
      const title = [...document.title].slice(0, 256).join('')
      // No await between this fence and enqueueing the atomic replacement. Remove enqueues after it.
      await this.#store.replaceSource({
        source: {id: active.id, title, kind, locator: document.locator, mime: document.mime,
          fingerprint: document.fingerprint, bytes: document.bytes, created_at: old?.created_at ?? now, updated_at: now, status: 'ready'},
        provider_id: this.#embedding.id, dims: this.#embedding.dims,
        // Plain text and extracted PDF/DOCX need not contain Markdown headings.
        chunks: chunks.map((chunk, index) => ({...chunk,
          heading_path: [...(chunk.heading_path || title)].slice(0, 256).join(''), vector: [...vectors[index]!]})),
      })
      await this.#store.recordJob({...job, updated_at: Date.now(), state: 'complete'})
      return {ok: true, id: active.id}
    } catch {
      const code = signal.aborted ? 'ingest_cancelled' : 'ingest_failed'
      if (!this.#stop.signal.aborted) await this.#store.recordJob({...job, updated_at: Date.now(), state: 'failed', error_code: code}).catch(() => undefined)
      return {error: code, id: active.id}
    }
  }

  async #folder(locator: string): Promise<unknown> {
    this.#folderBusy = true
    this.#folderSignal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(120000)])
    const results: unknown[] = []
    try {
      const policy = new SensitivePathPolicy()
      if (!policy.allows(locator)) throw failure('invalid_request')
      const root = await realpath(locator)
      if (!policy.allows(root)) throw failure('invalid_request')
      const directories = [{path: root, depth: 0}]
      let visited = 0
      while (directories.length > 0 && results.length < 100 && visited < 1000) {
        this.#folderSignal.throwIfAborted()
        const directory = directories.pop()!
        for await (const entry of await opendir(directory.path)) {
          visited++
          if (visited > 1000 || results.length >= 100) break
          const path = join(directory.path, entry.name)
          if (entry.name.startsWith('.') || !policy.allows(path) || entry.isSymbolicLink()) continue
          if (entry.isDirectory() && directory.depth < 16) directories.push({path, depth: directory.depth + 1})
          else if (entry.isFile()) results.push(await this.#ingest('folder_child', path))
        }
      }
      return {results, limited: visited >= 1000 || results.length >= 100}
    } finally {this.#folderBusy = false; this.#folderSignal = undefined}
  }
}
