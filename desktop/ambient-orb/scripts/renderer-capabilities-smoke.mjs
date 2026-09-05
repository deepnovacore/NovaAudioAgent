import assert from 'node:assert/strict'
import {readFile, mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'
import {DEFAULT_SETTINGS, publicSettings} from '../src/main/settings-store.mjs'
import {settingsWindowOptions} from '../src/main/security.mjs'
const {chromium} = await import(process.env.NOVA_PLAYWRIGHT_MODULE || 'playwright')
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.NOVA_RENDERER_SMOKE_OUTPUT || `${root}/build/capabilities-smoke`)
await mkdir(output, {recursive: true})
const browser = await chromium.launch({headless: true, ...(process.env.NOVA_BROWSER_EXECUTABLE ? {executablePath: process.env.NOVA_BROWSER_EXECUTABLE} : {})})
try {
  const context = await browser.newContext({deviceScaleFactor: 1, reducedMotion: 'reduce'})
  await context.route('http://nova.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!/^\/[\w.-]+\.(html|css|mjs)$/.test(path)) return route.abort()
    await route.fulfill({body: await readFile(`${root}/src/renderer${path}`), contentType: path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'})
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(initial => {
    let view = initial, changed
    window.__commits = []
    window.__probeCount = 0
    window.__outcome = 'applied'
    window.__push = patch => {view = {...view, ...patch}; changed?.(view)}
    window.novaAudioAgentDesktop = {settings: {
      get: async () => view,
      onChanged: callback => {changed = callback; return () => {}},
      probeCapabilities: async payload => {
        window.__probeCount++
        return {status: 'ok', tools: [{name: 'lookup.raw', description: 'Fake metadata · tool calls remain disabled.', readOnlyHint: false}]}
      },
      set: async commit => {
        window.__commits.push(commit)
        const outcome = window.__outcome
        if (['busy', 'invalid'].includes(outcome)) return {...view, saved: false, operationStatus: outcome}
        view = {...view, ...commit.settingsPatch, ...(commit.capabilitiesDocument ? {capabilitiesDocument: commit.capabilitiesDocument} : {}), settingsApplyStatus: outcome,
          capabilities: {...view.capabilities, diskGeneration: view.capabilities.diskGeneration + 1}, saved: true, operationStatus: outcome, rejectedSecrets: []}
        return view
      },
    }}
  }, {...publicSettings(DEFAULT_SETTINGS), backendStatus: 'connected', settingsApplyStatus: 'idle', secretsPresent: {}, keyringAvailable: true, codexStatus: {status: 'ready'}, managedWorkspaces: {health: 'ready'},
    capabilitiesDocument: {version: 1, modules: {search: {enabled: true, provider: 'tavily'}}, mcpServers: {}},
    capabilities: {path: '/fake/capabilities.json', diskGeneration: 2, problems: [], status: {modules: {search: {provider: 'tavily'}}, overrides: []}, runtime: {state: 'running', diskGeneration: 2, generation: 1, toolCount: 9, toolBudget: 24, servers: []}}})
  const bounds = settingsWindowOptions(resolve(root, 'src/preload/preload.cjs'), 'smoke')
  await page.setViewportSize({width: bounds.width, height: bounds.height})
  await page.goto('http://nova.test/settings.html')
  await page.getByText('前台工具 9/24', {exact: false}).waitFor()
  assert.equal(await page.locator('#embeddingProvider').inputValue(), 'dashscope')
  assert.equal(await page.locator('#embeddingModel').inputValue(), 'text-embedding-v4')
  await page.getByLabel('搜索 provider', {exact: true}).selectOption('mcp')
  assert.equal(await page.getByLabel('原始搜索工具名', {exact: true}).inputValue(), 'bailian_web_search')
  assert.equal(await page.getByLabel('MCP URL', {exact: true}).inputValue(), 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp')
  await page.getByLabel('搜索 Headers（每行 key=${ENV}）', {exact: true}).fill('authorization=Bearer ${DASHSCOPE_API_KEY}')
  await page.getByLabel('新服务器名称（小写字母、数字、下划线）', {exact: true}).fill('demo')
  await page.getByRole('button', {name: '添加外部 MCP 服务器', exact: true}).click()
  assert.equal(await page.getByLabel('demo 对 frontbrain 开放', {exact: true}).isChecked(), false)
  assert.equal(await page.getByLabel('demo 对 codex 开放', {exact: true}).isChecked(), true)
  await page.getByLabel('demo 启用', {exact: true}).check()
  await page.getByRole('button', {name: '检测连接与工具（仅 tools/list）', exact: true}).click()
  await page.getByLabel('demo/lookup.raw 允许调用', {exact: true}).waitFor()
  assert.equal(await page.getByLabel('demo/lookup.raw 允许调用', {exact: true}).isChecked(), false)
  await page.getByLabel('demo/lookup.raw 允许调用', {exact: true}).check()
  await page.getByLabel('demo 对 frontbrain 开放', {exact: true}).check()
  await page.getByLabel('lookup.raw 超时 ms', {exact: true}).fill('12000')
  await page.getByLabel('lookup.raw 结果字节', {exact: true}).click()
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({path: `${output}/capability-server-draft.png`, fullPage: true})
  await page.getByLabel('demo 传输', {exact: true}).selectOption('stdio')
  await page.getByLabel('demo 命令', {exact: true}).fill('node')
  await page.getByLabel('demo 参数（每行一项）', {exact: true}).fill('/fake/server.mjs')
  await page.getByLabel('demo Env（每行 KEY=${ENV}）', {exact: true}).fill('TOKEN=${DEMO_TOKEN}')
  await page.getByLabel('demo 启用', {exact: true}).click()
  await page.locator('#settings-save').click()
  let commit = await page.evaluate(() => window.__commits.at(-1))
  assert.equal(commit.capabilitiesDocument.mcpServers.demo.transport, 'stdio')
  assert.equal(commit.capabilitiesDocument.mcpServers.demo.url, undefined)
  assert.equal(commit.capabilitiesDocument.mcpServers.demo.tools['lookup.raw'].timeoutMs, 12000)
  assert.equal(commit.settingsPatch.searchProvider, undefined)
  await page.getByRole('button', {name: '删除服务器', exact: true}).click()
  await page.locator('#settings-save').click()
  commit = await page.evaluate(() => window.__commits.at(-1))
  assert.deepEqual(commit.capabilitiesDocument.mcpServers, {})
  for (const [outcome, expected] of [['busy', '另一项操作进行中，草稿未保存'], ['invalid', '配置校验失败，草稿未保存'], ['failed', '已保存·未生效'], ['restart_failed', '已保存·后端未启动']]) {
    await page.evaluate(outcome => {window.__outcome = outcome}, outcome)
    await page.getByLabel('相机与 Vision', {exact: true}).click()
    await page.locator('#settings-save').click()
    assert.equal(await page.locator('#status').textContent(), expected)
  }
  await page.evaluate(() => window.__push({capabilities: {diskGeneration: 7, status: {modules: {search: {provider: 'mcp'}}, overrides: ['NOVA_AUDIO_AGENT_SEARCH_PROVIDER']}, problems: [], runtime: {state: 'startup_failed', diskGeneration: 7, generation: 4, toolCount: 27, toolBudget: 24}}}))
  assert.match(await page.locator('#capabilities-state').textContent(), /27\/24（启动失败）/u)
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({path: `${output}/capability-budget-failure.png`, fullPage: true})
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({moduleToggles: true, preset: true, serverCrud: true, toolAllowlist: true, transportFields: true, saveLattice: true, exactBudget: '27/24', horizontalOverflow: false, pageErrors: errors, screenshots: output}))
} finally {await browser.close()}
