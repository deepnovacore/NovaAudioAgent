import assert from 'node:assert/strict'
import test from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import {readLocalCodexSessions} from '../src/executors/codex/local-sessions.js'
import {rm, realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {fixture} from './fixtures/codex/project-adapter-fixture.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {createConversation} from '../src/personal-agent/conversations.js'
import {settingsSchema} from '../src/config/config.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {codexAgentDescriptor, codingAgentControllerFactory} from '../src/executors/codex/controller.js'

test('a genuinely stale persisted coding target clears with a notice while ordinary text still works', async () => {
  const value = await fixture({preexistingSession: true})
  const host = new PersonalAgentHost({path: join(await realpath(value.root), 'personal.json'), userScope: 'test', memory: () => undefined,
    pool: new SuggestionPool(), evidence: () => null})
  try {
    await host.open()
    await value.adapter.initialize()
    const target = await value.adapter.targetPort.validate((await value.adapter.targetPort.list()).find(item => item.session_id !== null)!)
    await host.rememberCodingTarget('chat:main', 0, target, () => true)
    await value.store.markSessionUnavailable(target.session_id!, {wait: true})
    const notices: Record<string, unknown>[] = []
    const diagnostics: string[] = []
    const factory = conversationRuntimeFactory({host, memory: () => undefined,
      settings: settingsSchema.parse({executors: ['codex'], camera_module_enabled: false, cascade_llm_provider: 'qwen', dashscope_api_key: 'test'}),
      codexResource: {mode: 'project', adapter: value.adapter, approvalController: null, projectView: null,
        agentDescriptor: codexAgentDescriptor('codex'), agentControllerFactory: codingAgentControllerFactory,
        start: () => value.adapter.initialize(), close: () => value.adapter.close()},
      searchTransport: {search: () => Promise.reject(Error('unexpected search'))},
      gateway: {complete: () => Promise.reject(Error('unexpected model')), async *stream() { await Promise.resolve(); throw Error('unexpected stream') }},
      onDiagnostic: message => { diagnostics.push(message) },
      createTextProvider: options => buildCascadedTextProvider(options, {...cascadedProviderRegistries, llm: {...cascadedProviderRegistries.llm,
        qwen: () => ({open: () => ({
          async *stream() { await Promise.resolve(); yield {kind: 'response_started', response_id: 'reply'}; yield {kind: 'text_delta', text: 'ordinary reply'}; yield {kind: 'response_completed', response_id: 'reply'} },
          restoreHistory: () => Promise.resolve(), abandonPendingResponse: () => Promise.resolve(), close: () => Promise.resolve(),
        })}),
      }}),
    })
    const conversation = createConversation('chat', 'Main', null, 'chat:main')
    conversation.coding_target = target
    const runtime = await factory(conversation, event => { if (event.type === 'conversation.notice') notices.push(event) })
    try {
      assert.equal(host.conversationSnapshot().items.find(item => item.id === 'chat:main')?.coding_target, null)
      assert.equal(notices[0]?.code, 'coding_target_unavailable')
      assert.match(String(notices[0]?.message), /继续聊天/u)
      assert.ok(diagnostics.includes('[runtime-diagnostic] coding_target_unavailable'))
      assert.equal((await runtime.runTurn('hello', AbortSignal.timeout(5000))).assistant, 'ordinary reply')
      assert.equal(value.factory.calls.length, 0, 'recovery must not run the global active coding target')
    } finally { await runtime.close() }
  } finally {
    await host.close()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})


test('exact external catalog lookup survives the discovery cap and still rejects archived sessions', async () => {
  const value = await fixture()
  const db = new DatabaseSync(join(value.root, 'state_5.sqlite'))
  try {
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER)')
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('old-thread', 'Old task', value.root, 'cli', 0, 0)
    for (let index = 0; index < 200; index++) insert.run(`new-${index}`, 'New task', value.root, 'cli', 0, index + 1)
    assert.equal((await readLocalCodexSessions(value.root)).some(item => item.threadId === 'old-thread'), false)
    assert.equal((await readLocalCodexSessions(value.root, 'old-thread'))[0]?.threadId, 'old-thread')
    db.prepare('UPDATE threads SET archived = 1 WHERE id = ?').run('old-thread')
    assert.deepEqual(await readLocalCodexSessions(value.root, 'old-thread'), [])
  } finally {
    db.close()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('host restart with an unfinished task restores the live coding_target into the conversation runtime', async () => {
  const value = await fixture({preexistingSession: true})
  const path = join(await realpath(value.root), 'personal.json')
  const host1 = new PersonalAgentHost({path, userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  try {
    await host1.open()
    await value.adapter.initialize()
    const target = await value.adapter.targetPort.validate((await value.adapter.targetPort.list()).find(item => item.session_id !== null)!)
    await host1.rememberCodingTarget('chat:main', 0, target, () => true)
    const task = await host1.tasks.delegate('first', {conversation_id: 'chat:main', conversation_generation: 0, goal: 'Continue', acceptance: ['done'], origin_ref: 'conversation:1', execution_route: 'codex'})
    await host1.tasks.bindWork({task_id: task.id, control_revision: 0, goal_revision: 0}, 'work:1', target.session_id!)
    await host1.close()
    const validated: unknown[] = []
    const originalValidate = value.adapter.targetPort.validate.bind(value.adapter.targetPort)
    value.adapter.targetPort.validate = async selection => { validated.push(selection); return originalValidate(selection) }
    const host2 = new PersonalAgentHost({path, userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
    try {
      const factory = conversationRuntimeFactory({host: host2, memory: () => undefined,
        settings: settingsSchema.parse({executors: ['codex'], camera_module_enabled: false, cascade_llm_provider: 'qwen', dashscope_api_key: 'test'}),
        codexResource: {mode: 'project', adapter: value.adapter, approvalController: null, projectView: null,
          agentDescriptor: codexAgentDescriptor('codex'), agentControllerFactory: codingAgentControllerFactory,
          start: () => value.adapter.initialize(), close: () => value.adapter.close()},
        searchTransport: {search: () => Promise.reject(Error('unexpected search'))},
        gateway: {complete: () => Promise.reject(Error('unexpected model')), async *stream() { await Promise.resolve(); throw Error('unexpected stream') }},
        createTextProvider: options => buildCascadedTextProvider(options, {...cascadedProviderRegistries, llm: {...cascadedProviderRegistries.llm,
          qwen: () => ({open: () => ({
            async *stream() { await Promise.resolve(); yield {kind: 'response_started', response_id: 'reply'}; yield {kind: 'text_delta', text: 'ok'}; yield {kind: 'response_completed', response_id: 'reply'} },
            restoreHistory: () => Promise.resolve(), abandonPendingResponse: () => Promise.resolve(), close: () => Promise.resolve(),
          })}),
        }}),
      })
      host2.setConversationRuntime(factory, () => { /* history is not asserted here */ })
      await host2.open()
      assert.ok(validated.some(item => item && typeof item === 'object' && 'session_id' in item && (item as {session_id: string}).session_id === target.session_id))
      assert.deepEqual(host2.conversationSnapshot().items.find(item => item.id === 'chat:main')?.coding_target, {
        workspace_id: target.workspace_id, session_id: target.session_id, project: target.project, title: target.title, executor: target.executor,
      })
    } finally { await host2.close() }
  } finally {
    await host1.close().catch(() => { /* already closed by the test body */ })
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})
