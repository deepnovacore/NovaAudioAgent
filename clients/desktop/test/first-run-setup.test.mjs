import assert from 'node:assert/strict'
import {test} from 'node:test'
import {probeApiKey} from '../src/main/key-probe.mjs'
import {setupCommit} from '../src/main/setup-choice.mjs'

const response = status => ({ok: status >= 200 && status < 300, status, body: {cancel: () => Promise.resolve()}})

test('key probe classifies a model listing and never returns the key', async () => {
  const requests = []
  const fetch = status => (url, init) => { requests.push({url, init}); return Promise.resolve(response(status)) }
  assert.deepEqual(await probeApiKey('dashscopeApiKey', ' sk-private ', {fetch: fetch(200)}), {status: 'ok'})
  assert.equal(requests[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/models')
  assert.equal(requests[0].init.headers.authorization, 'Bearer sk-private')
  for (const status of [401, 403]) {
    const result = await probeApiKey('deepseekApiKey', 'sk-private', {fetch: fetch(status)})
    assert.deepEqual(result, {status: 'rejected', httpStatus: status})
  }
  assert.equal((await probeApiKey('arkApiKey', 'sk-private', {fetch: fetch(503)})).status, 'network')
  assert.deepEqual(await probeApiKey('arkApiKey', 'sk-private', {fetch: () => Promise.reject(new Error('sk-private'))}), {status: 'network'})
  assert.equal(requests.at(-1).url, 'https://ark.cn-beijing.volces.com/api/v3/models')
})

test('key probe does not call out for empty, deferred or unknown keys', async () => {
  const fetch = () => assert.fail('no request expected')
  assert.equal((await probeApiKey('dashscopeApiKey', '  ', {fetch})).status, 'missing')
  assert.equal((await probeApiKey('dashscopeApiKey', 'sk\nx', {fetch})).status, 'missing')
  assert.equal((await probeApiKey('doubaoBigmodelApiKey', 'voice', {fetch})).status, 'deferred')
  assert.equal((await probeApiKey('tavilyApiKey', 'tvly', {fetch})).status, 'unsupported')
})

test('setup accepts only the chosen pipeline and its own keys', () => {
  assert.deepEqual(setupCommit({pipelineMode: 'integrated', secrets: {dashscopeApiKey: ' sk-1 '}}),
    {settingsPatch: {pipelineMode: 'integrated', secrets: {dashscopeApiKey: 'sk-1'}}})
  // Keeping a saved key: an empty field sends no secret.
  assert.deepEqual(setupCommit({pipelineMode: 'integrated', secrets: {dashscopeApiKey: ''}}), {settingsPatch: {pipelineMode: 'integrated'}})
  assert.deepEqual(setupCommit({pipelineMode: 'cascaded', cascadedLlmProvider: 'deepseek', secrets: {deepseekApiKey: 'd', doubaoBigmodelApiKey: 'v'}}),
    {settingsPatch: {pipelineMode: 'cascaded', cascadedLlmProvider: 'deepseek', secrets: {deepseekApiKey: 'd', doubaoBigmodelApiKey: 'v'}}})
  for (const choice of [
    null,
    {pipelineMode: 'other'},
    {pipelineMode: 'cascaded', cascadedLlmProvider: 'openai'},
    {pipelineMode: 'integrated', secrets: {deepseekApiKey: 'd'}},
    {pipelineMode: 'cascaded', cascadedLlmProvider: 'ark', secrets: {deepseekApiKey: 'd'}},
    {pipelineMode: 'integrated', secrets: {tavilyApiKey: 't'}},
  ]) assert.throws(() => setupCommit(choice), /invalid setup choice/u)
})

test('settings explain an unconfigured or switched module from the runtime reason', async () => {
  const {moduleStatusNote} = await import('../src/renderer/capabilities-editor.mjs')
  assert.equal(moduleStatusNote({enabled: false, reason: 'missing_environment:DASHSCOPE_API_KEY'}), '未配置 · 需要 DASHSCOPE_API_KEY')
  assert.equal(moduleStatusNote({enabled: true, fallback: 'bailian_mcp', reason: 'missing_environment:TAVILY_API_KEY'}), '未配置 TAVILY_API_KEY，改用百炼联网搜索')
  assert.equal(moduleStatusNote({enabled: false}), '')
  assert.equal(moduleStatusNote({enabled: false, reason: 'private secret'}), '')
  assert.equal(moduleStatusNote(undefined), '')
})

async function loadSetupPage(t, api) {
  const element = (extra = {}) => {
    const listeners = {}
    return {dataset: {}, hidden: false, disabled: false, textContent: '', value: '', placeholder: '', listeners,
      addEventListener: (type, listener) => { listeners[type] = listener },
      setAttribute(name, value) { this[name] = value }, getAttribute(name) { return this[name] ?? null }, focus() {}, ...extra}
  }
  const input = element({value: 'sk-new'})
  const row = element({dataset: {key: 'dashscopeApiKey'}})
  const parts = {input, '.test': element(), '.key-result': element(), label: element({textContent: 'DashScope API Key'})}
  row.querySelector = selector => parts[selector] ?? null
  const radio = element({value: 'integrated', checked: true})
  const nodes = {'#status': element(), '#start': element(), '#llm-provider': element({value: 'deepseek'}),
    '#integrated-fields': element(), '#cascaded-fields': element(), 'input[name="pipeline"]:checked': radio}
  const lists = {'.key-row input': [input], 'input[name="pipeline"]': [radio], '.key-row': [row], '#integrated-fields .key-row': [row]}
  let closed = 0
  const previous = {document: globalThis.document, window: globalThis.window}
  globalThis.document = {documentElement: {}, createTreeWalker: () => ({nextNode: () => null}),
    querySelector: selector => nodes[selector] ?? (selector.startsWith('input[name="pipeline"][value=') ? radio : null),
    querySelectorAll: selector => lists[selector] ?? []}
  globalThis.window = {close: () => { closed++ }, novaAudioAgentDesktop: {setup: api}}
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete globalThis[name]; else globalThis[name] = value
  })
  await import(`../src/renderer/setup.mjs?case=${Math.random()}`)
  return {start: () => nodes['#start'].listeners.click(), status: () => nodes['#status'].textContent, closed: () => closed}
}

