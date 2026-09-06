import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import {register} from 'node:module'
import {MessageChannel} from 'node:worker_threads'
import {setImmediate as yieldTurn} from 'node:timers/promises'
import type {EventRecord} from '../src/events.js'
import type {RealtimeProvider, HostContextItem, HostResponseIntent, JsonObject} from '../src/realtime/protocol.js'

// Node >=22.13 supports async ESM hooks; the loader thread reports actual transitive loads.
const {port1, port2} = new MessageChannel()
register(`data:text/javascript,${encodeURIComponent(`
  const loaded = new Set();
  export function initialize({port}) {
    port.on('message', () => port.postMessage([...loaded]));
    port.unref();
  }
  export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    loaded.add(url);
    return result;
  }
`)}`, {parentURL: import.meta.url, data: {port: port2}, transferList: [port2]})
port1.unref()
const loadedModules = () => new Promise<string[]>(resolve => {
  port1.once('message', resolve)
  port1.postMessage('snapshot')
})

async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return
    await yieldTurn()
  }
  assert.ok(predicate(), 'scripted host flow did not reach its next boundary')
}

test('fixture crosses real assembly, intake, project confirmation, progress, voice approval and terminal without loading Codex', async t => {
  const {buildAssembly} = await import('../src/assembly.js')
  const {buildRealtimeAssembly} = await import('../src/realtime-assembly.js')
  const {settingsSchema} = await import('../src/config.js')
  const {VirtualClock} = await import('../src/clock.js')
  const {createFixtureExecutor, FIXTURE_DESCRIPTOR} = await import('../src/executors/fixture/index.js')
  const {projectCommitFailureText} = await import('../src/realtime/service-state.js')
  const clock = new VirtualClock(1)
  let next = 0
  const fixture = createFixtureExecutor(clock, () => `fixture-${++next}`)
  const core = buildAssembly({settings: settingsSchema.parse({executors: ['fixture']}), clock,
    executors: [fixture.adapter], agentDescriptors: [FIXTURE_DESCRIPTOR], cameraModuleEnabled: false,
    gateway: {async *stream() { await Promise.resolve(); throw new Error('unexpected model stream') }, complete: () => Promise.reject(new Error('unexpected model completion'))},
    searchTransport: {search: () => Promise.reject(new Error('unexpected search'))},
  })
  assert.equal(core.runtime.executors.get('fixture'), fixture.adapter)
  const injected: HostContextItem[] = []
  const responses: HostResponseIntent[] = []
  const schemas: JsonObject[][] = []
  let priorItem: string | null = null
  const provider: RealtimeProvider = {
    connect: options => {schemas.push([...options.tools]); return Promise.resolve({epoch: 1, provider_session_id: 'fixture-provider'})},
    sendAudio: () => Promise.resolve(),
    injectHostItem: item => {injected.push(item); return Promise.resolve({session_epoch: 1, host_item_id: item.host_item_id, provider_item_id: `provider-${item.host_item_id}`})},
    injectWorkspaceContext: item => {
      const prior = priorItem
      priorItem = `provider-${item.host_item_id}`
      return Promise.resolve({item, asUserActivation: false, delivery: {capability: 'replace_provider_item', delivered: true, session_epoch: 1, workspace_instance_id: item.workspace_instance_id, revision: item.revision, prior_provider_item_id: prior, provider_item_id: priorItem, superseded_provider_item_id: prior}})
    },
    createResponse: intent => {responses.push(intent); return Promise.resolve()}, cancelResponse: () => Promise.resolve(), close: () => Promise.resolve(),
    async *events(signal) {if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}))},
  }
  const diagnostics: string[] = []
  const realtime = buildRealtimeAssembly({core, provider, codexResource: fixture.resource,
    codingAgentControllerFactory: fixture.agentControllerFactory, onDiagnostic: line => diagnostics.push(line),
    intake: {settings: {clarification_depth: 'minimal', plan_readback: 'confirm'}, models: {
      assess: input => Promise.resolve({intake_id: input.intake_id, revision: input.revision, kind: 'create', project: 'Fixture Project', project_evidence: 'Fixture Project', session: 'new',
        slots: Object.fromEntries(['goal', 'scope', 'acceptance', 'constraints'].map(key => [key, {state: 'stated', note: 'Run fixture and verify completion'}])),
        readiness: 1, intent_to_proceed: true, candidate_question: null, discovery: [], early_exit: false, abandon: false}),
      plan: input => Promise.resolve({intake_id: input.intake_id, revision: input.revision, work_order: {objective: 'Run fixture', scope_in: ['fixture'], acceptance: ['completion']}}),
      resolveCancelTarget: () => Promise.resolve(null),
    }},
  })
  const events: EventRecord[] = []
  core.runtime.observe(event => events.push(event))
  let deliveredResponses = 0
  const finishHostResponses = async () => {
    await yieldTurn()
    await realtime.service.flushHostItems()
    while (deliveredResponses < responses.length) {
      assert.ok(deliveredResponses < 20, 'host response script must settle')
      const response_id = `host-response-${++deliveredResponses}`
      await realtime.service.handleEvent({kind: 'response_started', session_epoch: 1, response_id})
      await realtime.service.handleEvent({kind: 'response_terminal', session_epoch: 1, response_id, status: 'completed', reason: ''})
      await yieldTurn()
      await realtime.service.flushHostItems()
    }
  }
  const submit = async (turn: string, text: string, name: string, args: JsonObject) => {
    const service = realtime.service
    await service.localSpeechOnset(`onset-${turn}`)
    await service.handleEvent({kind: 'user_speech_started', session_epoch: 1, speech_id: turn, provider_item_id: `user-${turn}`})
    await service.handleEvent({kind: 'user_speech_ended', session_epoch: 1, speech_id: turn, provider_item_id: `user-${turn}`})
    await service.handleEvent({kind: 'user_transcript_final', session_epoch: 1, item_id: `user-${turn}`, text})
    await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: `response-${turn}`})
    await service.handleEvent({kind: 'tool_call_ready', session_epoch: 1, call_id: `call-${turn}`, item_id: `tool-${turn}`, response_id: `response-${turn}`, name, arguments: args})
    await service.handleEvent({kind: 'response_terminal', session_epoch: 1, response_id: `response-${turn}`, status: 'completed', reason: ''})
  }
  await realtime.start()
  try {
    assert.match(JSON.stringify(schemas), /fixture/u)
    assert.doesNotMatch(JSON.stringify(schemas), /fixture__/u)
    await submit('dispatch', '新建 Fixture Project，运行 fixture 并验证完成。', 'dispatch', {executor: 'fixture', instruction: '新建 Fixture Project，运行 fixture 并验证完成。'})
    await until(() => fixture.confirmation.pending)
    assert.equal(fixture.dispatched.length, 0, 'planning and proposal are not execution authority')
    await finishHostResponses()
    const proposal = fixture.confirmation.view.pending_confirmation_id!
    await realtime.service.handleEvent({kind: 'tool_call_ready', session_epoch: 0, call_id: 'stale-project', item_id: 'stale-project', response_id: 'response-dispatch', name: 'confirm', arguments: {id: proposal, accepted: true}})
    assert.equal(fixture.commits.length, 0, 'an earlier provider epoch cannot confirm a proposal')
    await submit('project', '确认', 'confirm', {id: proposal, accepted: true})
    await until(() => fixture.approval.pending)
    assert.equal(fixture.commits.length, 1)
    assert.equal(fixture.dispatched.length, 1)
    assert.equal(fixture.dispatched[0]!.delegate.executor, 'fixture')
    assert.ok(events.some(event => event.kind === 'progress'))
    await finishHostResponses()
    const approvalId = fixture.approval.view.pending_approval_id!
    assert.equal(fixture.approval.acceptDecision({approvalId: 'wrong-id', decision: 'accept'}), false)
    await submit('approval', '同意', 'confirm', {id: approvalId, accepted: true})
    await until(() => events.some(event => event.kind === 'handoff'))
    assert.equal(fixture.approval.pending, false)
    const handoff = events.find(event => event.kind === 'handoff')!
    assert.equal(handoff.payload.outcome, 'ok')
    assert.deepEqual(handoff.payload.content.result, {final_message: {text: 'Fixture completed', truncated: false}})
    assert.equal(core.runtime.claimedHandoff(handoff.seq)?.executor, 'fixture')
    await finishHostResponses()
    assert.ok(injected.some(item => item.kind === 'tool_output'))
    assert.ok(injected.some(item => item.kind === 'final' && item.content.includes('Fixture completed')), 'terminal handoff reaches host delivery')
    assert.equal(projectCommitFailureText('busy', fixture.adapter.manifest.display_name), 'Fixture Worker 当前正忙，本次操作未执行。')
    assert.equal(fixture.confirmation.claimConfirmed(fixture.commits[0]!), false, 'confirmed identity cannot replay')
    const loaded = await loadedModules()
    assert.ok(loaded.length > 30, 'module instrumentation must see actual transitive host loads')
    assert.ok([...loaded].some(url => url.endsWith('/src/realtime/service.js')))
    assert.deepEqual([...loaded].filter(url => /\/executors\/codex\//iu.test(url)), [])
    t.diagnostic(`ESM loader observed ${loaded.length} modules; no Codex executor module loaded`)
  } finally {
    await realtime.stop()
    port1.close()
  }
})


test('boundary checker sees every case and budgets exact lines without substring overlap', () => {
  const checker = new URL('../../scripts/check-executor-boundary.mjs', import.meta.url)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {scanCore, unlistedHits, staleEntries} from ${JSON.stringify(checker.href)};
    const hits = scanCore();
    for (const spelling of ['codex', 'Codex', 'CODEX']) assert.ok(hits.some(hit => hit.match === spelling));
    const entries = [{path: 'core.ts', pattern: 'CODEX_HOME', reason: 'legacy environment name'}];
    const exact = {path: 'core.ts', text: '  CODEX_HOME  '};
    assert.deepEqual(unlistedHits([exact], entries), []);
    assert.equal(unlistedHits([exact, exact], entries).length, 1);
    assert.equal(unlistedHits([{...exact, text: 'const secret = CODEX_HOME'}], entries).length, 1);
    assert.equal(staleEntries([], entries).length, 1);
    assert.equal(staleEntries([exact], entries).length, 0);
  `], {encoding: 'utf8'})
  assert.equal(result.status, 0, result.stderr)
})
