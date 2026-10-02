// Built runtime + explicitly configured, booted Simulator/WDA required. No live model or keys.
// node runtime/scripts/accept-mobile-actions-simulator.mjs /absolute/path/evidence.json
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, writeFile, stat} from 'node:fs/promises'
import {createServer} from 'node:http'
import {dirname, join, resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {RealClock} from '../dist/src/core/clock.js'
import {HostApprovalController} from '../dist/src/core/approval.js'
import {MobileExecutor, loadMobileConfig} from '../dist/src/executors/mobile.js'

assert.equal(process.env.MOBILE_DEVICE_TYPE, 'ios-simulator')
const output = resolve(process.argv[2] ?? '/tmp/nova-mobile-actions.json')
await mkdir(dirname(output), {recursive: true})
const token = randomUUID(), text = 'nova-mobile-check'
const evidence = {kind: 'simulator-with-local-safari-fixture-and-scripted-model', started_at: new Date().toISOString(), connections: 0, get_requests: [], scenarios: []}
let current, executor, checkpoint = 'setup'
const definitions = [
  {name: 'tap', names: ['Tap'], actions: ['do(action="Tap", element=[500,500])']},
  {name: 'type', names: ['Tap', 'Type'], actions: ['do(action="Tap", element=[500,500])', `do(action="Type", text="${text}")`]},
  {name: 'swipe', names: ['Swipe'], actions: ['do(action="Swipe", start=[500,750], end=[500,300])']},
]
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname
    if (request.method === 'GET' && evidence.get_requests.length < 30) evidence.get_requests.push({
      kind: path.startsWith(`/fixture/${token}/`) ? 'fixture' : path === '/favicon.ico' ? 'favicon' : 'other',
      host: /^[A-Za-z0-9.:[\]-]{1,100}$/u.test(request.headers.host ?? '') ? request.headers.host : 'unexpected'})
    if (request.method === 'GET' && path === `/fixture/${token}/${current?.name}`) {
      response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'})
      response.end(page(current.name)); return
    }
    if (request.method === 'GET') { response.writeHead(404); response.end(); return }
    if (path.startsWith(`/events/${token}/`) && path !== `/events/${token}/${current?.name}`) { response.writeHead(204); response.end(); return }
    let body = '', size = 0
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 32 * 1024 * 1024); body += chunk.toString('utf8') }
    if (request.method === 'POST' && path === `/events/${token}/${current?.name}`) {
      assert.ok(size < 2048)
      const event = JSON.parse(body)
      assert.ok(['ready', 'click', 'input', 'scroll'].includes(event.kind))
      assert.ok(current.events.length < 1000)
      current.events.push({kind: event.kind, value: typeof event.value === 'string' ? event.value.slice(0, 100) : null,
        scrollY: Number.isFinite(event.scrollY) ? event.scrollY : null})
      response.writeHead(204); response.end(); return
    }
    assert.equal(request.method, 'POST'); assert.equal(path, '/v1/chat/completions')
    const data = JSON.parse(body)
    assert.equal(data.model, 'simulator-scripted-actions'); assert.notEqual(data.stream, true)
    const images = data.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url')
    assert.ok(images.some(part => /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/u.test(part.image_url?.url ?? '')))
    assert.ok(current.requests < current.definition.actions.length + 1, 'unexpected retry')
    const action = current.definition.actions[current.requests++] ?? 'finish(message="done")'
    response.writeHead(200, {'Content-Type': 'application/json'})
    response.end(JSON.stringify({id: 'fixture', object: 'chat.completion', created: 0, model: data.model,
      choices: [{index: 0, message: {role: 'assistant', content: action}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}))
  } catch {
    if (current) current.server_error = 'request_rejected'
    response.writeHead(400); response.end('{}')
  }
})
server.on('connection', () => { evidence.connections++ })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const base = `http://127.0.0.1:${server.address().port}`
try {
  const config = loadMobileConfig({...process.env, MOBILE_BASE_URL: `${base}/v1`,
    MOBILE_MODEL: 'simulator-scripted-actions', MOBILE_MODEL_FAMILY: 'auto-glm',
    MOBILE_API_KEY: 'local-fixture-only', MOBILE_MAX_STEPS: '4', MOBILE_TIMEOUT_SECONDS: '90'})
  evidence.device_id = config.deviceId
  const clock = new RealClock(), approvals = new HostApprovalController({clock, idFactory: randomUUID})
  executor = new MobileExecutor(config, approvals)
  const snapshot = async phase => {
    const response = await fetch(`${config.wdaUrl.replace(/\/$/u, '')}/screenshot`, {signal: AbortSignal.timeout(10000), redirect: 'error'})
    assert.equal(response.status, 200)
    const png = Buffer.from((await response.json()).value, 'base64')
    assert.ok(png.length > 100 && png.subarray(1, 4).toString() === 'PNG')
    const path = `${output}.${current.name}.${phase}.png`
    await writeFile(path, png)
    return {path, sha256: createHash('sha256').update(png).digest('hex')}
  }
  for (const definition of definitions) {
    current = {name: definition.name, definition, requests: 0, events: [], approvals: []}
    evidence.scenarios.push(current)
    checkpoint = `${current.name}:open-fixture`
    await promisify(execFile)('/usr/bin/xcrun', ['simctl', 'openurl', config.deviceId, `${base}/fixture/${token}/${current.name}`], {timeout: 15000})
    for (let count = 0; count < 120 && !current.events.some(event => event.kind === 'ready'); count++) await delay(250)
    assert.ok(current.events.some(event => event.kind === 'ready'), 'fixture did not load')
    await delay(1500)
    current.before = await snapshot('before')
    assert.equal(current.events.some(event => event.kind === 'click' || event.kind === 'input' || event.scrollY > 0), false)
    let reserved
    const controller = executor.controller({dispatch: request => { reserved = request.request; return {accepted: true, delegate_id: current.name} }})
    const user = {instruction: `Perform the scripted ${current.name} action on this local test fixture.`, originalUserText: 'Run local fixture test',
      origin_ref: `fixture:${current.name}`, sessionEpoch: 1, acceptedUserInputRevision: 1, stillWanted: () => true}
    assert.equal((await controller.dispatch(user)).code, 'delegated')
    const handled = new Set()
    const unsubscribe = approvals.observe(view => {
      if (!view.pending_approval || view.pending_approval_busy || handled.has(view.pending_approval_id)) return
      handled.add(view.pending_approval_id)
      const expected = definition.names[current.approvals.length]
      const scope = view.local_detail?.kind === 'permissions' ? view.local_detail.scope : ''
      let allowed = false
      try {
        const split = scope.indexOf(': '), name = scope.slice(0, split), params = JSON.parse(scope.slice(split + 2))
        allowed = view.executorIdentity?.executor === 'mobile' && name === expected &&
          (name === 'Type' ? params.text === text && Object.keys(params).length === 1 :
            Object.keys(params).sort().join(',') === (name === 'Tap' ? 'x,y' : 'durationMs,fromX,fromY,toX,toY') &&
            Object.values(params).every(value => typeof value === 'number' && Number.isFinite(value)))
      } catch { /* malformed or unexpected actions are refused */ }
      current.approvals.push({expected, allowed})
      queueMicrotask(() => approvals.acceptDecision({approvalId: view.pending_approval_id, decision: allowed ? 'accept' : 'decline'}))
    })
    try {
      checkpoint = `${current.name}:dispatch`
      const started = clock.now()
      current.handoff = await executor.dispatch('run', reserved, {clock, signal: new AbortController().signal, progress: () => {},
        delegate: {delegate_id: current.name, executor: 'mobile', op: 'run', request: reserved, origin_ref: user.origin_ref,
          deadline: started + 90, dispatched_at: started, routing_class: 'user_awaited'}})
      await delay(750)
      current.after = await snapshot('after')
      checkpoint = `${current.name}:verify`
      assert.equal(current.server_error, undefined)
      assert.equal(current.handoff.content.code, 'model_finished'); assert.equal(current.handoff.content.verified, false)
      assert.equal(current.handoff.trust, 'untrusted_external'); assert.equal(current.handoff.outcome, 'ok')
      assert.equal(current.requests, definition.actions.length + 1)
      assert.equal(current.approvals.length, definition.names.length); assert.ok(current.approvals.every(item => item.allowed))
      const effect = current.name === 'tap' ? current.events.some(event => event.kind === 'click') : current.name === 'type'
        ? current.events.some(event => event.kind === 'input' && event.value === text) : current.events.some(event => event.kind === 'scroll' && event.scrollY > 0)
      current.effect_verifier = {method: 'fixture_dom_event', passed: effect}
      current.model_reported_finished = current.handoff.content.code === 'model_finished'
      assert.ok(effect, 'fixture did not observe expected effect'); assert.equal(approvals.pending, false)
      await assert.rejects(stat(join(config.lockRoot, createHash('sha256').update(`${config.deviceType}:${config.deviceId}`).digest('hex'))), {code: 'ENOENT'})
      current.passed = true
    } finally { unsubscribe(); delete current.definition }
  }
  evidence.passed = true
} catch (error) { evidence.passed = false; evidence.error = {checkpoint, name: error instanceof Error ? error.name : 'Error'}; process.exitCode = 1 }
finally {
  await executor?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  evidence.finished_at = new Date().toISOString(); const json = JSON.stringify(evidence, null, 2)
  await writeFile(output, `${json}\n`); console.log(json)
}
function page(name) {
  const element = name === 'tap' ? '<button id="target">Tap test</button>' : name === 'type'
    ? '<input id="target" aria-label="Test input" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false">'
    : '<div style="height:350vh;background:repeating-linear-gradient(#e5f1fb 0 25vh,#f7dfb4 25vh 50vh)"></div>'
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
    <style>body{margin:0;background:#e5f1fb}#target{position:absolute;top:10vh;left:5vw;width:90vw;height:80vh;box-sizing:border-box;border:0;border-radius:0;background:#d7eddb;font-size:24px;caret-color:transparent;outline:none}</style>${element}
    <script>const report=(kind,value=null)=>fetch('/events/${token}/${name}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,value,scrollY:window.scrollY})});
    document.getElementById('target')?.addEventListener('${name === 'type' ? 'input' : 'click'}',e=>report('${name === 'type' ? 'input' : 'click'}',${name === 'type' ? 'e.target.value' : 'null'}));
    addEventListener('scroll',()=>report('scroll'));report('ready');</script>`
}
