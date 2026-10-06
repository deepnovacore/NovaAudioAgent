import {t} from './locale.mjs'
const PRESET = {url: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp', tool: 'bailian_web_search', headers: {authorization: 'Bearer ${DASHSCOPE_API_KEY}'}}
const DESCRIPTIONS = {[t("搜索")]: t("查找网络信息，为回答补充资料"), [t("视觉监控")]: t("观察摄像头画面，在符合条件时通知你"), [t("编程")]: t("执行编程任务与项目操作"), [t("知识库")]: t("检索已导入的本地资料"), [t("向编程执行器开放知识库")]: t("允许编程执行器检索已导入的资料")}
const DEFAULT_TOOL = {enabled: false, timeoutMs: 8000, maxResultBytes: 32768, maxCallsPerTurn: 2}
const node = (tag, text, parent) => {const element = document.createElement(tag); if (text) element.textContent = text; parent?.append(element); return element}
// Why the running module is off or switched: only the bounded runtime reasons reach this far.
export function moduleStatusNote(module) {
  const key = /^missing_environment:([A-Z][A-Z0-9_]{0,63})$/u.exec(module?.reason ?? '')?.[1]
  if (module?.fallback === 'bailian_mcp') return key ? t("未配置 {0}，改用百炼联网搜索", key) : t("改用百炼联网搜索")
  if (module?.enabled === false && key) return t("未配置 · 需要 {0}", key)
  return ''
}

/** Native controls over the existing controller's one draft; probe metadata never enables a tool. */
export function createCapabilitiesEditor({root, cameraRoot, codingRoot, problemsLabel, stage, probe}) {
  let current
  let signature = ''
  const probes = new Map()
  let probeBusy = false
  function update(change) {
    const next = structuredClone(current.capabilitiesDocument ?? {version: 1})
    change(next)
    stage({capabilitiesDocument: next})
  }
  function field(parent, label, value, change, {type = 'text', options, min, max, multiline = false} = {}) {
    const wrapper = node('label', '', parent)
    wrapper.className = type === 'checkbox' ? 'field checkbox-field' : 'field'
    const copy = node('span', label, wrapper)
    if (type === 'checkbox') {
      copy.className = 'switch-copy'
      if (DESCRIPTIONS[label]) node('span', DESCRIPTIONS[label], copy).className = 'switch-description'
    }
    const input = node(options ? 'select' : multiline ? 'textarea' : 'input', '', wrapper)
    input.dataset.field = label
    input.setAttribute('aria-label', label)
    if (options) for (const option of options) {const item = node('option', option, input); item.value = option}
    else if (!multiline) input.type = type
    if (type === 'checkbox') { input.checked = value === true; input.setAttribute('role', 'switch') }
    else input.value = value ?? ''
    if (min !== undefined) input.min = min
    if (max !== undefined) input.max = max
    input.addEventListener('change', () => {
      if (!input.checkValidity()) {input.reportValidity(); return}
      try { change(type === 'checkbox' ? input.checked : type === 'number' ? Number(input.value) : input.value) } catch { problemsLabel.hidden = false; problemsLabel.textContent = t("字段格式无效，请检查每行 key=${ENV}。") }
    })
    return input
  }
  function button(parent, label, action) {
    const element = node('button', label, parent); element.type = 'button'; element.addEventListener('click', action); return element
  }
  function mapping(parent, label, values, change) {
    field(parent, label, Object.entries(values ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'), text => {
      const entries = text.split('\n').filter(line => line.trim()).map(line => {
        const index = line.indexOf('=')
        if (index < 1) throw Error('invalid mapping')
        return [line.slice(0, index).trim(), line.slice(index + 1)]
      })
      change(Object.fromEntries(entries))
    }, {multiline: true})
  }
  async function runProbe(name) {
    if (probeBusy) return
    probeBusy = true
    probes.set(name, {status: 'checking', tools: []})
    signature = ''; render(current)
    try { probes.set(name, await probe({document: current.capabilitiesDocument, server: name})) }
    catch { probes.set(name, {status: 'failed', reason: 'unavailable', tools: []}) }
    finally {probeBusy = false; signature = ''; render(current)}
  }
  function moduleNote(parent, module) {
    const text = moduleStatusNote(module)
    if (text) node('p', text, parent).className = 'hint module-status'
  }
  function render(view) {
    current = view
    const state = view.capabilities ?? {}
    const running = state.runtime
    problemsLabel.textContent = (state.problems ?? []).join(' · ')
    problemsLabel.hidden = !problemsLabel.textContent
    if (view.capabilitiesDocument === null) {
      signature = ''
      root.replaceChildren()
      cameraRoot.replaceChildren()
      codingRoot.replaceChildren()
      if (typeof view.capabilitiesRevision !== 'string') {
        node('p', t("注册表无法安全显示，请在本机修正文件，凭据改用 ${ENV} 引用。") + (state.path ?? ''), root)
        return
      }
    }
    const doc = view.capabilitiesDocument ?? {version: 1}
    const nextSignature = JSON.stringify([doc, state.runtime?.state, state.runtime?.modules, state.runtime?.servers, state.status?.servers])
    if (signature === nextSignature) return
    signature = nextSignature
    const roots = [root, cameraRoot, codingRoot]
    const focused = roots.some(target => target.contains(document.activeElement)) ? document.activeElement.dataset.field : null
    const opened = new Set([...root.querySelectorAll('details[open]')].map(item => item.dataset.server))
    root.replaceChildren()
    if (view.capabilitiesDocument === null) node('p', t("注册表无法安全显示；修改下方草稿并保存可替换该文件，凭据改用 ${ENV} 引用。") + (state.path ?? ''), root)
    const modules = doc.modules ?? {}
    for (const [name, label, target] of [['camera', t("视觉监控"), cameraRoot], ['coding', t("编程"), codingRoot]]) {
      target.replaceChildren()
      field(target, label, modules[name]?.enabled ?? true, enabled => update(next => {
        next.modules ??= {}; next.modules[name] = {...next.modules[name], enabled}
      }), {type: 'checkbox'})
      moduleNote(target, running?.modules?.[name])
    }
    const searchGroup = node('section', '', root); searchGroup.className = 'mcp-module'; searchGroup.dataset.module = 'search'
    field(searchGroup, t("搜索"), modules.search?.enabled ?? true, enabled => update(next => {next.modules ??= {}; next.modules.search = {...next.modules.search, enabled}}), {type: 'checkbox'})
    moduleNote(searchGroup, running?.modules?.search)
    const search = node('div', '', searchGroup); search.className = 'mcp-module-config'
    const changeSearch = patch => update(next => {next.modules ??= {}; next.modules.search = {...next.modules.search, ...patch}})
    field(search, t("搜索服务"), modules.search?.provider ?? 'tavily', provider => changeSearch({provider}), {options: ['tavily', 'mcp']})
    if (modules.search?.provider === 'mcp') {
      const mcp = modules.search.mcp ?? PRESET
      const changeMcp = patch => changeSearch({mcp: {...mcp, ...patch}})
      node('p', t("百炼预设需 DashScope 凭据；真实接入验证尚未完成，默认搜索仍为 Tavily。"), search).className = 'hint'
      button(search, t("使用百炼 WebSearch 预设"), () => changeSearch({mcp: structuredClone(PRESET)}))
      field(search, t("MCP 地址"), mcp.url, url => changeMcp({url}))
      field(search, t("原始搜索工具名"), mcp.tool, tool => changeMcp({tool}))
      mapping(search, t("搜索请求头（每行 key=${ENV}）"), mcp.headers, headers => changeMcp({headers}))
      const searchProbe=button(search, t("检测搜索连接（仅 tools/list）"), () => runProbe('$search'));searchProbe.disabled=probeBusy;searchProbe.setAttribute('aria-busy',String(probes.get('$search')?.status==='checking'))
      node('p', probes.get('$search')?.status ?? t("未检测"), search)
    }
    const statuses = running?.servers ?? state.status?.servers ?? []
    const knowledge = node('section', '', root); knowledge.className = 'mcp-module'; knowledge.dataset.module = 'knowledge'
    field(knowledge, t("知识库"), modules.knowledge?.enabled ?? false, enabled => update(next => {next.modules ??= {}; next.modules.knowledge = {...next.modules.knowledge, enabled}}), {type: 'checkbox'})
    moduleNote(knowledge, running?.modules?.knowledge)
    const knowledgeConfig = node('div', '', knowledge); knowledgeConfig.className = 'mcp-module-config secondary-toggle'
    field(knowledgeConfig, t("向编程执行器开放知识库"), modules.knowledge?.exposeToCodex ?? false, exposeToCodex => update(next => {next.modules ??= {}; next.modules.knowledge = {...next.modules.knowledge, exposeToCodex}}), {type: 'checkbox'})
    for (const [name, server] of Object.entries(doc.mcpServers ?? {})) {
      const details = node('details', '', root); details.dataset.server = name; details.open = opened.has(name)
      if (!server || typeof server !== 'object' || Array.isArray(server)) {
        node('summary', t("{0} · 配置失败（配置格式无效）", name), details)
        button(details, t("删除无效服务器"), () => update(next => {delete next.mcpServers[name]}))
        continue
      }
      const status = statuses.find(item => item.name === name)
      node('summary', `${name} · ${server.enabled === false ? t("已停用") : ({ready: t("已连接"), configured: t("已配置"), failed: t("连接失败"), disabled: t("已停用")}[status?.status] ?? t("已配置"))}${status?.codex ? ' · Codex ' + status.codex.status : ''}`, details)
      if (status?.reason || status?.codex?.reason) node('p', [status.reason, status.codex?.reason].filter(Boolean).join(' · '), details)
      const change = patch => update(next => {next.mcpServers[name] = {...next.mcpServers[name], ...patch}})
      field(details, t("{0} 启用", name), server.enabled ?? true, enabled => change({enabled}), {type: 'checkbox'})
      field(details, t("{0} 传输", name), server.transport ?? 'streamable-http', transport => update(next => {
        const previous = next.mcpServers[name]
        const {url, headers, command, args, env, ...common} = previous
        next.mcpServers[name] = {...common, transport, ...(transport === 'stdio' ? {command: 'node', args: [], env: {}} : {url: 'https://example.com/mcp', headers: {}})}
      }), {options: ['streamable-http', 'stdio']})
      if (server.transport === 'stdio') {
        field(details, t("{0} 命令", name), server.command, command => change({command}))
        field(details, t("{0} 参数（每行一项）", name), (server.args ?? []).join('\n'), args => change({args: args ? args.split('\n') : []}), {multiline: true})
        mapping(details, t("{0} 环境变量（每行 KEY=${ENV}）", name), server.env, env => change({env}))
      } else {
        field(details, t("{0} 地址", name), server.url, url => change({url}))
        mapping(details, t("{0} 请求头（每行 key=${ENV}）", name), server.headers, headers => change({headers}))
      }
      for (const consumer of ['frontbrain', 'codex']) field(details, t("{0} 对 {1} 开放", name, consumer === 'frontbrain' ? t("前台") : 'Codex'), server.exposeTo?.[consumer] ?? consumer === 'codex', enabled => change({exposeTo: {...{frontbrain: false, codex: true}, ...server.exposeTo, [consumer]: enabled}}), {type: 'checkbox'})
      const serverProbe=button(details, t("检测连接与工具（仅 tools/list）"), () => runProbe(name));serverProbe.disabled=probeBusy;serverProbe.setAttribute('aria-busy',String(probes.get(name)?.status==='checking'))
      const discovered = probes.get(name)
      node('p', discovered ? t("上次检测 {0}{1} · 修改连接后请重新检测", discovered.status, discovered.reason ? ' · ' + discovered.reason : '') : t("尚未检测连接"), details)
      const allTools = new Set([...Object.keys(server.tools ?? {}), ...(discovered?.tools ?? []).map(tool => tool.name)])
      for (const toolName of allTools) {
        const tool = server.tools?.[toolName] ?? DEFAULT_TOOL
        const toolBox = node('fieldset', '', details); node('legend', toolName, toolBox)
        const metadata = discovered?.tools?.find(item => item.name === toolName)
        if (metadata) node('p', `${metadata.readOnlyHint ? t("声明只读") : t("未声明只读")} · ${metadata.description}`, toolBox)
        const changeTool = patch => change({tools: {...server.tools, [toolName]: {...tool, ...patch}}})
        field(toolBox, t("{0}/{1} 允许调用", name, toolName), tool.enabled, enabled => changeTool({enabled}), {type: 'checkbox'})
        for (const [key, label, max] of [['timeoutMs', t("超时 ms"), 60000], ['maxResultBytes', t("结果字节"), 1048576], ['maxCallsPerTurn', t("每轮次数"), 32]]) {
          field(toolBox, `${toolName} ${label}`, tool[key], value => changeTool({[key]: value}), {type: 'number', min: 1, max})
        }
      }
      const toolName = field(details, t("{0} 添加原始工具名", name), '', () => {})
      button(details, t("添加工具（默认不启用）"), () => {
        if (toolName.value && !Object.hasOwn(server.tools ?? {}, toolName.value)) change({tools: {...server.tools, [toolName.value]: {...DEFAULT_TOOL}}})
      })
      button(details, t("删除服务器"), () => update(next => {delete next.mcpServers[name]}))
    }
    if (focused) roots.flatMap(target => [...target.querySelectorAll('[data-field]')]).find(item => item.dataset.field === focused)?.focus()
  }
  return {render}
}
