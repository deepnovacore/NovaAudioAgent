import {
  boardTabForKey,
  createGraphTabController,
  renderWorkspaceGraphBoard,
} from './workspace-graph-board.mjs'

const channelsRoot = document.querySelector('#channels')
const statusLabel = document.querySelector('#status')
const refreshButton = document.querySelector('#refresh')
const exportButton = document.querySelector('#export')
const memoryTab = document.querySelector('#memory-tab')
const diagnosticsTab = document.querySelector('#diagnostics-tab')
const graphTab = document.querySelector('#graph-tab')
const memoryPanel = document.querySelector('#memory-panel')
const diagnosticsPanel = document.querySelector('#diagnostics-panel')
const graphPanel = document.querySelector('#graph-panel')
const diagnosticsRoot = document.querySelector('#diagnostics')
const graphRoot = document.querySelector('#workspace-graph')
const graphState = document.querySelector('#graph-state')

let latestPayload = null
let inFlight = false
let exportInFlight = false
let activeTab = 'memory'

function itemContent(raw) {
  try {
    return JSON.stringify(typeof raw === 'string' ? JSON.parse(raw) : raw, null, 2)
  } catch {
    return String(raw)
  }
}

function boardTime(item) {
  return `t=${Number(item.ts).toFixed(1)}s`
}

function renderItem(item) {
  const article = document.createElement('article')
  article.className = 'item'
  const meta = document.createElement('div')
  meta.className = 'meta'
  const trust = document.createElement('span')
  trust.className = `tag tag-trust trust-${item.trust}`
  trust.textContent = item.trust
  const seq = document.createElement('span')
  seq.className = 'item-ref'
  seq.textContent = `#${item.seq}`
  const ts = document.createElement('span')
  ts.className = 'item-time'
  ts.textContent = boardTime(item)
  meta.append(seq, trust, ts)
  if (item.outcome) {
    const outcome = document.createElement('span')
    outcome.className = 'tag tag-outcome'
    outcome.textContent = item.outcome
    meta.append(outcome)
  }
  if (item.truncated) {
    const truncated = document.createElement('span')
    truncated.className = 'tag tag-truncated'
    truncated.textContent = '已截断'
    meta.append(truncated)
  }
  const content = document.createElement('pre')
  content.textContent = itemContent(item.content)
  article.append(meta, content)
  return article
}

function renderChannel(channel, index) {
  const section = document.createElement('section')
  section.className = 'channel-card'
  const header = document.createElement('header')
  header.className = 'channel-header'
  const title = document.createElement('h2')
  title.id = `memory-channel-${index}`
  section.setAttribute('aria-labelledby', title.id)
  const shown = channel.items.length
  title.textContent = channel.name
  const count = document.createElement('span')
  count.className = 'channel-count'
  count.textContent = channel.item_count > shown ? `${shown} / ${channel.item_count}` : String(channel.item_count)
  count.setAttribute('aria-label', channel.item_count > shown
    ? `显示最近 ${shown} 条，共 ${channel.item_count} 条`
    : `共 ${channel.item_count} 条`)
  header.append(title, count)

  const summary = document.createElement('p')
  summary.className = 'channel-summary'
  summary.textContent = channel.summary || '尚未生成频道摘要'

  const itemsRoot = document.createElement('div')
  itemsRoot.className = 'channel-items'
  if (!channel.items.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = '暂无记录'
    itemsRoot.append(empty)
  }
  for (const item of channel.items) itemsRoot.append(renderItem(item))
  section.append(header, summary, itemsRoot)
  return section
}

function renderDiagnostic(record) {
  const article = document.createElement('article')
  article.className = 'diagnostic-record'
  const header = document.createElement('header')
  const kind = document.createElement('strong')
  kind.textContent = record.kind
  const timestamp = document.createElement('span')
  timestamp.textContent = boardTime(record)
  header.append(kind, timestamp)
  const payload = document.createElement('pre')
  payload.textContent = JSON.stringify(record.payload, null, 2)
  article.append(header, payload)
  return article
}

function validDiagnostics(payload) {
  return payload?.diagnostics?.version === 1
    && Array.isArray(payload.diagnostics.records)
    && payload.diagnostics.records.length <= 128
    && payload.diagnostics.records.every(record => (
      record
      && Number.isFinite(record.ts)
      && typeof record.kind === 'string'
      && record.payload
      && typeof record.payload === 'object'
      && !Array.isArray(record.payload)
    ))
}

