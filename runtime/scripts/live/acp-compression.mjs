/** Opt-in, synthetic ACP + real Nova reducer/compressor cost regression. No personal state. */
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve, dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {execFileSync} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
import {AsyncLocalStorage} from 'node:async_hooks'
import {createServer} from 'node:http'
import {Readable} from 'node:stream'

if (process.env.NOVA_LIVE_ACP_COST !== '1') throw Error('Set NOVA_LIVE_ACP_COST=1 to authorize real requests')
if (!process.env.DASHSCOPE_API_KEY) throw Error('DASHSCOPE_API_KEY required')
const variant = process.argv[2] ?? 'after'
if (!['before', 'after'].includes(variant)) throw Error('Usage: acp-compression.mjs before|after')
const repo = resolve(import.meta.dirname, '../../..')
const root = await realpath(await mkdtemp(join(tmpdir(), `nova-acp-compression-${variant}-`)))
const workspace = join(root, 'workspace'), configHome = join(root, 'config')
await mkdir(workspace); await mkdir(join(configHome, 'opencode'), {recursive: true})
const baseline = process.env.NOVA_ACP_BASELINE_REF ?? 'd425dcb5'
const report = {variant, baseline, root, scope: 'Real OpenCode ACP, CodexLiveAdapter, CausalRuntime and GatewayCompressor. Synthetic retained context; qwen-flash on both sides. Token share covers Nova host gateway calls only, not backend-internal usage. No microphone/GUI acceptance.', progress: [], modelCalls: [], compressorJobs: [], permissions: 0}
const moduleUrl = path => pathToFileURL(path).href
const dist = variant === 'before' ? process.env.NOVA_ACP_BASELINE_DIST : (process.env.NOVA_ACP_AFTER_DIST ?? resolve(repo, 'runtime/dist'))
report.scriptSha256 = createHash('sha256').update(await readFile(import.meta.filename)).digest('hex')
if (!dist) throw Error('before requires NOVA_ACP_BASELINE_DIST from an independently built baseline checkout')
const [{AcpTransport}, {CausalRuntime}, {RealClock}, {MonotonicIdFactory}, {CodexLiveAdapter}, {OpenAIModelGateway}, {GatewayCompressor}] = await Promise.all([
  'executors/acp/transport', 'core/causal-runtime', 'core/clock', 'core/ids', 'executors/codex/adapter-live', 'model/model-gateway', 'model/model-adapters',
].map(name => import(moduleUrl(resolve(dist, 'src', name + '.js')))))
report.provenance = {
  sourceRef: variant === 'before' ? baseline : execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).trim(),
  diffSha256: createHash('sha256').update(execFileSync('git', ['diff'], {cwd: repo})).digest('hex'),
  distSha256: Object.fromEntries(await Promise.all(['core/runtime', 'core/causal-runtime', 'executors/acp/transport'].map(async file => [file, createHash('sha256').update(await readFile(resolve(dist, 'src', file + '.js'))).digest('hex')]))),
}
// The agent receives only a loopback endpoint and a disposable placeholder token, never the real key.
report.backendRequests = []
const proxy = createServer(async (request, response) => {
  const abort = new AbortController()
  response.on('close', () => abort.abort())
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || report.backendRequests.length >= 8) {
      response.writeHead(403).end(); return
    }
    let body = ''
    for await (const chunk of request) {body += chunk; if (body.length > 1000000) throw Error('request too large')}
    const payload = JSON.parse(body)
    assert.equal(payload.model, 'qwen-flash')
    payload.max_tokens = Math.min(payload.max_tokens ?? payload.max_completion_tokens ?? 4096, 4096)
    delete payload.max_completion_tokens
    const record = {at: Date.now(), requestBytes: Buffer.byteLength(body)}
    report.backendRequests.push(record)
    const upstream = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`},
      body: JSON.stringify(payload), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]),
    })
    record.status = upstream.status
    response.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type') ?? 'application/json'})
    Readable.fromWeb(upstream.body).on('error', () => response.destroy()).pipe(response)
  } catch {if (!response.headersSent) response.writeHead(502); response.end()}
})
await new Promise((done, reject) => {proxy.once('error', reject); proxy.listen(0, '127.0.0.1', done)})
const configPath = join(configHome, 'opencode', 'opencode.json')
await writeFile(configPath, JSON.stringify({model: 'dashscope/qwen-flash', small_model: 'dashscope/qwen-flash',
  provider: {dashscope: {npm: '@ai-sdk/openai-compatible', name: 'DashScope', options: {
    baseURL: `http://127.0.0.1:${proxy.address().port}/v1`, apiKey: 'synthetic-local-proxy',
  }, models: {'qwen-flash': {name: 'Qwen Flash', limit: {context: 1000000, output: 8192}}}}},
  mcp: {}, plugin: [], autoupdate: false,
  permission: {external_directory: 'deny', bash: 'deny'},
}), {mode: 0o600})
const clock = new RealClock(), purpose = new AsyncLocalStorage()
const gateway = new OpenAIModelGateway({baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: process.env.DASHSCOPE_API_KEY, clock,
  metrics: {record(value) {const row = {purpose: purpose.getStore() ?? 'unknown', ...value}; report.modelCalls.push(row); console.log(JSON.stringify({kind: 'model_call', ...row}))}},
})
const compressor = new GatewayCompressor({gateway, model: 'qwen-flash'})
let outcome, runtime, serving, serveError
const stop = new AbortController()
const timeout = setTimeout(() => stop.abort(), 180000)
const transportOptions = {backendId: 'opencode', cwd: workspace, binaryPath: process.env.NOVA_ACP_LIVE_BINARY ?? '/opt/homebrew/bin/opencode',
  permissionMode: 'ask', workingInterval: 5,
  env: {PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: join(configHome, 'opencode'), XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache')},
  approvalController: {offer: async offer => {
    report.permissions++
    const scope = offer.local_detail?.scope ?? ''
    const allowed = report.permissions <= 8 && scope.includes(workspace + '/') && !scope.includes('Kind: execute')
    return {decision: allowed && offer.allowed_decisions.includes('accept') ? 'accept' : 'decline'}
  }, consume: value => value.decision, invalidate: () => false},
}
const transport = new AcpTransport(transportOptions)
const runTransport = transport.run.bind(transport)
transport.run = async (...args) => {
  const observer = args[1]
  args[1] = {...observer, onThreadReady: id => {report.sessionId = id; observer.onThreadReady?.(id)}}
  const value = await runTransport(...args)
  report.transport = {classification: value.classification, code: value.code, activity: value.completion?.internal_activity ?? null, process: value.process}
  return value
}
const adapter = new CodexLiveAdapter(transport, undefined, {onValidatedOutcome: value => {outcome = value}})
let handoff
try {
  runtime = new CausalRuntime({clock, ids: new MonotonicIdFactory(), executors: [adapter], models: {
    compress: {async complete(call, signal) {
      if (report.compressorJobs.length >= 6) {report.budgetCapped = true; throw Error('live compression call cap')}
      report.compressorJobs.push({channel: call.channel, items: call.compression_items.length, at: clock.now()})
      const summary = await purpose.run('compressor', () => compressor.compress(call.compression_items, signal))
      return {channel: call.channel, summary}
    }},
  }})
  // Previously compressed retained rows: reproduce a sizable retained window without user data.
  for (let i = 0; i < 120; i++) runtime.memory.append('codex', {ts: clock.now(), trust: 'trusted_system', priority: 50,
    content: {synthetic_prior_result: i, text: 'Synthetic archived calculation: index, square, and verification completed. '.repeat(12)}, refs: []})
  const channel = runtime.memory.channels.get('codex')
  assert.equal(channel.replaceSummary('Synthetic earlier calculations are complete.', channel.highWater, channel.retentionRevision), true)
  report.retainedItems = channel.items.length
  runtime.observe(event => {
    if (event.kind === 'progress') report.progress.push({at: event.ts, ...event.payload})
    if (event.kind === 'handoff') handoff = event.payload
  })
  serving = runtime.serve(stop.signal).catch(error => {serveError = error.name})
  const workOrder = `This is an isolated acceptance test. Use only the write and read tools, no shell. Create ${join(workspace, 'squares.csv')} with the header n,square and exactly 80 data rows for integers 1 through 80 and their squares. Verify every row by reading the file back with the read tool. Do not access other directories or network services. In your final answer, explain all 80 rows as 80 separate numbered one-sentence bullets. Do not abbreviate this final answer; streaming output is part of the test.`
  const origin = await runtime.ingestUserInput({text: workOrder})
  const admission = await runtime.dispatchExternal({executor: 'codex', op: 'run', request: {work_order: workOrder}, origin_ref: origin},
    {kind: 'user_input', priority: 100, routing_class: 'user_awaited'})
  report.admission = admission
  if (!admission.accepted) throw Error('admission refused')
  while (!handoff && !stop.signal.aborted && !serveError) await delay(100)
  if (!handoff) throw Error('no handoff before deadline')
  while (runtime.core.slots.inflight.compress && !stop.signal.aborted) await delay(100)
  const csv = await readFile(join(workspace, 'squares.csv'), 'utf8')
  const rows = csv.trim().split(/\r?\n/)
  assert.equal(rows.shift(), 'n,square'); assert.equal(rows.length, 80)
  rows.forEach((row, i) => assert.equal(row, `${i + 1},${(i + 1) ** 2}`))
  report.artifactVerified = true
  report.handoffOutcome = handoff.outcome
  report.finalActivity = report.transport?.activity ?? null
  report.adapterOutcome = outcome
  report.blackboardItems = runtime.memory.channels.get('codex').items.length
  await purpose.run('foreground-verification', () => gateway.complete({model: 'qwen-flash', system: 'Summarize the verified synthetic calculation results in one sentence.', prompt: csv, maxTokens: 128, signal: AbortSignal.timeout(30000)}))
  report.ok = handoff.outcome === 'ok' && !report.budgetCapped && report.modelCalls.every(call => call.error_type === null)
  const db = new DatabaseSync(join(root, 'data/opencode/opencode.db'), {readOnly: true})
  try {
    report.backendModelUsage = db.prepare('SELECT data FROM message').all().map(row => JSON.parse(row.data)).filter(row => row.role === 'assistant').map(row => ({model: row.modelID, provider: row.providerID, tokens: row.tokens, finish: row.finish}))
  } finally {db.close()}
  if (variant === 'after' && report.ok) {
    report.lifecycle = []
    const resumed = new AcpTransport({...transportOptions, resumeSessionId: report.sessionId})
    let bound
    try {
      const value = await resumed.run({workOrder: `Continue the previous synthetic task. Read ${join(workspace, 'squares.csv')} and verify it has exactly 80 data rows. Use the write tool to create ${join(workspace, 'resumed.txt')} containing exactly verified-80. Do not modify squares.csv. Then finish with one short sentence.`},
        {onThreadReady: id => {bound = id}}, {expiresAtMs: Date.now() + 60000, signal: stop.signal})
      const marker = await readFile(join(workspace, 'resumed.txt'), 'utf8').catch(() => '')
      report.lifecycle.push({step: 'resume', ok: value.code === 'completed' && bound === report.sessionId && marker.trim() === 'verified-80', code: value.code, process: value.process})
      assert.equal(await readFile(join(workspace, 'squares.csv'), 'utf8'), csv)
    } finally {await resumed.close()}
    const cancelled = new AcpTransport({...transportOptions, resumeSessionId: report.sessionId})
    const abort = new AbortController()
    try {
      const value = await cancelled.run({workOrder: 'Wait for more instructions. Do not change any files.'},
        {onTurnStartWritten: () => abort.abort()}, {expiresAtMs: Date.now() + 15000, signal: AbortSignal.any([abort.signal, stop.signal])}, null)
      report.lifecycle.push({step: 'cancel', ok: value.turnStartWritten && value.classification !== 'completed' && value.process !== undefined, code: value.code, process: value.process})
    } finally {await cancelled.close('cancel')}
    report.ok &&= report.lifecycle.every(step => step.ok)
  }

} catch (error) {
  report.ok = false; report.error = {name: error.name, code: error.code ?? null, message: ['AssertionError', 'GatewayError'].includes(error.name) ? error.message : 'acceptance_step_failed'}
} finally {
  clearTimeout(timeout); stop.abort(); await serving; await adapter.close().catch(() => {report.cleanupFailed = true}); await rm(configPath, {force: true}); proxy.closeAllConnections(); await new Promise(done => proxy.close(done))
  report.diagnostics = runtime?.core.diagnostics
  report.serveError = serveError ?? null
  report.inputTokens = report.modelCalls.reduce((sum, call) => sum + (call.input_tokens ?? 0), 0)
  report.compressorInputTokens = report.modelCalls.filter(call => call.purpose === 'compressor').reduce((sum, call) => sum + (call.input_tokens ?? 0), 0)
  report.compressorShare = report.inputTokens ? report.compressorInputTokens / report.inputTokens : null
  report.backendInputTokens = (report.backendModelUsage ?? []).reduce((sum, row) => sum + row.tokens.input + row.tokens.cache.read, 0)
  report.totalInputTokens = report.inputTokens + report.backendInputTokens
  report.totalCompressorShare = report.totalInputTokens ? report.compressorInputTokens / report.totalInputTokens : null
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600})
  console.log(JSON.stringify({report: join(root, 'report.json'), ok: report.ok, progress: report.progress.length, calls: report.modelCalls.length, compressorShare: report.compressorShare}))
  process.exitCode = report.ok ? 0 : 1
}
