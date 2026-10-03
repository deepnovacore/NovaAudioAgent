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
  readonly evidence_id?: string
  readonly heading_path: string
  readonly text: string
  readonly token_estimate: number
  readonly vector: readonly number[] | null
}

export interface ReplaceKnowledgeSourceInput {
  readonly source: KnowledgeSource
  readonly replaces_source_id?: string
  readonly chunks: readonly KnowledgeChunkInput[]
  readonly provider_id: string
  readonly dims: number
}

export interface KnowledgeRecallHit {
  readonly evidence_id?: string
  readonly locator: string
  readonly source_id: string
  readonly title: string
  readonly heading_path: string
  readonly text: string
  readonly score: number
}

export interface KnowledgeChunkResult {
  readonly evidence_id?: string
  readonly status: 'ok' | 'stale' | 'gone'
  readonly text?: string
  readonly title?: string
  readonly heading_path?: string
  readonly source_id?: string
}

export interface KnowledgeIndexChunk {
  readonly chunk_id: string
  readonly source_id: string
  readonly locator: string
  readonly text: string
  readonly ordinal: number
  readonly observed_at: string
  readonly content_digest: string
  readonly evidence_id?: string
}

export interface KnowledgeJob {
  readonly id: string
  readonly source_id: string
  readonly state: 'running' | 'complete' | 'failed'
  readonly error_code: string | null
  readonly updated_at: number
}

export interface KnowledgeUnembedded {
  readonly fingerprint: string | null
  readonly chunks: readonly {readonly chunk_id: string; readonly content_digest: string; readonly text: string; readonly evidence_id?: string}[]
}
