import {homedir} from 'node:os'
import {resolve} from 'node:path'
import type {Settings} from '../config.js'
import type {CapabilityRegistry, McpServerConfig} from '../capability-registry.js'
import {DashScopeEmbeddingProvider} from './embeddings.js'
import {KnowledgeStoreClient} from './store-client.js'
import {KnowledgeService} from './service.js'
import {KnowledgeMcpAdapter, startKnowledgeMcpHttpServer} from './mcp.js'

export interface PreparedKnowledge {
  readonly service: KnowledgeService
  readonly adapter: KnowledgeMcpAdapter
  readonly capabilities: CapabilityRegistry
  readonly codexEntries: Readonly<Record<string, McpServerConfig>>
  close(): Promise<void>
}

/** Async resource admission before synchronous tool compilation or child creation. */
export async function prepareKnowledge(
  settings: Settings, capabilities: CapabilityRegistry, signal?: AbortSignal,
): Promise<PreparedKnowledge | undefined> {
  if (!capabilities.modules.knowledge.enabled) return undefined
  if (settings.embedding_provider !== 'dashscope') throw new Error('embedding_provider_unavailable')
  signal?.throwIfAborted()
  const embedding = new DashScopeEmbeddingProvider({baseUrl: settings.model_base_url,
    apiKey: settings.model_api_key ?? '', model: settings.embedding_model})
  const configured = settings.knowledge_path
  const path = resolve(configured.startsWith('~/') ? resolve(homedir(), configured.slice(2)) : configured)
  const service = new KnowledgeService({store: new KnowledgeStoreClient({path}), embedding})
  const adapter = new KnowledgeMcpAdapter(service)
  let http: Awaited<ReturnType<typeof startKnowledgeMcpHttpServer>> | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    try {await http?.close()} finally {try {await adapter.close()} finally {await service.close()}}
  })()
  try {
    await service.open()
    signal?.throwIfAborted()
    await adapter.connect()
    if (capabilities.modules.knowledge.exposeToCodex && capabilities.modules.coding.enabled) http = await startKnowledgeMcpHttpServer(service)
    signal?.throwIfAborted()
    const tool = {enabled: true, timeoutMs: 8000, maxResultBytes: 32768, maxCallsPerTurn: 2}
    const codexEntries: Record<string, McpServerConfig> = http === undefined ? {} : {nova_knowledge: {
      enabled: true, transport: 'streamable-http', url: http.url, headers: {authorization: `Bearer ${http.token}`},
      exposeTo: {frontbrain: false, codex: true}, tools: {recall: {...tool}, get_chunk: {...tool}},
    }}
    return {service, adapter, capabilities, codexEntries, close}
  } catch {
    await close()
    throw new Error('knowledge_startup_failed')
  }
}
