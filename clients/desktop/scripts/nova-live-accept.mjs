// Live GUI acceptance of an INSTALLED Nova Audio Agent desktop build.
// Launches the real executable with an isolated profile and drives its real windows through the
// Chromium remote-debugging port: Workbench pages, Settings categories, language control. Screenshots
// are the renderer's own frames. --guided-key-env/--chat explicitly enable real-provider acceptance.
// Usage: node nova-live-accept.mjs --exe <path> --out <dir> [--port 9333] [--env K=V]... [--arg X]... [--tag name]
import {spawn, spawnSync} from 'node:child_process'
import {mkdir, writeFile} from 'node:fs/promises'
import {basename, join} from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'

const opt = {exe: '', out: '', port: 9333, env: {}, args: [], tag: 'run', settingsFirst: false, quick: false, attachDelay: 0, keepEnv: [], chat: '', expect: '', guidedKeyEnv: ''}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--exe') opt.exe = process.argv[++i]
  else if (a === '--out') opt.out = process.argv[++i]
  else if (a === '--port') opt.port = Number(process.argv[++i])
  else if (a === '--tag') opt.tag = process.argv[++i]
  else if (a === '--arg') opt.args.push(process.argv[++i])
  else if (a === '--settings-first') opt.settingsFirst = true
  else if (a === '--quick') opt.quick = true
  else if (a === '--keep-env') opt.keepEnv.push(process.argv[++i])
  else if (a === '--guided-key-env') opt.guidedKeyEnv = process.argv[++i]
  else if (a === '--chat') opt.chat = process.argv[++i]
  else if (a === '--expect') opt.expect = process.argv[++i]
  else if (a === '--attach-delay') opt.attachDelay = Number(process.argv[++i])
  else if (a === '--env') { const [k, ...v] = process.argv[++i].split('='); opt.env[k] = v.join('=') }
  else throw new Error(`unknown argument: ${a}`)
}
if (!opt.exe || !opt.out) throw new Error('--exe and --out are required')
if (!Number.isInteger(opt.port) || opt.port < 1024 || opt.port > 65535) throw new Error('invalid debugging port')
if (opt.chat && !opt.expect) throw new Error('--chat requires --expect')
await mkdir(opt.out, {recursive: true})
const userData = join(opt.out, 'user-data')
await mkdir(userData, {recursive: true})

const privateValues = [process.env[opt.guidedKeyEnv], opt.exe, opt.out, userData, process.env.HOME, process.env.USERPROFILE,
  ...Object.entries({...process.env, ...opt.env}).filter(([name]) => /KEY|TOKEN|SECRET|PASSWORD/iu.test(name)).map(([,value]) => value)]
  .filter(value => typeof value === 'string' && value.length > 3).sort((a,b)=>b.length-a.length)
