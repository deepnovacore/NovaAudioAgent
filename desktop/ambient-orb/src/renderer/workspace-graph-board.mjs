const MAX_ID_CODE_POINTS = 256
const MAX_NAME_CODE_POINTS = 239
const MAX_LOGICAL_WORKSPACES = 64
const MAX_WORKSPACE_INSTANCES = 128
const MAX_RELATIONS = 128
const RELATION_TYPES = new Set([
  'depends_on', 'sibling_of', 'replaces', 'shares_runtime', 'discussed_with',
])
const RELATION_STATUSES = new Set(['active', 'weak'])

export function parseWorkspaceGraphBoardPayload(value) {
  try {
    const encoded = JSON.stringify(value)
    if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).length > 16 * 1024) return null
    exactObject(value, [
      'availability', 'logical_workspaces', 'omitted', 'publication_revision',
      'relations', 'request_id', 'type', 'workspace_instances',
    ])
    if (value.type !== 'workspace_graph.board') return null
    if (!identifier(value.request_id)) return null
    if (!['ready', 'disabled', 'degraded'].includes(value.availability)) return null
    if (!nonNegativeInteger(value.publication_revision)) return null
    exactObject(value.omitted, ['logical_workspaces', 'relations', 'workspace_instances'])
    if (!nonNegativeInteger(value.omitted.logical_workspaces)
      || !nonNegativeInteger(value.omitted.workspace_instances)
      || !nonNegativeInteger(value.omitted.relations)) return null
    if (!boundedArray(value.logical_workspaces, MAX_LOGICAL_WORKSPACES)
      || !boundedArray(value.workspace_instances, MAX_WORKSPACE_INSTANCES)
      || !boundedArray(value.relations, MAX_RELATIONS)) return null

    const logicalWorkspaces = value.logical_workspaces.map(item => {
      exactObject(item, ['display_name', 'logical_workspace_id'])
      if (!identifier(item.logical_workspace_id) || !displayName(item.display_name)) throw invalid()
      return Object.freeze({
        logical_workspace_id: item.logical_workspace_id,
        display_name: item.display_name,
      })
    })
    const logicalIds = new Set(logicalWorkspaces.map(item => item.logical_workspace_id))
    if (logicalIds.size !== logicalWorkspaces.length) return null

    const workspaceInstances = value.workspace_instances.map(item => {
      exactObject(item, [
        'active', 'display_name', 'instance_id', 'last_seen_at', 'logical_workspace_id',
      ])
      if (!identifier(item.instance_id)
        || !identifier(item.logical_workspace_id)
        || !logicalIds.has(item.logical_workspace_id)
        || !displayName(item.display_name)
        || typeof item.active !== 'boolean'
        || !finiteTimestamp(item.last_seen_at)) throw invalid()
      return Object.freeze({
        instance_id: item.instance_id,
        logical_workspace_id: item.logical_workspace_id,
        display_name: item.display_name,
        active: item.active,
        last_seen_at: item.last_seen_at,
      })
    })
    if (new Set(workspaceInstances.map(item => item.instance_id)).size !== workspaceInstances.length) {
      return null
    }

    const relations = value.relations.map(item => {
      exactObject(item, [
        'confidence', 'evidence_count', 'last_seen_at', 'relation_type',
        'source_logical_id', 'status', 'target_logical_id',
      ])
      if (!identifier(item.source_logical_id)
        || !identifier(item.target_logical_id)
        || !logicalIds.has(item.source_logical_id)
        || !logicalIds.has(item.target_logical_id)
        || !RELATION_TYPES.has(item.relation_type)
        || !RELATION_STATUSES.has(item.status)
        || typeof item.confidence !== 'number'
        || !Number.isFinite(item.confidence)
        || item.confidence < 0
        || item.confidence > 1
        || !finiteTimestamp(item.last_seen_at)
        || !nonNegativeInteger(item.evidence_count)) throw invalid()
      return Object.freeze({
        source_logical_id: item.source_logical_id,
        target_logical_id: item.target_logical_id,
        relation_type: item.relation_type,
        confidence: item.confidence,
        status: item.status,
        last_seen_at: item.last_seen_at,
        evidence_count: item.evidence_count,
      })
    })

    return Object.freeze({
      type: 'workspace_graph.board',
      request_id: value.request_id,
      availability: value.availability,
      publication_revision: value.publication_revision,
      omitted: Object.freeze({...value.omitted}),
      logical_workspaces: Object.freeze(logicalWorkspaces),
      workspace_instances: Object.freeze(workspaceInstances),
      relations: Object.freeze(relations),
    })
  } catch {
    return null
  }
}

export function boardTabForKey(activeTab, key) {
  if (key === 'Home') return 'memory'
  if (key === 'End') return 'graph'
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return activeTab === 'memory' ? 'graph' : 'memory'
  }
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return activeTab === 'memory' ? 'graph' : 'memory'
  }
  return null
}