async function load() {
  if (activeTab === 'graph') return
  if (inFlight) return
  inFlight = true
  statusLabel.textContent = '加载中…'
  refreshButton.disabled = true
  try {
    const payload = await window.novaAudioAgentDesktop.memoryBoard.request()
    if (!payload || payload.error || !Array.isArray(payload.channels) || !validDiagnostics(payload)) {
      statusLabel.textContent = payload?.error === 'timeout' ? '后端无响应' : '加载失败'
      return
    }
    latestPayload = payload
    exportButton.disabled = exportInFlight || activeTab === 'graph'
    channelsRoot.replaceChildren(...payload.channels.map(renderChannel))
    diagnosticsRoot.replaceChildren(...payload.diagnostics.records.map(renderDiagnostic))
    if (payload.diagnostics.records.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '暂无诊断记录'
      diagnosticsRoot.append(empty)
    }
    statusLabel.textContent = `更新于 ${new Date().toLocaleTimeString()}`
  } catch {
    statusLabel.textContent = '加载失败'
  } finally {
    refreshButton.disabled = false
    inFlight = false
  }
}

async function exportBoard() {
  if (!latestPayload || exportInFlight) return
  exportInFlight = true
  exportButton.disabled = true
  try {
    const result = await window.novaAudioAgentDesktop.memoryBoard.export({
      channels: latestPayload.channels,
      diagnostics: latestPayload.diagnostics,
    })
    if (result?.saved) statusLabel.textContent = `已导出：${result.saved}`
    else if (result?.error) statusLabel.textContent = '导出失败'
  } catch {
    statusLabel.textContent = '导出失败'
  } finally {
    exportInFlight = false
    exportButton.disabled = activeTab === 'graph'
  }
}

const graphController = createGraphTabController({
  request: () => window.novaAudioAgentDesktop.graphBoard.request(),
  visible: () => !document.hidden,
  render: payload => {
    renderWorkspaceGraphBoard(payload, {
      document,
      root: graphRoot,
      status: graphState,
    })
    statusLabel.textContent = `更新于 ${new Date().toLocaleTimeString()}`
  },
  failure: reason => {
    graphRoot.replaceChildren()
    graphState.textContent = reason === 'unavailable' ? '后端无响应' : '图谱数据无效'
    statusLabel.textContent = '加载失败'
  },
})

function selectTab(tab) {
  activeTab = tab
  const graphActive = activeTab === 'graph'
  const diagnosticsActive = activeTab === 'diagnostics'
  const tabElements = {memory: memoryTab, diagnostics: diagnosticsTab, graph: graphTab}
  for (const [name, element] of Object.entries(tabElements)) {
    element.setAttribute('aria-selected', String(name === activeTab))
    element.tabIndex = name === activeTab ? 0 : -1
  }
  memoryPanel.hidden = activeTab !== 'memory'
  diagnosticsPanel.hidden = !diagnosticsActive
  graphPanel.hidden = !graphActive
  exportButton.hidden = activeTab === 'graph'
  exportButton.disabled = graphActive || exportInFlight || latestPayload === null
  if (graphActive) void graphController.activate()
  else {
    graphController.deactivate()
    void load()
  }
}

memoryTab.addEventListener('click', () => { selectTab('memory') })
diagnosticsTab.addEventListener('click', () => { selectTab('diagnostics') })
graphTab.addEventListener('click', () => { selectTab('graph') })
function handleTabKey(event) {
  const nextTab = boardTabForKey(activeTab, event.key)
  if (nextTab === null) return
  event.preventDefault()
  selectTab(nextTab)
  const tabElements = {memory: memoryTab, diagnostics: diagnosticsTab, graph: graphTab}
  const nextElement = tabElements[nextTab]
  nextElement.focus()
}
memoryTab.addEventListener('keydown', handleTabKey)
diagnosticsTab.addEventListener('keydown', handleTabKey)
graphTab.addEventListener('keydown', handleTabKey)
refreshButton.addEventListener('click', () => {
  if (activeTab === 'graph') void graphController.refresh()
  else void load()
})
exportButton.addEventListener('click', () => { void exportBoard() })
setInterval(() => {
  if (document.hidden) return
  if (activeTab === 'graph') void graphController.tick()
  else void load()
}, 2000)
selectTab('memory')
