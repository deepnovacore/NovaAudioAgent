import type {ProcessingGrant} from '../memory-substrate/source-state.js'
import {randomUUID} from 'node:crypto'
import {appendFileSync} from 'node:fs'
import {opendir, realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {z} from 'zod'
import {SensitivePathPolicy} from '../memory/sensitivity.js'
import {acceptanceManifest} from '../desktop/workbench-acceptance.js'
import {chunkKnowledgeText, fetchKnowledgeUrl, readKnowledgeFile, knowledgeExcerpt, KnowledgeDocumentFailure} from './documents.js'
import type {EmbeddingProvider} from './embeddings.js'
import type {KnowledgeStoreClient} from './store-client.js'
import {KnowledgeStoreClientError} from './store-client.js'
import type {KnowledgeSource} from './types.js'
import {withModelPurpose} from '../model/model-purpose.js'
import type {PersonalMemoryResource} from '../memory/personal-memory.js'

export interface KnowledgeEvidenceLedger {
  processingGrant?: (consent:boolean,revision?:number,scopeRevision?:number)=>ProcessingGrant | undefined
  canProcess?: (id:string,purpose:'extraction'|'embedding')=>Promise<boolean>
  processingStamp?: (ids:string[])=>Promise<string|null>
  record(input: {sourceId: string; locator: string; text: string; observedAt: string; kind: 'file'; embeddingConsent: boolean;processingConsent?:ProcessingGrant}): Promise<{evidence_id: string}>
  /** A document's chunks in one ledger transaction, in order. */
  recordBatch?(inputs: {sourceId: string; locator: string; text: string; observedAt: string; kind: 'file'; embeddingConsent: boolean;processingConsent?:ProcessingGrant}[]): Promise<{evidence_id: string}[]>
  read: NonNullable<PersonalMemoryResource['readEvidence']>
  remove(sourceId: string): Promise<void>
}

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u)
const ingestSchema = z.object({kind: z.enum(['file', 'url', 'folder']), locator: z.string().min(1).max(4096), consent: z.literal(true)}).strict()
const failure = (code: string): Error => new Error(code)
export interface VectorOwner {readonly signal: AbortSignal; readonly grant: ProcessingGrant | undefined}
/** Matches the provider's request batch, so each backfill upload is individually authorized. */
const EMBED_BATCH = 10
function ingestionCode(cause: unknown, stage: 'read' | 'evidence' | 'embedding' | 'store'): string {
  if(cause instanceof KnowledgeStoreClientError&&cause.code==='STORE_CAPACITY')return 'index_capacity'
  if (cause instanceof KnowledgeDocumentFailure) {
    if (['sensitive_content', 'path_denied'].includes(cause.code)) return 'screening_rejected'
    if (['unsupported_mime', 'invalid_file', 'file_too_large', 'empty_text', 'invalid_text', 'parse_failed', 'parse_timeout'].includes(cause.code)) return 'unsupported_file'
    if (cause.code === 'file_changed') return 'file_changed'
    if (cause.code === 'file_unavailable') return 'file_unavailable'
  }
  if (cause instanceof Error && cause.message === 'knowledge_busy') return 'knowledge_busy'
  return stage === 'embedding' ? 'embedding_failed' : stage === 'evidence' || stage === 'store' ? 'store_failed' : 'ingest_failed'
}

/** Host-only mutations; all public model surfaces receive read-only evidence. */
export class KnowledgeService {
  readonly #store: KnowledgeStoreClient
  readonly #embedding: EmbeddingProvider
  readonly #stop = new AbortController()
  #active: {id: string; abort: AbortController; root?: string} | undefined
  #folderBusy = false
  #folderSignal: AbortSignal | undefined
  #queries = 0
  #fts = false
  #ledger: KnowledgeEvidenceLedger | undefined
  #binding: Promise<void> | undefined
  #migrated = false
  readonly #requireLedger: boolean
  readonly #vectorQueue = new Map<string, {grant: ProcessingGrant | undefined; signal: AbortSignal | undefined}>()
  readonly #vectorRetries = new Map<string, number>()
  readonly #timings = new Map<string, {ms: number; n: number}>()
  #vectorWork: Promise<void> | undefined
  #vectorGate: ((id: string, queuedByOwner: boolean) => VectorOwner | null | undefined) | undefined
  #resumeRequested = false