export function renderWorkspaceGraphBoard(payload, {document, root, status}) {
  root.replaceChildren()
  status.replaceChildren()
  if (payload.availability === 'disabled') {
    status.textContent = '图谱未启用'
    root.append(message(document, '当前未启用 Workspace Graph。', 'graph-empty'))
    return
  }

  if (payload.availability === 'degraded') {
    status.append(
      badge(document, '已降级', 'badge-degraded'),
      badge(document, '数据可能已过期', 'badge-stale'),
    )
  } else {
    status.textContent = `图谱版本 ${payload.publication_revision}`
  }

  const omitted = payload.omitted.logical_workspaces
    + payload.omitted.workspace_instances
    + payload.omitted.relations
  if (omitted > 0) {
    root.append(message(
      document,
      `为保持轻量，省略 ${omitted} 项（项目 ${payload.omitted.logical_workspaces}、实例 ${payload.omitted.workspace_instances}、关联 ${payload.omitted.relations}）。`,
      'graph-omitted',
    ))
  }

  if (payload.logical_workspaces.length === 0) {
    root.append(message(document, '暂无关联项目。', 'graph-empty'))
    return
  }

  const names = new Map(payload.logical_workspaces.map(item => (
    [item.logical_workspace_id, item.display_name]
  )))
  const instances = new Map(payload.logical_workspaces.map(item => (
    [item.logical_workspace_id, []]
  )))
  for (const instance of payload.workspace_instances) {
    instances.get(instance.logical_workspace_id).push(instance)
  }

  const nodes = document.createElement('section')
  nodes.className = 'graph-nodes'
  const heading = document.createElement('h2')
  heading.textContent = '项目与实例'
  nodes.append(heading)
  for (const workspace of payload.logical_workspaces) {
    const article = document.createElement('article')
    article.className = 'graph-node'
    const title = document.createElement('h3')
    title.textContent = workspace.display_name
    article.append(title)
    for (const instance of instances.get(workspace.logical_workspace_id)) {
      const row = document.createElement('p')
      row.className = 'graph-instance'
      const name = document.createElement('span')
      name.textContent = instance.display_name
      row.append(name, badge(
        document,
        instance.active ? '活跃' : '非活跃',
        instance.active ? 'badge-active' : 'badge-inactive',
      ))
      article.append(row)
    }
    nodes.append(article)
  }
  root.append(nodes)

  const edges = document.createElement('section')
  edges.className = 'graph-relations'
  const edgeHeading = document.createElement('h2')
  edgeHeading.textContent = `关联（${payload.relations.length}）`
  edges.append(edgeHeading)
  if (payload.relations.length === 0) {
    edges.append(message(document, '暂无关联。', 'graph-empty'))
  }
  for (const relation of payload.relations) {
    const article = document.createElement('article')
    article.className = 'graph-relation'
    const title = document.createElement('h3')
    title.textContent = `${names.get(relation.source_logical_id)} → ${names.get(relation.target_logical_id)}`
    const meta = document.createElement('p')
    meta.className = 'graph-relation-meta'
    const relationName = document.createElement('span')
    relationName.textContent = relationLabel(relation.relation_type)
    const confidence = document.createElement('span')
    confidence.textContent = `置信度 ${Math.round(relation.confidence * 100)}%`
    const evidence = document.createElement('span')
    evidence.textContent = `${relation.evidence_count} 条证据`
    meta.append(
      relationName,
      badge(
        document,
        relation.status === 'weak' ? '弱关联' : '有效',
        relation.status === 'weak' ? 'badge-weak' : 'badge-active',
      ),
      confidence,
      evidence,
    )
    article.append(title, meta)
    edges.append(article)
  }
  root.append(edges)
}

export function createGraphTabController({request, visible, render, failure}) {
  let active = false
  let inFlight = null

  async function refresh() {
    if (!active || !visible()) return
    if (inFlight) return inFlight
    inFlight = Promise.resolve().then(request).then(value => {
      const parsed = parseWorkspaceGraphBoardPayload(value)
      if (parsed === null) failure('invalid')
      else render(parsed)
    }, () => { failure('unavailable') }).finally(() => { inFlight = null })
    return inFlight
  }

  return Object.freeze({
    activate() { active = true; return refresh() },
    deactivate() { active = false },
    refresh,
    tick: refresh,
  })
}

function message(document, text, className) {
  const element = document.createElement('p')
  element.className = className
  element.textContent = text
  return element
}

function badge(document, text, className) {
  const element = document.createElement('span')
  element.className = `graph-badge ${className}`
  element.textContent = text
  return element
}

function relationLabel(type) {
  return ({
    depends_on: '依赖',
    sibling_of: '同类项目',
    replaces: '替代',
    shares_runtime: '共享运行时',
    discussed_with: '共同讨论',
  })[type]
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw invalid()
}

function boundedArray(value, maximum) {
  return Array.isArray(value) && value.length <= maximum
}

function identifier(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && [...value].length <= MAX_ID_CODE_POINTS
    && !hasUnpairedSurrogate(value)
}

function displayName(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && [...value].length <= MAX_NAME_CODE_POINTS
    && !hasUnpairedSurrogate(value)
}

function finiteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true
  }
  return false
}

function invalid() { return new TypeError('invalid workspace graph board payload') }
