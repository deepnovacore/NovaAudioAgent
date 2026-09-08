const LABELS = {search: '搜索', camera: '相机与 Vision', coding: 'Coding', knowledge: '知识库'}
const PRESET = {url: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp', tool: 'bailian_web_search', headers: {authorization: 'Bearer ${DASHSCOPE_API_KEY}'}}
const DEFAULT_TOOL = {enabled: false, timeoutMs: 8000, maxResultBytes: 32768, maxCallsPerTurn: 2}
const node = (tag, text, parent) => {const element = document.createElement(tag); if (text) element.textContent = text; parent?.append(element); return element}

/** Native controls over the existing controller's one draft; probe metadata never enables a tool. */
export function createCapabilitiesEditor({root, stateLabel, problemsLabel, stage, probe}) {
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
    wrapper.className = 'field'
    node('span', label, wrapper)
    const input = node(options ? 'select' : multiline ? 'textarea' : 'input', '', wrapper)
    input.dataset.field = label
    input.setAttribute('aria-label', label)
    if (options) for (const option of options) {const item = node('option', option, input); item.value = option}
    else if (!multiline) input.type = type
    if (type === 'checkbox') input.checked = value === true
    else input.value = value ?? ''
    if (min !== undefined) input.min = min
    if (max !== undefined) input.max = max
    input.addEventListener('change', () => {
      if (!input.checkValidity()) {input.reportValidity(); return}
      try { change(type === 'checkbox' ? input.checked : type === 'number' ? Number(input.value) : input.value) } catch { problemsLabel.hidden = false; problemsLabel.textContent = '字段格式无效，请检查每行 key=${ENV}。' }
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
  function render(view) {
    current = view
    const state = view.capabilities ?? {}
    const running = state.runtime
    const exact = running?.toolCount == null ? '待后端完成编译' : `${running.toolCount}/${running.toolBudget}`
    stateLabel.textContent = `编辑：草稿 · 磁盘版本 ${state.diskGeneration ?? 0} · 运行版本 ${running?.state === 'running' ? running.diskGeneration : '—'} · 编译版本 ${running?.diskGeneration ?? '—'} · 前台工具 ${exact}${running?.state === 'startup_failed' ? '（启动失败）' : ''}。磁盘解析搜索：${state.status?.modules?.search?.provider ?? '待校验'}。${state.status?.overrides?.length ? '环境变量覆盖：' + state.status.overrides.join(', ') : ''}`
    problemsLabel.textContent = (state.problems ?? []).join(' · ')
    problemsLabel.hidden = !problemsLabel.textContent
    if (view.capabilitiesDocument === null) {
      signature = ''
      root.replaceChildren()
      if (typeof view.capabilitiesRevision !== 'string') {
        node('p', '注册表无法安全显示，请在本机修正文件，凭据改用 ${ENV} 引用。' + (state.path ?? ''), root)
        return
      }
    }
    const doc = view.capabilitiesDocument ?? {version: 1}
    const nextSignature = JSON.stringify([doc, state.runtime?.servers, state.status?.servers])
    if (signature === nextSignature) return
    signature = nextSignature
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.field : null
    const opened = new Set([...root.querySelectorAll('details[open]')].map(item => item.dataset.server))
    root.replaceChildren()
    if (view.capabilitiesDocument === null) node('p', '注册表无法安全显示；修改下方草稿并保存可替换该文件，凭据改用 ${ENV} 引用。' + (state.path ?? ''), root)
    const modules = doc.modules ?? {}
    for (const [name, label] of Object.entries(LABELS)) {
      field(root, label, modules[name]?.enabled ?? name !== 'knowledge', enabled => update(next => {
        next.modules ??= {}; next.modules[name] = {...next.modules[name], enabled}
      }), {type: 'checkbox'})
    }
    field(root, '知识库对 Codex 开放', modules.knowledge?.exposeToCodex ?? false, exposeToCodex => update(next => {next.modules ??= {}; next.modules.knowledge = {...next.modules.knowledge, exposeToCodex}}), {type: 'checkbox'})
    field(root, '前台工具预算上限', doc.frontbrainToolBudget ?? 24, value => update(next => {next.frontbrainToolBudget = value}), {type: 'number', min: 1, max: 256})
    const search = node('fieldset', '', root); node('legend', '搜索连接', search)
    const changeSearch = patch => update(next => {next.modules ??= {}; next.modules.search = {...next.modules.search, ...patch}})
    field(search, '搜索 provider', modules.search?.provider ?? 'tavily', provider => changeSearch({provider}), {options: ['tavily', 'mcp']})
    if (modules.search?.provider === 'mcp') {
      const mcp = modules.search.mcp ?? PRESET
      const changeMcp = patch => changeSearch({mcp: {...mcp, ...patch}})
      node('p', '百炼预设需 DashScope 凭据；真实接入验证尚未完成，默认搜索仍为 Tavily。', search).className = 'hint'
      button(search, '使用百炼 WebSearch 预设', () => changeSearch({mcp: structuredClone(PRESET)}))
      field(search, 'MCP URL', mcp.url, url => changeMcp({url}))
      field(search, '原始搜索工具名', mcp.tool, tool => changeMcp({tool}))
      mapping(search, '搜索 Headers（每行 key=${ENV}）', mcp.headers, headers => changeMcp({headers}))
      button(search, '检测搜索连接（仅 tools/list）', () => runProbe('$search')).disabled = probeBusy
      node('p', probes.get('$search')?.status ?? '未检测', search)
    }
    node('p', '外部工具可能产生副作用。新服务器默认仅对 Codex 开放；启用前台工具需显式选择。调用次数与结果字节限制适用于前台；Codex 使用其上下文与原生超时。', root).className = 'hint'
    const statuses = running?.servers ?? state.status?.servers ?? []
    for (const [name, server] of Object.entries(doc.mcpServers ?? {})) {
      const details = node('details', '', root); details.dataset.server = name; details.open = opened.has(name)
      if (!server || typeof server !== 'object' || Array.isArray(server)) {
        node('summary', `${name} · failed（配置格式无效）`, details)
        button(details, '删除无效服务器', () => update(next => {delete next.mcpServers[name]}))
        continue
      }
      const status = statuses.find(item => item.name === name)
      node('summary', `${name} · ${server.enabled === false ? 'disabled' : status?.status ?? 'configured'}${status?.codex ? ' · Codex ' + status.codex.status : ''}`, details)
      if (status?.reason || status?.codex?.reason) node('p', [status.reason, status.codex?.reason].filter(Boolean).join(' · '), details)
      const change = patch => update(next => {next.mcpServers[name] = {...next.mcpServers[name], ...patch}})
      field(details, `${name} 启用`, server.enabled ?? true, enabled => change({enabled}), {type: 'checkbox'})
      field(details, `${name} 传输`, server.transport ?? 'streamable-http', transport => update(next => {
        const previous = next.mcpServers[name]
        const {url, headers, command, args, env, ...common} = previous
        next.mcpServers[name] = {...common, transport, ...(transport === 'stdio' ? {command: 'node', args: [], env: {}} : {url: 'https://example.com/mcp', headers: {}})}
      }), {options: ['streamable-http', 'stdio']})
      if (server.transport === 'stdio') {
        field(details, `${name} 命令`, server.command, command => change({command}))
        field(details, `${name} 参数（每行一项）`, (server.args ?? []).join('\n'), args => change({args: args ? args.split('\n') : []}), {multiline: true})
        mapping(details, `${name} Env（每行 KEY=\${ENV}）`, server.env, env => change({env}))
      } else {
        field(details, `${name} URL`, server.url, url => change({url}))
        mapping(details, `${name} Headers（每行 key=\${ENV}）`, server.headers, headers => change({headers}))
      }
      for (const consumer of ['frontbrain', 'codex']) field(details, `${name} 对 ${consumer} 开放`, server.exposeTo?.[consumer] ?? consumer === 'codex', enabled => change({exposeTo: {...{frontbrain: false, codex: true}, ...server.exposeTo, [consumer]: enabled}}), {type: 'checkbox'})
      button(details, '检测连接与工具（仅 tools/list）', () => runProbe(name)).disabled = probeBusy
      const discovered = probes.get(name)
      node('p', discovered ? `上次检测 ${discovered.status}${discovered.reason ? ' · ' + discovered.reason : ''} · 修改连接后请重新检测` : '尚未检测连接', details)
      const allTools = new Set([...Object.keys(server.tools ?? {}), ...(discovered?.tools ?? []).map(tool => tool.name)])
      for (const toolName of allTools) {
        const tool = server.tools?.[toolName] ?? DEFAULT_TOOL
        const toolBox = node('fieldset', '', details); node('legend', toolName, toolBox)
        const metadata = discovered?.tools?.find(item => item.name === toolName)
        if (metadata) node('p', `${metadata.readOnlyHint ? '声明只读' : '未声明只读'} · ${metadata.description}`, toolBox)
        const changeTool = patch => change({tools: {...server.tools, [toolName]: {...tool, ...patch}}})
        field(toolBox, `${name}/${toolName} 允许调用`, tool.enabled, enabled => changeTool({enabled}), {type: 'checkbox'})
        for (const [key, label, max] of [['timeoutMs', '超时 ms', 60000], ['maxResultBytes', '结果字节', 1048576], ['maxCallsPerTurn', '每轮次数', 32]]) {
          field(toolBox, `${toolName} ${label}`, tool[key], value => changeTool({[key]: value}), {type: 'number', min: 1, max})
        }
      }
      const toolName = field(details, `${name} 添加原始工具名`, '', () => {})
      button(details, '添加工具（默认不启用）', () => {
        if (toolName.value && !Object.hasOwn(server.tools ?? {}, toolName.value)) change({tools: {...server.tools, [toolName.value]: {...DEFAULT_TOOL}}})
      })
      button(details, '删除服务器', () => update(next => {delete next.mcpServers[name]}))
    }
    const newName = field(root, '新服务器名称（小写字母、数字、下划线）', '', () => {})
    button(root, '添加外部 MCP 服务器', () => {
      if (!/^[a-z][a-z0-9_]{0,31}$/u.test(newName.value) || ['nova_camera', 'nova_knowledge'].includes(newName.value)
        || Object.hasOwn(doc.mcpServers ?? {}, newName.value) || Object.keys(doc.mcpServers ?? {}).length >= 8) {
        problemsLabel.hidden = false; problemsLabel.textContent = '名称无效、重复或服务器数量已达 8。'; return
      }
      const name = newName.value
      opened.add(name)
      update(next => {next.mcpServers ??= {}; next.mcpServers[name] = {enabled: false, transport: 'streamable-http', url: 'https://example.com/mcp', headers: {}, tools: {}, exposeTo: {frontbrain: false, codex: true}}})
      const added = [...root.querySelectorAll('details')].find(item => item.dataset.server === name)
      if (added) added.open = true
    })
    if (focused) [...root.querySelectorAll('[data-field]')].find(item => item.dataset.field === focused)?.focus()
  }
  return {render}
}