const safe = value => privateValues.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value))
const report = {platform: `${process.platform}-${process.arch}`, tag: opt.tag, exe: basename(opt.exe), started: new Date().toISOString(), steps: [], windows: [], consoleErrors: [], contextEvents: []}
const step = (name, ok, detail = '') => { detail = safe(detail); report.steps.push({name, ok, detail: detail.slice(0, 300)}); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail.slice(0, 160) : ''}`) }

const pages = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${opt.port}/json/list`, {signal: AbortSignal.timeout(3000)})
    return (await r.json()).filter(t => t.type === 'page')
  } catch { return [] }
}
const waitFor = async (fn, ms, every = 400) => {
  const end = Date.now() + ms
  for (;;) {
    try { const v = await fn(); if (v) return v } catch { /* keep polling */ }
    if (Date.now() > end) return null
    await sleep(every)
  }
}
const connect = target => new Promise((resolve, reject) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const contexts = new Map()
  ws.onmessage = m => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
    else if (d.method === 'Runtime.executionContextCreated') { const context=d.params.context; contexts.set(context.id,context.origin); report.contextEvents.push({window:target.url.split('/').pop(),event:'created',id:context.id,origin:context.origin}) }
    else if (d.method === 'Runtime.executionContextDestroyed') { report.contextEvents.push({window:target.url.split('/').pop(),event:'destroyed',id:d.params.executionContextId}); contexts.delete(d.params.executionContextId) }
    else if (d.method === 'Runtime.exceptionThrown') report.consoleErrors.push(safe(`${target.url.split('/').pop()} context=${contexts.get(d.params.exceptionDetails.executionContextId)??'unknown'}: ${d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text}`).slice(0, 1000))
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') report.consoleErrors.push(safe(`${target.url.split('/').pop()} context=${contexts.get(d.params.executionContextId)??'unknown'}: console.error ${(d.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')}`).slice(0, 1000))
  }
  ws.onerror = reject
  ws.onopen = () => {
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({id: i, method, params})) })
    resolve({send, close: () => ws.close()})
  }
})
const evaluate = async (c, expression) => {
  const r = await c.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true})
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result?.result?.value
}
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', {format: 'png'})
  await writeFile(join(opt.out, `${opt.tag}-${name}.png`), Buffer.from(r.result.data, 'base64'))
}
const attach = async target => { const c = await connect(target); await c.send('Runtime.enable'); await c.send('Page.enable'); return c }

const base = [`--user-data-dir=${userData}`, `--remote-debugging-port=${opt.port}`, ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), ...opt.args]
const env = {...process.env, ...opt.env}
for (const key of ['DASHSCOPE_API_KEY', 'MODEL_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ARK_API_KEY', 'DOUBAO_BIGMODEL_API_KEY', 'TAVILY_API_KEY']) if (!(key in opt.env) && !opt.keepEnv.includes(key)) delete env[key]
if (opt.guidedKeyEnv) delete env[opt.guidedKeyEnv]
const launch = extra => spawn(opt.exe, [...base, ...extra], {env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: false})
const primary = launch(opt.settingsFirst ? ['--open-settings'] : [])
let output = ''
primary.stdout.on('data', c => { output = (output + c).slice(-6000) })
primary.stderr.on('data', c => { output = (output + c).slice(-6000) })
let exitedEarly = false
primary.once('exit', (code, signal) => { exitedEarly = true; report.primaryExit = `${code}/${signal}` })

try {
  const first = await waitFor(async () => (await pages()).length > 0 && await pages(), 60000)
  step('application window appears after launch', !!first, first ? first.map(p => p.url.split('/').pop()).join(', ') : `no page target; process exited=${exitedEarly}; tail=${output.slice(-200)}`)
  if (!first) throw new Error('no window')
  await sleep(4000)

  const all = await pages()
  for (const [index, target] of all.entries()) {
    const c = await attach(target)
    const info = await evaluate(c, `({path: location.pathname.split('/').pop(), title: document.title, ready: document.readyState, lang: document.documentElement.lang, text: (document.body?.innerText ?? '').trim().length})`)
    report.windows.push(info)
    await shot(c, `window${index}-${info.path.replace('.html', '')}`)
    c.close()
  }
  step('every window finished loading with content', report.windows.every(w => w.ready === 'complete' && w.text > 0), JSON.stringify(report.windows.map(w => `${w.path}:${w.ready}:${w.text}`)))

  // First-run guide: type the key into the real window, test it against the provider, start.
  if (opt.guidedKeyEnv) {
    const key = process.env[opt.guidedKeyEnv] ?? ''
    const target = (await pages()).find(t => t.url.includes('setup.html'))
    step('First-run guide window is present', !!target && key.length > 0, target ? 'setup.html' : 'no setup window')
    if (target && key) {
      const c = await attach(target)
      const mode = await evaluate(c, `document.querySelector('input[name="pipeline"]:checked')?.value`)
      step('Guide defaults to the quick-start (integrated) path', mode === 'integrated', `selected: ${mode}`)
      // A real user picks the recommended path; the guide's initial selection is recorded above as a finding.
      await evaluate(c, `document.querySelector('#path-integrated').click()`)
      await sleep(500)
      await evaluate(c, `document.querySelector('#dashscopeApiKey').focus()`)
      await c.send('Input.insertText', {text: key})
      await shot(c, 'guide-key-typed')
      await evaluate(c, `document.querySelector('#integrated-fields .key-row .test').click()`)
      const result = await waitFor(() => evaluate(c, `(() => { const node=document.querySelector('#integrated-fields .key-result'); return node?.dataset.status && {status:node.dataset.status,text:node.textContent.trim()} })()`), 60000, 1000)
      await shot(c, 'guide-key-tested')
      step('Guide tests the key against the provider', result?.status === 'ok', `result: ${result?.status??'timeout'}`)
      if (result?.status !== 'ok') throw new Error('guide key test did not succeed')
      await evaluate(c, `document.querySelector('#start').click()`)
      const closed = await waitFor(async () => !(await pages()).some(t => t.url.includes('setup.html')) && 'closed', 90000, 1000)
      step('Guide saves the key, closes and hands over to the Workbench', !!closed, closed ? '' : 'guide window still open')
      try { c.close() } catch { /* window is gone */ }
      await sleep(3000)
    }
  }

  // Workbench: real clicks through the six pages.
  const wb = (await pages()).find(t => t.url.includes('/index.html')) ?? all.find(t => t.url.includes('/index.html'))
  if (wb && !opt.quick) {
    const c = await attach(wb)
    const count = await waitFor(() => evaluate(c, `document.querySelectorAll('.rail-item[data-page]').length`).then(n => n === 6 && n), 30000)
    step('Workbench shows its six pages in the rail', count === 6, `rail items: ${count}`)
    for (const page of ['todos', 'ideas', 'goals', 'feeds', 'tasks', 'profile']) {
      await evaluate(c, `document.querySelector('.rail-item[data-page="${page}"]')?.click()`)
      await sleep(900)
      const state = await evaluate(c, `({selected: document.querySelector('.rail-item[data-page="${page}"]')?.getAttribute('aria-selected'), text: (document.body.innerText || '').trim().length})`)
      await shot(c, `workbench-${page}`)
      step(`Workbench page "${page}" opens and renders`, state.selected === 'true' && state.text > 0, JSON.stringify(state))
    }
    c.close()
  } else if (!wb) {
    step('Workbench window present (default launch)', false, `windows: ${report.windows.map(w => w.path).join(', ')} (a first-run setup window is expected without credentials)`)
  }

  // Real-credential mode: the backend must come up, Workbench data must load, and a typed question must be answered.
  if (opt.chat && wb) {
    const c = await attach(wb)
    const body = () => evaluate(c, `document.body.innerText`)
    const ready = await waitFor(async () => { const t = await body(); return !t.includes('启动失败') && !t.includes('Backend startup failed') && t.length > 0 && 'ready' }, 90000, 1000)
    step('Backend starts with the real credential (no startup-failure banner)', !!ready, ready ? 'banner gone' : (await body()).slice(0, 160).replace(/\s+/g, ' '))
    await evaluate(c, `document.querySelector('.rail-item[data-page="todos"]')?.click()`)
    const todosLoaded = await waitFor(async () => !(await body()).includes('正在读取已保存的内容') && 'loaded', 40000, 1000)
    await shot(c, 'live-todos')
    step('Todos page finished reading saved content from the backend', !!todosLoaded, todosLoaded ? '' : 'still showing "reading saved content"')
    const answerMatches = () => evaluate(c, `[...document.querySelectorAll('.chat-history .message.assistant:not(.message-feed) .md')].filter(node=>node.textContent.trim()===${JSON.stringify(opt.expect.trim())}).length`)
    const before = await answerMatches()
    await evaluate(c, `(() => { const t = document.querySelector('.composer textarea'); t.focus(); t.select() })()`)
    await c.send('Input.insertText', {text: opt.chat})
    await sleep(500)
    await c.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13})
    await c.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13})
    const answered = await waitFor(async () => await answerMatches() > before && 'answered', 120000, 1500)
    await sleep(1500)
    await shot(c, 'live-chat-reply')
    const pane = await body()
    const tail = pane.replace(/\s+/g, ' ').slice(-260)
    const stableAnswer = answered && await answerMatches() > before
    step(`Nova answers a typed question (expected exactly "${opt.expect}")`, !!stableAnswer, stableAnswer ? `assistant answer: ${opt.expect}` : `no exact answer within 120 s; tail: ${tail}`)
    c.close()
  }

  // Settings: second launch hands over to the running instance (single-instance lock).
  if (!opt.settingsFirst) { const second = launch(['--open-settings']); second.on('error', () => {}) }
  const settings = await waitFor(async () => (await pages()).find(t => t.url.includes('settings.html')), 45000)
  step('Settings window opens on request', !!settings, settings ? 'settings.html' : `pages: ${(await pages()).map(p => p.url.split('/').pop()).join(', ')}`)
  if (settings) {
    if (opt.attachDelay) await sleep(opt.attachDelay)
    const c = await attach(settings)
    const bridge = await evaluate(c, `({api: typeof window.novaAudioAgentDesktop, settings: typeof window.novaAudioAgentDesktop?.settings, get: typeof window.novaAudioAgentDesktop?.settings?.get})`)
    step('Settings preload bridge is present in the window', bridge.api === 'object' && bridge.settings === 'object', JSON.stringify(bridge))
    const nav = await waitFor(() => evaluate(c, `document.querySelectorAll('.nav-item[data-category]').length`).then(n => n === 10 && n), 30000)
    step('Settings cold start loads: ten categories present', nav === 10, `categories: ${nav}`)
    // Informational: without real credentials the backend cannot start, and the UI says so. Record the settled text.
    await sleep(9000)
    const startupText = await evaluate(c, `(document.getElementById('startup-status')?.textContent ?? '').trim()`)
    step('Settings shows an actionable startup status (informational)', true, startupText === '' ? 'status clear' : `status text: "${startupText}"`)
    let previous = ''
    let changed = 0
    const categories = await evaluate(c, `[...document.querySelectorAll('.nav-item[data-category]')].map(b => b.dataset.category)`)
    for (const category of opt.quick ? [] : categories) {
      await evaluate(c, `document.getElementById('category-${category}')?.click()`)
      await sleep(500)
      const state = await evaluate(c, `({current: document.getElementById('category-${category}')?.getAttribute('aria-current'), text: document.querySelector('main')?.innerText.trim() ?? ''})`)
      await shot(c, `settings-${category}`)
      const differs = state.text !== previous
      if (differs) changed++
      previous = state.text
      step(`Settings category "${category}" activates and shows its section`, state.current === 'true' && state.text.length > 0, `visible text chars: ${state.text.length}`)
      if (opt.chat && category === 'connections') {
        await sleep(2500)
        const text = await evaluate(c, `document.querySelector('main')?.innerText ?? ''`)
        await shot(c, 'live-settings-connections')
        step('Connections page reads backend state (no "connections unavailable" error)', !/connections unavailable|未能读取连接状态/.test(text), text.replace(/\s+/g, ' ').slice(0, 160))
      }
    }
    if (!opt.quick) step('Switching categories changes the visible content', changed >= 8, `${changed}/${categories.length} switches changed the page`)
    await evaluate(c, `document.getElementById('category-general')?.click()`)
    await sleep(400)
    const before = await evaluate(c, `document.getElementById('language')?.value`)
    const toggled = await evaluate(c, `(() => { const s = document.getElementById('language'); if (!s) return null; s.value = s.value === 'en' ? 'zh-CN' : 'en'; s.dispatchEvent(new Event('change', {bubbles: true})); return s.value })()`)
    await sleep(700)
    const hint = await evaluate(c, `(() => { const h = document.getElementById('language-restart-hint'); return h && !h.hidden ? h.textContent.trim() : '' })()`)
    await shot(c, 'settings-language-changed')
    step('Language control reacts (restart hint appears, nothing saved)', !!toggled && toggled !== before && hint.length > 0, `${before} -> ${toggled}; hint="${hint}"`)
    await evaluate(c, `(() => { const s = document.getElementById('language'); s.value = ${JSON.stringify(before)}; s.dispatchEvent(new Event('change', {bubbles: true})) })()`)
    c.close()
  }
  step('No uncaught renderer exceptions during the session', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '))
} catch (error) {
  step('acceptance run completed', false, error.message)
} finally {
  try {
    const v = await (await fetch(`http://127.0.0.1:${opt.port}/json/version`, {signal: AbortSignal.timeout(2000)})).json()
    const ws = new WebSocket(v.webSocketDebuggerUrl)
    await new Promise(r => { ws.onopen = () => { ws.send(JSON.stringify({id: 1, method: 'Browser.close'})); r() }; ws.onerror = r })
    await sleep(2500)
  } catch { /* fall through to a hard stop */ }
  for (const child of [primary]) {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true})
      else { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
    }
  }
  report.finished = new Date().toISOString()
  await writeFile(join(opt.out, `${opt.tag}-report.json`), JSON.stringify(report, null, 2))
  const failed = report.steps.filter(s => !s.ok).length
  console.log(`\nSUMMARY ${opt.tag} ${report.platform}: ${report.steps.length - failed}/${report.steps.length} passed`)
  process.exitCode = failed ? 1 : 0
}