  constructor(options: {store: KnowledgeStoreClient; embedding: EmbeddingProvider; requireEvidenceLedger?: boolean}) {
    this.#store = options.store; this.#embedding = options.embedding
    this.#requireLedger = options.requireEvidenceLedger ?? false
  }
  #assertLedger(): void {if (this.#requireLedger && (!this.#ledger || !this.#migrated)) throw failure('knowledge_unavailable')}
  async open(): Promise<void> {this.#fts = (await this.#store.open()).fts}
  async close(): Promise<void> {
    this.#stop.abort(); this.#active?.abort.abort()
    await this.#store.close()
  }
  purgeEvidence(ids:readonly string[]):Promise<void>{return this.#store.purgeEvidence(ids)}
  listSources(): Promise<readonly KnowledgeSource[]> {return this.#store.listSources()}
  async getChunk(locator: string) {
    this.#assertLedger()
    const chunk = await this.#store.getChunk(locator)
    const ledger = this.#ledger
    if (!ledger) return chunk
    if (chunk.status !== 'ok' || !chunk.evidence_id) return {status: chunk.status === 'stale' ? 'stale' as const : 'gone' as const}
    const evidence = await ledger.read(chunk.evidence_id)
    if (this.#ledger !== ledger || evidence?.evidence_id !== chunk.evidence_id) return {status: 'gone' as const}
    return {...chunk, text: evidence.text}
  }

  /** Existing index chunks migrate offline; linked-but-deleted A evidence is never recreated. */
  async bindEvidenceLedger(ledger: KnowledgeEvidenceLedger): Promise<void> {
    if (this.#binding) await this.#binding
    this.#ledger = ledger
    // Reopened runtime resources keep canonical IDs; never import cached plaintext into a new binding.
    if (this.#migrated) return
    const work = this.#migrateEvidence(ledger)
    this.#binding = work
    try {await work; this.#migrated = true} finally {if (this.#binding === work) this.#binding = undefined}
    if (this.#resumeRequested) await this.resumeVectors()
  }

  /** The source owner decides, per backfill round, whether a knowledge source may still be embedded:
   * null skips it now, an owner's signal cancels its in-flight uploads and its current grant replaces
   * the one captured at queue time, undefined means no owner fences it. `queuedByOwner` says the owner
   * queued this work itself with a lifecycle signal, before it could record the new source id. */
  setVectorGate(gate: (id: string, queuedByOwner: boolean) => VectorOwner | null | undefined): void {this.#vectorGate = gate}

  /** Scans commit lexically first; the source owner resumes vectors a previous run or a pause left unfinished. */
  async resumeVectors(): Promise<void> {
    // A ledger-backed service resumes only after its evidence migration settles.
    if (!this.#migrated && (this.#requireLedger || this.#binding)) {this.#resumeRequested = true; return}
    this.#resumeRequested = false
    for (const id of await this.#store.unembeddedSources(this.#embedding.id, this.#embedding.dims)) this.#queueVectors(id, undefined, undefined)
  }

  /** Resolves once scan-committed chunks have been embedded or skipped. */
  async vectorsSettled(): Promise<void> {while (this.#vectorWork) await this.#vectorWork}

  #queueVectors(id: string, grant: ProcessingGrant | undefined, signal: AbortSignal | undefined): void {
    if (this.#stop.signal.aborted || signal?.aborted) return
    this.#vectorQueue.set(id, {grant, signal})
    this.#vectorWork ??= this.#drainVectors().finally(() => {
      this.#vectorWork = undefined
      const next = this.#vectorQueue.entries().next().value
      if (next) this.#queueVectors(next[0], next[1].grant, next[1].signal)
    })
  }

  /** One source at a time, off the scan path; a failure is retried twice with a growing delay. */
  async #drainVectors(): Promise<void> {
    for (const [id, {grant, signal}] of this.#vectorQueue) {
      this.#vectorQueue.delete(id)
      if (this.#stop.signal.aborted) return
      try {await this.#embedSource(id, grant, signal); this.#vectorRetries.delete(id)} catch (cause) {
        if (this.#stop.signal.aborted) return
        const gate = this.#vectorGate?.(id, signal !== undefined)
        if (gate === null || gate?.signal.aborted || signal?.aborted) {this.#vectorRetries.delete(id); continue}
        const acceptance = acceptanceManifest()
        if (acceptance) appendFileSync(join(acceptance.outputDirectory, 'knowledge-errors.ndjson'), JSON.stringify({stage: 'embedding_backfill', code: ingestionCode(cause, 'embedding'), error: cause instanceof Error ? `${cause.name}: ${cause.message}`.slice(0, 300) : typeof cause}) + '\n', {mode: 0o600})
        const attempt = (this.#vectorRetries.get(id) ?? 0) + 1
        if (attempt > 2) {this.#vectorRetries.delete(id); continue}
        this.#vectorRetries.set(id, attempt)
        setTimeout(() => this.#queueVectors(id, grant, signal), 60000 * attempt).unref()
      }
    }
  }

  async #embedSource(id: string, grant: ProcessingGrant | undefined, owner: AbortSignal | undefined): Promise<void> {
    // One provider batch per round, so pause or revocation is observed before every upload.
    for (let round = 0; round < 2000; round++) {
      const gate = this.#vectorGate?.(id, owner !== undefined)
      if (gate === null || gate?.signal.aborted || owner?.aborted) return
      const current = gate ? gate.grant : grant
      const pending = await this.#store.unembeddedChunks(id, this.#embedding.id, this.#embedding.dims)
      if (pending.fingerprint === null || pending.chunks.length === 0) return
      const chunks = pending.chunks.slice(0, EMBED_BATCH)
      const evidenceIds = chunks.map(chunk => chunk.evidence_id), ids = evidenceIds.filter((value): value is string => value !== undefined)
      const ledger = this.#ledger
      const fenced = () => {const now = this.#vectorGate?.(id, owner !== undefined); return now === null || !!now?.signal.aborted || !!gate?.signal.aborted || !!owner?.aborted || (gate !== undefined && now?.grant?.embedding_provider !== current?.embedding_provider)}
      const allowed = async () => !fenced() && (ledger
        ? evidenceIds.length > 0 && (await Promise.all(evidenceIds.map(async value => value ? await (ledger.canProcess?.(value, 'embedding') ?? Promise.resolve(false)) : false))).every(Boolean)
        : current?.embedding_provider === this.#embedding.id)
      const stamp = ledger ? await ledger.processingStamp?.(ids) ?? null : 'standalone'
      if (stamp === null || !await allowed()) return
      const signal = AbortSignal.any([this.#stop.signal, ...(gate ? [gate.signal] : []), ...(owner ? [owner] : []), AbortSignal.timeout(60000)])
      const vectors = await withModelPurpose('embedding', () => this.#embedding.embed(chunks.map(chunk => chunk.text), signal))
      signal.throwIfAborted()
      if (vectors.length !== chunks.length) throw failure('embedding_invalid_result')
      if (!await allowed() || this.#ledger !== ledger || (ledger && stamp !== await ledger.processingStamp?.(ids))) return
      // No await between this fence and enqueueing the fingerprint-checked write.
      const written = await this.#store.setVectors({source_id: id, fingerprint: pending.fingerprint, provider_id: this.#embedding.id, dims: this.#embedding.dims,
        vectors: chunks.map((chunk, index) => ({chunk_id: chunk.chunk_id, content_digest: chunk.content_digest, vector: [...vectors[index]!]}))})
      if (written === 0) return
    }
  }

  async #migrateEvidence(ledger: KnowledgeEvidenceLedger): Promise<void> {
    for (const source of await this.#store.listSources()) {
      for (let offset = 0; offset < 20000; offset += 100) {
        this.#stop.signal.throwIfAborted()
        const chunks = await this.#store.listChunks(source.id, offset)
        const links: {chunk_id: string; content_digest: string; evidence_id: string}[] = []
        for (const chunk of chunks) {
          if (chunk.evidence_id) continue
          const record = await ledger.record({sourceId: `knowledge:${source.id}`, locator: `${chunk.locator}#chunk=${chunk.ordinal}`, text: chunk.text, observedAt: chunk.observed_at, kind: 'file', embeddingConsent: false})
          links.push({chunk_id: chunk.chunk_id, content_digest: chunk.content_digest, evidence_id: record.evidence_id})
        }
        if (links.length) await this.#store.linkEvidence(links)
        if (chunks.length < 100) break
      }
    }
  }

  async recall(query: string, k: number, signal?: AbortSignal) {
    this.#assertLedger()
    if (this.#queries >= 4) throw failure('knowledge_busy')
    const input = z.object({query: z.string().trim().min(1).max(512), k: z.number().int().min(1).max(5)}).parse({query, k})
    const abort = AbortSignal.any([this.#stop.signal, ...(signal ? [signal] : []), AbortSignal.timeout(8000)])
    abort.throwIfAborted()
    this.#queries++
    try {
      if ((await this.#store.listSources()).length === 0) return []
      const [vector] = await withModelPurpose('recall',()=>this.#embedding.embed([input.query], abort))
      abort.throwIfAborted()
      if (vector === undefined) throw failure('embedding_invalid_result')
      const hits = await this.#store.recall(input.query, [...vector], this.#embedding.id, input.k)
      abort.throwIfAborted()
      if (!this.#ledger) return hits
      const current = await Promise.all(hits.map(async hit => {
        if (!hit.evidence_id) return null
        const chunk = await this.getChunk(hit.locator)
        abort.throwIfAborted()
        return chunk.status === 'ok' && chunk.evidence_id === hit.evidence_id && typeof chunk.text === 'string' ? {...hit, text: [...chunk.text].slice(0, 600).join('')} : null
      }))
      return current.filter((hit): hit is NonNullable<typeof hit> => hit !== null)
    } finally {this.#queries--}
  }

  /** Directory-source admission retains its grant and cancellation through the actual file read. */
  /** `vectorSignal` outlives the scan: the source owner aborts it when the source is paused, removed, or withdrawn. */
  /** Cumulative ingest time per step, for acceptance counts. */
  timings(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [key, row] of this.#timings) {out[`${key}_ms`] = Math.round(row.ms); out[`${key}_n`] = row.n}
    return out
  }
  async #timed<T>(key: string, run: () => Promise<T>): Promise<T> {
    const at = performance.now()
    try {return await run()} finally {const row = this.#timings.get(key) ?? {ms: 0, n: 0}; row.ms += performance.now() - at; row.n++; this.#timings.set(key, row)}
  }

  async syncFile(locator: string, root: string, signal: AbortSignal, sourceId?: string,processingConsent?:ProcessingGrant,vectorSignal?:AbortSignal): Promise<{id: string; excerpt: string; evidence_ids?: string[]}> {
    this.#assertLedger()
    signal.throwIfAborted()
    this.#stop.signal.throwIfAborted()
    if (this.#active || this.#folderBusy) throw failure('knowledge_busy')
    if (sourceId !== undefined && !idSchema.safeParse(sourceId).success) throw failure('invalid_request')
    const active = {id: sourceId ?? randomUUID(), abort: new AbortController(), root,...(processingConsent?{processingConsent}:{}),processingAuthorized:false,deferVectors:true}
    this.#active = active
    const cancel = () => active.abort.abort()
    signal.addEventListener('abort', cancel, {once: true})
    try {
      const known=await this.#timed('ingest_list',()=>this.#store.listSources())
      const old = known.find(source => source.locator === locator)
      if(!old&&known.length>=this.#store.maxSources)throw failure('index_capacity')
      signal.throwIfAborted()
      if (sourceId !== undefined && this.#ledger) {
        if (old && old.id !== sourceId) throw failure('source_changed')
        // Build under a fresh ID. The old index stays queryable if reading,
        // embedding, or the atomic replacement fails.
        active.id = randomUUID()
      } else if (old !== undefined) active.id = old.id
      let excerpt = ''
      const result = await this.#index('folder_child', locator, active, old, text => {excerpt = knowledgeExcerpt(text)})
      if ('error' in result) throw failure(result.error)
      if (old && old.id !== active.id) {
        await this.#ledger?.remove(`knowledge:${old.id}`)
      }
      this.#queueVectors(active.id, processingConsent, vectorSignal)
      const evidence_ids = (await this.#timed('ingest_list_chunks',()=>this.#store.listChunks(active.id, 0))).flatMap(chunk => chunk.evidence_id ? [chunk.evidence_id] : []).slice(0, 2)
      return {id: active.id, excerpt, ...(evidence_ids.length ? {evidence_ids} : {})}
    } catch (cause) {
      signal.throwIfAborted()
      const code = cause instanceof Error && /^(?:screening_rejected|unsupported_file|file_changed|file_unavailable|embedding_failed|store_failed|knowledge_busy|ingest_failed|index_capacity)$/u.test(cause.message)
        ? cause.message : 'store_failed'
      throw failure(code)
    } finally {
      signal.removeEventListener('abort', cancel)
      if (this.#active === active) this.#active = undefined
    }
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    this.#stop.signal.throwIfAborted()
    if (method === 'knowledge.status') {
      if (!z.object({}).strict().safeParse(params).success) throw failure('invalid_request')
      const sources = await this.#store.listSources(), jobs = await this.#store.listJobs()
      return {fts: this.#fts, sources: sources.map(({id, title, kind, bytes, updated_at, status}) => ({id, title, kind, bytes, updated_at, status})), jobs}
    }
    if (method === 'knowledge.remove') {
      this.#assertLedger()
      const parsed = z.object({id: idSchema}).strict().safeParse(params)
      if (!parsed.success) throw failure('invalid_request')
      if (this.#active?.id === parsed.data.id) this.#active.abort.abort()
      await this.#ledger?.remove(`knowledge:${parsed.data.id}`)
      await this.#store.removeSource(parsed.data.id)
      return {ok: true}
    }
    if (method === 'knowledge.reindex') {
      this.#assertLedger()
      const parsed = z.object({id: idSchema, consent: z.literal(true)}).strict().safeParse(params)
      if (!parsed.success) throw failure('invalid_request')
      if (this.#active || this.#folderBusy) return {error: 'knowledge_busy'}
      // Claim the id before any asynchronous read, so remove can fence this reindex.
      const active = {id: parsed.data.id, abort: new AbortController(),processingAuthorized:parsed.data.consent}
      this.#active = active
      try {
        const source = (await this.#store.listSources()).find(value => value.id === active.id)
        if (source === undefined) return {error: 'source_gone'}
        return await this.#index(source.kind, source.locator, active, source)
      } finally {if (this.#active === active) this.#active = undefined}
    }
    if (method === 'knowledge.ingest') {
      this.#assertLedger()
      const parsed = ingestSchema.safeParse(params)
      if (!parsed.success) throw failure('invalid_request')
      if (this.#active || this.#folderBusy) return {error: 'knowledge_busy'}
      if (parsed.data.kind === 'folder') return this.#folder(parsed.data.locator)
      return this.#ingest(parsed.data.kind, parsed.data.locator)
    }
    throw failure('invalid_request')
  }

  async #ingest(kind: KnowledgeSource['kind'], locator: string): Promise<unknown> {
    const active = {id: randomUUID(), abort: new AbortController(),processingAuthorized:true}
    this.#active = active
    try {return await this.#index(kind, locator, active)}
    finally {if (this.#active === active) this.#active = undefined}
  }

  async #index(kind: KnowledgeSource['kind'], locator: string, active: {id: string; abort: AbortController; root?: string;processingAuthorized?:boolean;processingConsent?:ProcessingGrant;deferVectors?:boolean}, old?: KnowledgeSource, onIndexed?: (text: string) => void) {
    const signal = AbortSignal.any([active.abort.signal, this.#stop.signal,
      ...(this.#folderSignal === undefined ? [] : [this.#folderSignal]), AbortSignal.timeout(120000)])
    const job = {id: randomUUID(), source_id: active.id, updated_at: Date.now(), error_code: null}
    let stage: 'read' | 'evidence' | 'embedding' | 'store' = 'store'
    let committed = false
    try {
      signal.throwIfAborted()
      await this.#timed('ingest_job',()=>this.#store.recordJob({...job, state: 'running'}))
      stage = 'read'
      const document = await this.#timed('ingest_read',()=>kind === 'url' ? fetchKnowledgeUrl(locator, signal) : readKnowledgeFile(locator, signal, active.root))
      signal.throwIfAborted()
      if (old === undefined && (await this.#timed('ingest_list',()=>this.#store.listSources())).some(value => value.locator === document.locator)) throw failure('source_exists')
      const chunks = chunkKnowledgeText(document.text)
      const processingConsent=active.processingConsent??(active.processingAuthorized?this.#ledger?.processingGrant?.(true):undefined)
      const evidenceIds: (string | undefined)[] = []
      stage = 'evidence'
      const evidenceAt = performance.now()
      // The grant belongs to the source, not the chunk: stating it once spares a read and write per chunk.
      const inputs = chunks.map((chunk, ordinal) => ({sourceId: `knowledge:${active.id}`, locator: `${document.locator}#chunk=${ordinal}`, text: chunk.text, observedAt: new Date().toISOString(), kind: 'file' as const, embeddingConsent: active.processingAuthorized===true||Boolean(processingConsent?.embedding_provider),...(processingConsent&&ordinal===0?{processingConsent}:{})}))
      const ledger = this.#ledger
      if (ledger?.recordBatch) {
        // One ledger transaction per 256 chunks instead of two round trips per chunk.
        for (let start = 0; start < inputs.length; start += 256) {
          signal.throwIfAborted()
          const part = inputs.slice(start, start + 256), saved = await ledger.recordBatch(part)
          if (saved.length !== part.length) throw failure('store_failed')
          evidenceIds.push(...saved.map(row => row.evidence_id))
        }
      } else for (const input of inputs) {
        signal.throwIfAborted()
        const evidence = await ledger?.record(input)
        evidenceIds.push(evidence?.evidence_id)
      }
      {const row = this.#timings.get('ingest_evidence') ?? {ms: 0, n: 0}; row.ms += performance.now() - evidenceAt; row.n += chunks.length; this.#timings.set('ingest_evidence', row)}
      signal.throwIfAborted()
      const allowed=async()=>{if(this.#ledger)return evidenceIds.length>0&&(await Promise.all(evidenceIds.map(async id=>id?await (this.#ledger?.canProcess?.(id,'embedding')??Promise.resolve(false)):false))).every(Boolean);return active.processingAuthorized===true||processingConsent?.embedding_provider===this.#embedding.id}
      const stamp=this.#ledger?await this.#timed('ingest_stamp',async()=>await this.#ledger?.processingStamp?.(evidenceIds.filter((id):id is string=>id!==undefined)))??null:'standalone'
      stage = 'embedding'
      // Scan-time sources commit lexically now; #drainVectors embeds them off the scan path.
      const vectors = !active.deferVectors&&stamp!==null&&await allowed()?await withModelPurpose('embedding',()=>this.#embedding.embed(chunks.map(chunk => chunk.text), signal)):null
      signal.throwIfAborted()
      if (vectors!==null&&vectors.length !== chunks.length) throw failure('embedding_invalid_result')
      const keepVectors=vectors!==null&&await allowed()&&(!this.#ledger||stamp===await this.#ledger.processingStamp?.(evidenceIds.filter((id):id is string=>id!==undefined)))
      const now = Date.now()
      const title = [...document.title].slice(0, 256).join('')
      // No await between this fence and enqueueing the atomic replacement. Remove enqueues after it.
      stage = 'store'
      await this.#timed('ingest_store',()=>this.#store.replaceSource({
        source: {id: active.id, title, kind, locator: document.locator, mime: document.mime,
          fingerprint: document.fingerprint, bytes: document.bytes, created_at: old?.created_at ?? now, updated_at: now, status: 'ready'},
        ...(old && old.id !== active.id ? {replaces_source_id: old.id} : {}),
        provider_id: this.#embedding.id, dims: this.#embedding.dims,
        // Plain text and extracted PDF/DOCX need not contain Markdown headings.
        chunks: chunks.map((chunk, index) => ({...chunk,
          ...(evidenceIds[index] === undefined ? {} : {evidence_id: evidenceIds[index]}),
          heading_path: [...(chunk.heading_path || title)].slice(0, 256).join(''), vector: keepVectors&&vectors?[...vectors[index]!]:null})),
      }))
      committed = true
      await this.#store.recordJob({...job, updated_at: Date.now(), state: 'complete'}).catch(() => undefined)
      onIndexed?.(document.text)
      return {ok: true, id: active.id}
    } catch (cause) {
      const code = signal.aborted ? 'ingest_cancelled' : ingestionCode(cause, stage)
      const acceptance=acceptanceManifest()
      if(acceptance)appendFileSync(join(acceptance.outputDirectory,'knowledge-errors.ndjson'),JSON.stringify({stage,code,error:cause instanceof Error?`${cause.name}: ${cause.message}`.slice(0,300):typeof cause})+'\n',{mode:0o600})
      if (!committed && old?.id !== active.id) await this.#ledger?.remove(`knowledge:${active.id}`).catch(() => undefined)
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
