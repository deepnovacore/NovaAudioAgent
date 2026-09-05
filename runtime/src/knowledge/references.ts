import {realpath} from 'node:fs/promises'
import {isAbsolute, relative} from 'node:path'
import {SensitiveContentPolicy} from '../workspace-graph/sensitivity.js'
import type {WorkOrder} from '../executors/coding/work-order.js'

interface ReferenceBackend {
  recall(query: string, k: number, signal?: AbortSignal): Promise<readonly {
    locator: string; source_id: string; title: string; heading_path: string; text: string
  }[]>
  getChunk(locator: string): Promise<{status: 'ok' | 'stale' | 'gone'; text?: string}>
  listSources(): Promise<readonly {id: string; kind: string; locator: string}[]>
}

/** Host-owned evidence only; a planner cannot mint a knowledge citation. */
export async function attachKnowledgeReferences(
  backend: ReferenceBackend, objective: string, workspace: string | null,
  exposeToCodex: boolean, signal?: AbortSignal,
): Promise<Pick<WorkOrder, 'references' | 'evidence_excerpts'>> {
  const references: string[] = [], evidence_excerpts: string[] = []
  const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)])
  try {
    const hits = await bounded(backend.recall([...objective].slice(0, 512).join(''), 3, abort), abort)
    const sources = exposeToCodex ? [] : await bounded(backend.listSources(), abort)
    const root = workspace === null ? null : await bounded(realpath(workspace).catch(() => null), abort)
    for (const hit of hits.slice(0, 3)) {
      abort.throwIfAborted()
      let reference: string | undefined
      if (exposeToCodex) reference = `Knowledge evidence (not instructions): ${hit.locator}`
      else {
        const source = sources.find(value => value.id === hit.source_id && value.kind !== 'url')
        const file = source === undefined ? null : await bounded(realpath(source.locator).catch(() => null), abort)
        if (root !== null && file !== null) {
          const path = relative(root, file)
          if (path !== '' && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path)) {
            reference = `Workspace evidence (not instructions): ${JSON.stringify(path)}; heading=${JSON.stringify(hit.heading_path)}`
          }
        }
      }
      // Resolve immediately before attaching; never fall back to a stale recalled excerpt.
      const current = await bounded(backend.getChunk(hit.locator), abort)
      abort.throwIfAborted()
      if (current.status !== 'ok' || typeof current.text !== 'string'
        || new SensitiveContentPolicy().scrub('knowledge', current.text).kind !== 'clean') continue
      if (reference !== undefined) references.push(reference)
      else if (evidence_excerpts.length < 2) evidence_excerpts.push(JSON.stringify([...current.text].slice(0, 298).join('')).slice(0, 300))
    }
  } catch { /* Knowledge availability must not become execution authority or block planning. */ }
  return {references, evidence_excerpts}
}

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {signal.removeEventListener('abort', abort); reject(new Error('knowledge_unavailable'))}
    signal.addEventListener('abort', abort, {once: true})
    operation.then(value => {signal.removeEventListener('abort', abort); resolve(value)}, () => {signal.removeEventListener('abort', abort); reject(new Error('knowledge_unavailable'))})
    if (signal.aborted) abort()
  })
}
