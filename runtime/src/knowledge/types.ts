export type KnowledgeSourceKind = 'file' | 'url' | 'folder_child'
export type KnowledgeSourceStatus = 'ready' | 'failed'

export interface KnowledgeSource {
  readonly id: string
  readonly title: string
  readonly kind: KnowledgeSourceKind
  readonly locator: string
  readonly mime: string
  readonly fingerprint: string
  readonly bytes: number
  readonly created_at: number
  readonly updated_at: number
  readonly status: KnowledgeSourceStatus
}

export interface KnowledgeChunkInput {
  readonly heading_path: string
  readonly text: string
  readonly token_estimate: number
  readonly vector: readonly number[]
}

export interface ReplaceKnowledgeSourceInput {
  readonly source: KnowledgeSource
  readonly chunks: readonly KnowledgeChunkInput[]
  readonly provider_id: string
  readonly dims: number
}

export interface KnowledgeRecallHit {
  readonly locator: string
  readonly source_id: string
  readonly title: string
  readonly heading_path: string
  readonly text: string
  readonly score: number
}

export interface KnowledgeChunkResult {
  readonly status: 'ok' | 'stale' | 'gone'
  readonly text?: string
  readonly title?: string
  readonly heading_path?: string
  readonly source_id?: string
}

export interface KnowledgeJob {
  readonly id: string
  readonly source_id: string
  readonly state: 'running' | 'complete' | 'failed'
  readonly error_code: string | null
  readonly updated_at: number
}
