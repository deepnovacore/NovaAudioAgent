export function createKnowledgePanel({document, action}) {
  const node = name => document.querySelector(`#knowledge-${name}`)
  const controls = ['files', 'folder', 'refresh', 'add-url'].map(node)
  let enabled = false, busy = false, epoch = 0, provider = ''
  const element = (tag, text) => {const value = document.createElement(tag); value.textContent = text; return value}
  async function run(input) {
    if (!enabled || busy) return
    if (['files', 'folder', 'url', 'reindex'].includes(input.action)) {
      if (!node('consent').checked) {node('status').textContent = '请先阅读并同意数据流向说明。'; return}
      input = {...input, consent: true}
    }
    const revision = epoch
    busy = true
    controls.forEach(value => {value.disabled = true})
    node('status').textContent = '处理中…'
    try {
      const result = await action(input)
      if (revision !== epoch || !enabled) return
      if (result?.error) throw Error('unavailable')
      const state = input.action === 'status' ? result : await action({action: 'status'})
      if (revision !== epoch || !enabled) return
      if (state?.error) throw Error('unavailable')
      node('sources').replaceChildren()
      for (const source of (state.sources ?? []).slice(0, 100)) {
        const row = element('li', '')
        row.append(element('span', `${source.title} · ${source.status}`))
        for (const [name, label] of [['reindex', '重建索引'], ['remove', '移除']]) {
          const button = element('button', label)
          button.type = 'button'
          button.addEventListener('click', () => run({action: name, id: source.id}))
          row.append(button)
        }
        node('sources').append(row)
      }
      const failed = (state.jobs ?? []).filter(job => job.state === 'failed').length
      node('status').textContent = `${state.sources?.length ?? 0} 个来源${failed ? `；${failed} 个失败任务，请检查文件格式、敏感内容或服务连接后重试。` : ''}`
    } catch {if (revision === epoch) node('status').textContent = '知识库操作失败；请确认模块已启用、后端正在运行，或检查文档与服务连接。'}
    finally {busy = false; controls.forEach(value => {value.disabled = !enabled})}
  }
  node('files').addEventListener('click', () => run({action: 'files'}))
  node('folder').addEventListener('click', () => run({action: 'folder'}))
  node('refresh').addEventListener('click', () => run({action: 'status'}))
  node('add-url').addEventListener('click', () => run({action: 'url', url: node('url').value}))
  return {render(view) {
    const next = view.capabilities?.runtime?.modules?.knowledge?.enabled === true
    const nextProvider = JSON.stringify([view.embeddingProvider, view.embeddingModel, view.modelBaseUrl])
    if (next !== enabled || nextProvider !== provider) {
      epoch++; node('consent').checked = false; node('sources').replaceChildren(); node('status').textContent = '点击刷新查看知识库。'
    }
    enabled = next; provider = nextProvider
    node('panel').hidden = !enabled
    controls.forEach(value => {value.disabled = !enabled || busy})
  }}
}
