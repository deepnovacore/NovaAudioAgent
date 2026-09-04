import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  createAgentControllerRegistry,
  type AgentController,
  type AgentDescriptor,
} from '../src/agent-controller.js'
import {CodexAgentController} from '../src/executors/codex/controller.js'
import {handoffPolicySchema} from '../src/memory.js'
import {executorManifestSchema} from '../src/ports.js'
import {activeExecutorContextData} from '../src/realtime/session-state.js'
import {compileToolSchema} from '../src/tool-schema.js'

const policy = (channel: string) => handoffPolicySchema.parse({
  channel, priority: 50, wake: 'fast', typical_latency: 5, compress_watermark: 8,
})

const operations = [
  {
    name: 'run', description: 'run',
    params: {
      type: 'object', properties: {work_order: {type: 'string'}}, required: ['work_order'],
      additionalProperties: false,
    },
  },
  {name: 'status', description: 'status', params: {type: 'object', properties: {}}, readonly: true},
] as const

function manifest(name: string, modelVisibility: 'direct' | 'hidden' = 'direct') {
  return executorManifestSchema.parse({
    name, display_name: name, model_visibility: modelVisibility, policy: policy(name), ops: operations,
  })
}

function controller(descriptor: AgentDescriptor): AgentController {
  return {
    descriptor,
    dispatch: async () => ({code: 'accepted', accepted: true, detail: {}}),
    cancel: async () => ({code: 'accepted', accepted: true, detail: {}}),
  }
}

test('controller descriptors, not manifests, determine the dispatch and cancel enum', () => {
  const codex = manifest('codex', 'hidden')
  const descriptor = {
    name: 'coding_agent',
    summary: '在项目工作区执行编码任务',
    ownedChannels: ['codex'],
  } as const

  const tools = compileToolSchema([codex], {agentDescriptors: [descriptor]})
  const names = tools.schemas.map(schema => String((schema.function as {name: string}).name))
  assert.deepEqual(names, ['dispatch', 'cancel', 'confirm'])
  assert.deepEqual(
    ((tools.schemas[0]!.function as {parameters: {properties: {executor: {enum: unknown}}}})
      .parameters.properties.executor.enum),
    ['coding_agent'],
  )
  assert.match(String((tools.schemas[0]!.function as {description: string}).description), /coding_agent: 在项目工作区执行编码任务/u)
  assert.deepEqual([...tools.hidden], ['codex__run', 'codex__status'])
  assert.equal(tools.bindings.get('codex__run')?.executor, 'codex', 'hidden bindings remain runtime-routable')
})

test('agent registration closes controller names, owned channels, manifests, and hidden executors', () => {
  const hidden = manifest('codex', 'hidden')
  const direct = manifest('watch')
  const coder = controller({name: 'coder', summary: '编码', ownedChannels: ['codex']})

  const registry = createAgentControllerRegistry({controllers: [coder], manifests: [hidden, direct]})
  assert.equal(registry.controllers.get('coder'), coder)
  assert.equal(registry.agentNameForChannel('codex'), 'coder')
  assert.equal(registry.agentNameForChannel('watch'), null)
  assert.equal(activeExecutorContextData([['d-1', {
    summary: 'task', state: 'running', channel: 'codex', progress_summary: null, internal_activity: 0, elapsed: 0,
  }]], registry.agentNameForChannel).delegates[0]?.host_state.channel, 'coder')

  assert.throws(
    () => createAgentControllerRegistry({controllers: [coder, controller({...coder.descriptor})], manifests: [hidden]}),
    /duplicate agent name.*coder/iu,
  )
  assert.throws(
    () => createAgentControllerRegistry({controllers: [
      coder,
      controller({name: 'another', summary: 'another', ownedChannels: ['codex']}),
    ], manifests: [hidden]}),
    /duplicate owned channel.*codex/iu,
  )
  assert.throws(
    () => createAgentControllerRegistry({controllers: [
      controller({name: 'missing', summary: 'missing', ownedChannels: ['not_registered']}),
    ], manifests: [hidden]}),
    /owned channel.*not_registered.*registered manifest/iu,
  )
  assert.throws(
    () => createAgentControllerRegistry({controllers: [], manifests: [hidden]}),
    /hidden executor.*codex.*owning controller/iu,
  )
})

test('agent registry rejects blank public descriptor labels', () => {
  const direct = manifest('direct')
  assert.throws(
    () => createAgentControllerRegistry({
      controllers: [controller({name: ' \t', summary: 'valid', ownedChannels: ['direct']})],
      manifests: [direct],
    }),
    /agent name must not be blank/iu,
  )
  assert.throws(
    () => createAgentControllerRegistry({
      controllers: [controller({name: 'valid', summary: ' \t', ownedChannels: ['direct']})],
      manifests: [direct],
    }),
    /agent summary must not be blank.*valid/iu,
  )
})

test('the Codex controller preserves intake dispatch and forwards the revision fence to cancellation', async () => {
  const opened: unknown[][] = []
  const intake = {
    get view() {
      return {state: 'open'}
    },
    open(...arguments_: unknown[]) {
      opened.push(arguments_)
      return 'intake_opened' as const
    },
  }
  let cancelInstruction: string | undefined
  let cancelStillWanted: (() => boolean) | undefined
  const codex = new CodexAgentController({
    intake: intake as never,
    executor: {
      cancel: async (instruction, context) => {
        cancelInstruction = instruction
        cancelStillWanted = context.stillWanted
        return {code: 'cancelled' as const, work: {work_id: 'w-1', project: 'site', title: '布局'}}
      },
    },
    resolveCancelTarget: () => Promise.resolve(null),
  })

  const dispatch = await codex.dispatch({
    instruction: '修复布局', originalUserText: '修复布局', origin_ref: 'conversation:4',
    sessionEpoch: 9, acceptedUserInputRevision: 12, stillWanted: () => true,
  })
  assert.deepEqual(dispatch, {code: 'intake_opened', accepted: true, detail: {state: 'open'}})
  assert.deepEqual(opened, [[
    {work_order: '修复布局', project: null, session: 'latest'},
    '修复布局', 'conversation:4', '9',
  ]])

  const superseded = await codex.dispatch({
    instruction: '不应打开', originalUserText: '不应打开', origin_ref: 'conversation:4',
    sessionEpoch: 9, acceptedUserInputRevision: 13, stillWanted: () => false,
  })
  assert.deepEqual(superseded, {code: 'superseded', accepted: false, detail: {}})
  assert.equal(opened.length, 1, 'a stale revision cannot open intake')

  let currentRevision = 12
  const cancellation = await codex.cancel({
    instruction: '停止布局任务', originalUserText: '停止布局任务', origin_ref: 'conversation:5',
    sessionEpoch: 9, acceptedUserInputRevision: 12, stillWanted: () => currentRevision === 12,
  })
  currentRevision += 1
  assert.equal(cancelInstruction, '停止布局任务')
  assert.equal(cancelStillWanted?.(), false, 'the executor receives the exact revision fence')
  assert.deepEqual(cancellation, {
    code: 'cancelled', accepted: true,
    detail: {work: {work_id: 'w-1', project: 'site', title: '布局'}},
  })
  assert.equal(Object.hasOwn(cancellation, 'message'), false, 'controllers return structured facts, not user prose')
})
