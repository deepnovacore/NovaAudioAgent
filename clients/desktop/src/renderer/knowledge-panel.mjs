import {onButton} from './button-action.mjs'
import {t} from './locale.mjs'
export function createKnowledgePanel({document, action}) {
  const node = name => document.querySelector(`#knowledge-${name}`)
  const controls = ['files', 'folder', 'refresh', 'add-url'].map(node)
  let enabled = false, busy = false, epoch = 0, provider = ''
  const element = (tag, text) => {const value = document.createElement(tag); value.textContent = text; return value}
  async function run(input) {
    if (!enabled || busy) return
    if (['files', 'folder', 'url', 'reindex'].includes(input.action)) {
      // Consent belongs to this explicit import/reindex action, never background refresh.
      input = {...input, consent: true}
    }
    const revision = epoch
    busy = true
    controls.forEach(value => {value.disabled = true})
    node('status').textContent = t("处理中…")
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
        for (const [name, label] of [['reindex', t("重建索引")], ['remove', t("移除")]]) {
          const button = element('button', label)
          button.type = 'button'
          onButton(button, () => run({action: name, id: source.id}))
          row.append(button)
        }
        node('sources').append(row)
      }
      const failed = (state.jobs ?? []).filter(job => job.state === 'failed').length
      const search = state.fts === false ? t("；FTS5 不可用，已使用基础词法匹配（无相关性排序）。") : state.fts === true ? t("；FTS5 已启用。") : ''
      node('status').textContent = t("{0} 个来源{1}{2}", state.sources?.length ?? 0, search, failed ? t("；{0} 个失败任务，请检查文件格式、敏感内容或服务连接后重试。", failed) : '')
    } catch {if (revision === epoch) node('status').textContent = t("知识库操作失败；请确认模块已启用、后端正在运行，或检查文档与服务连接。")}
    finally {busy = false; controls.forEach(value => {value.disabled = !enabled})}
  }
  onButton(node('files'), () => run({action: 'files'}))
  onButton(node('folder'), () => run({action: 'folder'}))
  onButton(node('refresh'), () => run({action: 'status'}))
  onButton(node('add-url'), () => run({action: 'url', url: node('url').value}))
  return {render(view) {
    const next = view.capabilities?.runtime?.modules?.knowledge?.enabled === true
    const nextProvider = JSON.stringify([view.embeddingProvider, view.embeddingModel, view.modelBaseUrl])
    if (next !== enabled || nextProvider !== provider) {
      epoch++; node('sources').replaceChildren(); node('status').textContent = t("点击刷新查看知识库。")
    }
    enabled = next; provider = nextProvider
    node('panel').hidden = !enabled
    controls.forEach(value => {value.disabled = !enabled || busy})
  }}
}