test('setup closes only after the restart it caused has connected', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const view = backendStatus => ({backendStatus, missing: [], secretsPresent: {dashscopeApiKey: true}, pipelineMode: 'integrated', cascadedLlmProvider: 'deepseek'})
  let push
  let finishSave
  const page = await loadSetupPage(t, {
    status: async () => view('connected'),
    onChanged: listener => { push = listener },
    save: () => new Promise(resolve => { finishSave = resolve }),
  })
  page.start()
  // The old backend is still connected while the save is in flight.
  push(view('connected'))
  t.mock.timers.tick(2000)
  assert.equal(page.closed(), 0)
  push(view('starting'))
  finishSave({saved: true, rejectedSecrets: []})
  await new Promise(resolve => setImmediate(resolve))
  push(view('authentication_failed'))
  t.mock.timers.tick(2000)
  assert.equal(page.closed(), 0)
  assert.match(page.status(), /启动失败/u)

  page.start()
  push(view('starting'))
  push(view('connected'))
  push(view('connected'))
  t.mock.timers.tick(1200)
  assert.equal(page.closed(), 1)
})

test('first-run setup ignores missing keys left over from the previous launch', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const view = (backendStatus, missing = []) => ({backendStatus, missing, secretsPresent: {}, pipelineMode: 'integrated'})
  let push
  const page = await loadSetupPage(t, {
    status: async () => view('configuration_required', ['DASHSCOPE_API_KEY']),
    onChanged: listener => { push = listener },
    save: async () => ({saved: true, rejectedSecrets: []}),
  })
  page.start()
  push(view('starting', ['DASHSCOPE_API_KEY']))
  push(view('connected'))
  t.mock.timers.tick(1200)
  assert.equal(page.closed(), 1)
})
