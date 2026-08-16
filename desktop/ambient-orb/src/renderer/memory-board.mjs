const channelsRoot = document.querySelector('#channels')
const statusLabel = document.querySelector('#status')
const refreshButton = document.querySelector('#refresh')
const exportButton = document.querySelector('#export')

let latestPayload = null
let inFlight = false
let exportInFlight = false

function itemContent(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return String(raw)
  }
}

function renderItem(item) {
  const article = document.createElement('article')
  article.className = 'item'
  const meta = document.createElement('div')
  meta.className = 'meta'
  const trust = document.createElement('span')
  trust.className = `trust-${item.trust}`
  trust.textContent = item.trust
  const seq = document.createElement('span')
  seq.textContent = `#${item.seq}`
  const ts = document.createElement('span')
  ts.textContent = `t=${Number(item.ts).toFixed(1)}s`
  meta.append(seq, trust, ts)
  if (item.outcome) {
    const outcome = document.createElement('span')
    outcome.textContent = item.outcome
    meta.append(outcome)
  }
  if (item.truncated) {
    const truncated = document.createElement('span')
    truncated.textContent = '（已截断）'
    meta.append(truncated)
  }
  const content = document.createElement('pre')
  content.textContent = itemContent(item.content)
  article.append(meta, content)
  return article
}

function renderChannel(channel) {
  const section = document.createElement('section')
  section.className = 'channel'
  const title = document.createElement('h2')
  const shown = channel.items.length
  const suffix = channel.item_count > shown ? `（显示最近 ${shown} / ${channel.item_count} 条）` : `（${channel.item_count} 条）`
  title.textContent = `${channel.name}${suffix}`
  section.append(title)
  if (channel.summary) {
    const summary = document.createElement('p')
    summary.className = 'summary'
    summary.textContent = channel.summary
    section.append(summary)
  }
  if (!channel.items.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = '暂无记录'
    section.append(empty)
  }
  for (const item of channel.items) section.append(renderItem(item))
  return section
}

async function load() {
  if (inFlight) return
  inFlight = true
  statusLabel.textContent = '加载中…'
  refreshButton.disabled = true
  try {
    const payload = await window.novaAudioAgentDesktop.memoryBoard.request()
    if (!payload || payload.error || !Array.isArray(payload.channels)) {
      statusLabel.textContent = payload?.error === 'timeout' ? '后端无响应' : '加载失败'
      return
    }
    latestPayload = payload
    exportButton.disabled = exportInFlight
    channelsRoot.replaceChildren(...payload.channels.map(renderChannel))
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
    })
    if (result?.saved) statusLabel.textContent = `已导出：${result.saved}`
    else if (result?.error) statusLabel.textContent = '导出失败'
  } catch {
    statusLabel.textContent = '导出失败'
  } finally {
    exportInFlight = false
    exportButton.disabled = false
  }
}

refreshButton.addEventListener('click', () => { void load() })
exportButton.addEventListener('click', () => { void exportBoard() })
setInterval(() => {
  if (document.hidden) return
  void load()
}, 2000)
void load()
