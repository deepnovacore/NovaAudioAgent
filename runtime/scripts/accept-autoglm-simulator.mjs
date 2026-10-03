// Run after building runtime and starting WDA on the explicitly configured Simulator.
// node runtime/scripts/accept-autoglm-simulator.mjs [evidence.json]
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, stat, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {dirname, join, resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {HostApprovalController} from '../dist/src/core/approval.js'
import {RealClock} from '../dist/src/core/clock.js'
import {AutoGlmExecutor, loadAutoGlmConfig} from '../dist/src/executors/autoglm.js'

assert.equal(process.env.AUTOGLM_DEVICE_TYPE, 'ios-simulator', 'explicit ios-simulator configuration required')
const output = process.argv[2] ? resolve(process.argv[2]) : null
if (output) await mkdir(dirname(output), {recursive: true})
const evidence = {kind: 'simulator-with-scripted-local-model', started_at: new Date().toISOString(), scenarios: []}
let scenario = null
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    assert.ok(scenario)
    let body = '', size = 0
    for await (const chunk of request) {
      size += chunk.length
      assert.ok(size <= 32 * 1024 * 1024, 'model request exceeded 32 MiB')
      body += chunk.toString('utf8')
    }
    const parsed = JSON.parse(body)
    assert.equal(parsed.stream, true)
    assert.equal(parsed.model, 'simulator-scripted-home')
    const images = parsed.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(part => part.type === 'image_url')
    assert.ok(images.some(part => part.image_url?.url?.startsWith('data:image/png;base64,')), 'real bridge must supply a screenshot')
    const action = scenario.model_requests.length === 0 ? 'do(action="Home")' : 'finish(message="Home action returned")'
    scenario.model_requests.push({bytes: size, image_count: images.length, action})
    assert.ok(scenario.model_requests.length <= 2, 'unexpected model retry or extra step')
    response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'})
    response.write(`data: ${JSON.stringify({id: 'local-simulator', object: 'chat.completion.chunk', created: 0,
      model: parsed.model, choices: [{index: 0, delta: {content: action}, finish_reason: null}]})}\n\n`)
    response.end('data: [DONE]\n\n')
  } catch (error) {
    if (scenario) scenario.model_error = String(error.message).slice(0, 500)
    response.writeHead(400, {'Content-Type': 'application/json'})
    response.end(JSON.stringify({error: {message: 'local acceptance model rejected request'}}))
  }
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const clock = new RealClock()
const approvals = new HostApprovalController({clock, idFactory: randomUUID})
let executor
try {
  const config = loadAutoGlmConfig({...process.env,
    AUTOGLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    AUTOGLM_MODEL: 'simulator-scripted-home', AUTOGLM_API_KEY: 'simulator-local-only',
    AUTOGLM_MAX_STEPS: '3', AUTOGLM_TIMEOUT_SECONDS: '90'})
  evidence.device_id = config.deviceId
  evidence.wda_url = config.wdaUrl
  executor = new AutoGlmExecutor(config, approvals)
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
  for (const name of ['accept', 'decline', 'cancel']) {
    scenario = {name, model_requests: [], approvals: [], progress: []}
    evidence.scenarios.push(scenario)
    // Test setup, outside the executor: ensure Home has an observable foreground-app effect.
    await promisify(execFile)('/usr/bin/xcrun', ['simctl', 'launch', config.deviceId, 'com.apple.Preferences'], {timeout: 15000})
    await delay(1500)
    scenario.before = await snapshot(name, 'before')
    assert.equal(scenario.before.bundle_id, 'com.apple.Preferences')
    let reserved
    const controller = executor.controller({dispatch: request => {
      assert.equal(request.channel, 'autoglm')
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
      scenario.approvals.push({id: view.pending_approval_id, executor: view.executorIdentity?.executor,
        summary: view.operation_summary, decision: name})
      // Let the offer finish publishing before applying a structured host decision/cancel.
      queueMicrotask(() => {
        if (name === 'cancel') cancellation = controller.cancel(user)
        else approvals.acceptDecision({approvalId: view.pending_approval_id, decision: name})
      })
    })
    try {
      const started = clock.now()
      scenario.handoff = await executor.dispatch('run', reserved, {clock, signal: new AbortController().signal,
        delegate: {delegate_id: `simulator-${name}`, executor: 'autoglm', op: 'run', request: reserved,
          origin_ref: user.origin_ref, deadline: started + 90, dispatched_at: started, routing_class: 'user_awaited'},
        progress: progress => scenario.progress.push(progress)})
      if (cancellation) await cancellation
      scenario.elapsed_seconds = +(clock.now() - started).toFixed(3)
      await delay(500)
      scenario.after = await snapshot(name, 'after')
      assert.equal(scenario.model_error, undefined)
      assert.equal(scenario.approvals.length, 1)
      assert.equal(scenario.approvals[0].executor, 'autoglm')
      assert.match(scenario.approvals[0].summary, /Home/u)
      assert.equal(scenario.handoff.trust, 'untrusted_external')
      assert.equal(scenario.handoff.content.verified, false)
      assert.equal(scenario.handoff.content.effects, 'unknown')
      assert.equal(scenario.handoff.outcome, name === 'accept' ? 'ok' : name === 'decline' ? 'refused' : 'cancelled')
      assert.equal(scenario.handoff.content.code, name === 'accept' ? 'model_finished' : name === 'decline' ? 'declined' : 'cancelled')
      assert.equal(scenario.model_requests.length, name === 'accept' ? 2 : 1)
      assert.equal(scenario.after.bundle_id, name === 'accept' ? 'com.apple.springboard' : 'com.apple.Preferences')
      if (name === 'accept') {
        assert.equal(scenario.handoff.content.last_action, 'Home')
        assert.equal(scenario.handoff.content.last_returned_step, 1)
      } else assert.equal(scenario.handoff.content.last_action, undefined)
      assert.equal(approvals.pending, false)
      const lock = join(config.lockRoot, createHash('sha256').update(`${config.deviceType}:${config.deviceId}`).digest('hex'))
      await assert.rejects(stat(lock), {code: 'ENOENT'})
      scenario.passed = true
    } finally { unsubscribe() }
  }
  evidence.passed = true
} catch (error) {
  evidence.passed = false
  evidence.error = String(error.stack ?? error).slice(0, 2500)
  process.exitCode = 1
} finally {
  await executor?.close()
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  evidence.finished_at = new Date().toISOString()
  const json = JSON.stringify(evidence, null, 2)
  if (output) await writeFile(output, `${json}\n`)
  console.log(json)
}
