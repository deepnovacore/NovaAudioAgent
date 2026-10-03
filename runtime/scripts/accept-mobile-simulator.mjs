// Run after building runtime and starting WDA on the explicitly configured Simulator.
// node runtime/scripts/accept-mobile-simulator.mjs [evidence.json] [--live]
// Live model credentials are read only at execution time from NOVA_MOBILE_MODEL_CONFIG.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {dirname, join, resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {HostApprovalController} from '../dist/src/core/approval.js'
import {RealClock} from '../dist/src/core/clock.js'
import {MobileExecutor, loadMobileConfig} from '../dist/src/executors/mobile.js'

assert.equal(process.env.MOBILE_DEVICE_TYPE, 'ios-simulator', 'explicit ios-simulator configuration required')
const live = process.argv[3] === '--live'
assert.ok(process.argv[3] === undefined || live, 'only --live is supported')
const output = process.argv[2] ? resolve(process.argv[2]) : null
if (output) await mkdir(dirname(output), {recursive: true})
const evidence = {kind: live ? 'simulator-with-live-model' : 'simulator-with-scripted-local-model', started_at: new Date().toISOString(), scenarios: []}
let scenario = null
let checkpoint = 'configure'
let stoppedRequests = false
let requestsAfterCancellation = 0
const server = createServer(async (request, response) => {
  const shape = {method: String(request.method).slice(0, 12), url: String(request.url).split('?')[0].slice(0, 120)}
  try {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    assert.ok(scenario)
    if (stoppedRequests) requestsAfterCancellation++
    assert.equal(stoppedRequests, false, 'model request after cancellation')
    let body = '', size = 0
    for await (const chunk of request) {
      size += chunk.length
      assert.ok(size <= 32 * 1024 * 1024, 'model request exceeded 32 MiB')
      body += chunk.toString('utf8')
    }
    const parsed = JSON.parse(body)
    shape.stream = typeof parsed.stream === 'boolean' ? parsed.stream : 'absent'
    shape.model = parsed.model === 'simulator-scripted-home' ? parsed.model : 'unexpected'
    const images = (Array.isArray(parsed.messages) ? parsed.messages : []).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(part => part.type === 'image_url')
    shape.image_mimes = images.map(part => /^data:(image\/[a-z+]+);base64,/u.exec(part.image_url?.url ?? '')?.[1] ?? 'unsupported').slice(0, 8)
    assert.notEqual(parsed.stream, true)
    assert.equal(parsed.model, 'simulator-scripted-home')
    assert.ok(images.some(part => validImage(part.image_url?.url)), 'SDK must supply a PNG or JPEG screenshot')
    const action = scenario.model_requests.length === 0 ? 'do(action="Home")' : 'finish(message="done")'
    scenario.model_requests.push({bytes: size, image_count: images.length, action})
    assert.ok(scenario.model_requests.length <= 2, 'unexpected model retry or extra step')
    response.writeHead(200, {'Content-Type': 'application/json'})
    response.end(JSON.stringify({id: 'local-simulator', object: 'chat.completion', created: 0,
      model: parsed.model, choices: [{index: 0, message: {role: 'assistant', content: action}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}))
  } catch (error) {
    if (scenario) { scenario.model_error = 'scripted_model_request_rejected'; scenario.model_request_shape = shape }
    response.writeHead(400, {'Content-Type': 'application/json'})
    response.end(JSON.stringify({error: {message: 'local acceptance model rejected request'}}))
  }
})
if (!live) await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const clock = new RealClock()
const approvals = new HostApprovalController({clock, idFactory: randomUUID})
let executor
try {
  let model
  if (live) {
    assert.ok(process.env.NOVA_MOBILE_MODEL_CONFIG, 'live model configuration path required')
    model = JSON.parse(await readFile(process.env.NOVA_MOBILE_MODEL_CONFIG, 'utf8'))
    for (const key of ['baseUrl', 'model', 'modelFamily', 'apiKey']) assert.ok(typeof model[key] === 'string' && model[key].trim())
  } else model = {baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'simulator-scripted-home',
    modelFamily: 'auto-glm', apiKey: 'simulator-local-only'}
  const config = loadMobileConfig({...process.env,
    MOBILE_BASE_URL: model.baseUrl, MOBILE_MODEL: model.model,
    MOBILE_MODEL_FAMILY: model.modelFamily, MOBILE_API_KEY: model.apiKey,
    MOBILE_MAX_STEPS: '3', MOBILE_TIMEOUT_SECONDS: '90'})
  evidence.device_id = config.deviceId
  evidence.wda_url = config.wdaUrl
  evidence.engine = 'midscene'
  evidence.model = config.model
  evidence.model_family = config.modelFamily
  executor = new MobileExecutor(config, approvals)
  const wda = async path => {
    const response = await fetch(`${config.wdaUrl.replace(/\/$/u, '')}${path}`, {signal: AbortSignal.timeout(10000), redirect: 'error'})
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.value?.error, undefined)
    return data.value
  }
  const snapshot = async (name, phase) => {
    const app = await wda('/wda/activeAppInfo')
    const png = Buffer.from(await wda('/screenshot'), 'base64')
    assert.ok(png.length > 100, 'WDA must return a real screenshot')
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    const path = output ? `${output}.${name}.${phase}.png` : null
    if (path) await writeFile(path, png)
    return {bundle_id: app.bundleId, screenshot_sha256: createHash('sha256').update(png).digest('hex'),
      screenshot_bytes: png.length, ...(path ? {screenshot_path: path} : {})}
  }
  for (const name of (live ? ['accept'] : ['accept', 'decline', 'screen_changed', 'cancel'])) {
    checkpoint = `${name}:setup`
    stoppedRequests = false
    scenario = {name, model_requests_observed: !live, cancellation_phase: name === 'cancel' ? 'awaiting_approval' : null, model_requests: [], approvals: [], progress: []}
    evidence.scenarios.push(scenario)
    // Test setup, outside the executor: ensure Home has an observable foreground-app effect.
    await promisify(execFile)('/usr/bin/xcrun', ['simctl', 'launch', '--terminate-running-process', config.deviceId, 'com.apple.Preferences'], {timeout: 15000})
    for (let count = 0; count < 40 && (await wda('/wda/activeAppInfo')).bundleId !== 'com.apple.Preferences'; count++) await delay(250)
    // Wait for the stock Settings launch animation and Home indicator to settle.
    // This is fixture readiness only; the executor still checks every pixel independently.
    let previousImage, stableSince = Date.now()
    const readyDeadline = Date.now() + 60000
    for (;;) {
      const image = await wda('/screenshot')
      if (image !== previousImage) { previousImage = image; stableSince = Date.now() }
      if (Date.now() - stableSince >= 5000) break
      assert.ok(Date.now() < readyDeadline, 'Settings screenshot did not settle')
      await delay(500)
    }
    scenario.before = await snapshot(name, 'before')
    assert.equal(scenario.before.bundle_id, 'com.apple.Preferences')
    let reserved
    const controller = executor.controller({dispatch: request => {
      assert.equal(request.channel, 'mobile')
      assert.equal(request.op, 'run')
      assert.equal(request.stillWanted(), true)
      reserved = request.request
      return {accepted: true, delegate_id: `simulator-${name}`}
    }})
    const user = {instruction: 'Return to the Home screen once.', originalUserText: 'Return to the Home screen once.',
      origin_ref: `simulator:${name}`, sessionEpoch: 1, acceptedUserInputRevision: 1, stillWanted: () => true}
    assert.equal((await controller.dispatch(user)).code, 'delegated')
    assert.equal(executor.admitRequest('run', reserved).ok, true)
    const handled = new Set()
    let cancellation
    const unsubscribe = approvals.observe(view => {
      if (!view.pending_approval || view.pending_approval_busy || handled.has(view.pending_approval_id)) return
      handled.add(view.pending_approval_id)
      const safeHome = handled.size === 1 && isHomeApproval(view)
      scenario.approvals.push({id: view.pending_approval_id, executor: view.executorIdentity?.executor,
        action: safeHome ? 'Home' : 'refused_non_home', decision: safeHome ? name : 'decline'})
      // Let the offer finish publishing before applying a structured host decision/cancel.
      queueMicrotask(() => {
        if (name === 'cancel') { stoppedRequests = true; cancellation = controller.cancel(user) }
        else if (name === 'screen_changed' && safeHome) {
          cancellation = (async () => {
            try {
              await promisify(execFile)('/usr/bin/xcrun', ['simctl', 'launch', '--terminate-running-process', config.deviceId, 'com.apple.mobilesafari'], {timeout: 15000})
              for (let attempt = 0; attempt < 20; attempt++) {
                if ((await wda('/wda/activeAppInfo')).bundleId === 'com.apple.mobilesafari') break
                await delay(250)
              }
              scenario.changed = await snapshot(name, 'approval-pending')
              assert.equal(scenario.changed.bundle_id, 'com.apple.mobilesafari')
              assert.equal(approvals.acceptDecision({approvalId: view.pending_approval_id, decision: 'accept'}), true)
            } catch {
              scenario.change_error = 'foreground_change_failed'
              approvals.acceptDecision({approvalId: view.pending_approval_id, decision: 'decline'})
            }
          })()
        } else approvals.acceptDecision({approvalId: view.pending_approval_id, decision: safeHome ? name : 'decline'})
      })
    })
    try {
      checkpoint = `${name}:dispatch`
      const started = clock.now()
      scenario.handoff = await executor.dispatch('run', reserved, {clock, signal: new AbortController().signal,
        delegate: {delegate_id: `simulator-${name}`, executor: 'mobile', op: 'run', request: reserved,
          origin_ref: user.origin_ref, deadline: started + 90, dispatched_at: started, routing_class: 'user_awaited'},
        progress: progress => scenario.progress.push(progress)})
      if (cancellation) await cancellation
      checkpoint = `${name}:verify`
      scenario.elapsed_seconds = +(clock.now() - started).toFixed(3)
      await delay(500)
      scenario.after = await snapshot(name, 'after')
      assert.equal(scenario.model_error, undefined)
      assert.equal(scenario.change_error, undefined)
      assert.equal(scenario.approvals.length, 1)
      assert.equal(scenario.approvals[0].executor, 'mobile')
      assert.equal(scenario.approvals[0].action, 'Home')
      assert.equal(scenario.handoff.trust, 'untrusted_external')
      assert.equal(scenario.handoff.content.verified, false)
      assert.equal(scenario.handoff.content.effects, 'unknown')
      assert.equal(scenario.handoff.outcome, name === 'accept' ? 'ok' : name === 'cancel' ? 'cancelled' : 'refused')
      assert.equal(scenario.handoff.content.code, name === 'accept' ? 'model_finished' : name === 'decline' ? 'declined' : name === 'screen_changed' ? 'screen_changed' : 'cancelled')
      if (!live) assert.equal(scenario.model_requests.length, name === 'accept' ? 2 : 1)
      assert.equal(scenario.after.bundle_id, name === 'accept' ? 'com.apple.springboard' : name === 'screen_changed' ? 'com.apple.mobilesafari' : 'com.apple.Preferences')
      scenario.state_verifier = {method: 'wda_active_app', expected_bundle: name === 'accept' ? 'com.apple.springboard' : name === 'screen_changed' ? 'com.apple.mobilesafari' : 'com.apple.Preferences',
        observed_bundle: scenario.after.bundle_id, passed: true}
      scenario.model_reported_finished = scenario.handoff.content.code === 'model_finished'
      if (name !== 'accept') {
        assert.equal(scenario.handoff.content.last_action, undefined)
        if (name !== 'cancel') assert.equal(scenario.handoff.content.steps, 0)
      }
      assert.equal(approvals.pending, false)
      const lock = join(config.lockRoot, createHash('sha256').update(`${config.deviceType}:${config.deviceId}`).digest('hex'))
      await assert.rejects(stat(lock), {code: 'ENOENT'})
      scenario.passed = true
    } finally { unsubscribe() }
  }
  evidence.passed = true
} catch (error) {
  evidence.passed = false
  evidence.error = {checkpoint, name: error instanceof Error ? error.name : 'Error'}
  process.exitCode = 1
} finally {
  await executor?.close()
  server.closeAllConnections()
  if (server.listening) await new Promise(done => server.close(done))
  if (!live) {
    evidence.requests_after_cancellation = requestsAfterCancellation
    if (requestsAfterCancellation !== 0) { evidence.passed = false; process.exitCode = 1 }
  }
  evidence.finished_at = new Date().toISOString()
  const json = JSON.stringify(evidence, null, 2)
  if (output) await writeFile(output, `${json}\n`)
  console.log(json)
}


function isHomeApproval(view) {
  if (view.executorIdentity?.executor !== 'mobile' || view.kind !== 'permissions' || view.local_detail?.kind !== 'permissions') return false
  return view.local_detail.scope === 'Home: {}'
}


function validImage(url) {
  if (typeof url !== 'string') return false
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(url)
  if (!match) return false
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length <= 100) return false
  return match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
}
