import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {
  FRONTEND_INSTRUCTIONS,
  GUARD_ACTIVATION_PREFIX,
  MAX_QWEN_EVENT_QUEUE,
  QwenAudioRealtimeAdapter,
  QwenRealtimeError,
  QwenSocketClosedError,
  workspaceGraphFrontendInstructions,
  type QwenSocket,
} from '../src/realtime/qwen.js'
import { ItemDeliveryUncertainError, type RealtimeProviderEvent } from '../src/realtime/protocol.js'

const execFileAsync = promisify(execFile)

interface Scripted {
  readonly socket: QwenSocket
  readonly sent: Record<string, unknown>[]
  push(frame: Record<string, unknown>): void
  end(): void
}

/** A socket whose inbound frames are scripted and whose outbound frames are recorded. */
function scriptedSocket(initial: Record<string, unknown>[] = []): Scripted {
  const inbound: (Record<string, unknown> | null)[] = [...initial]
  const sent: Record<string, unknown>[] = []
  let wake: (() => void) | undefined
  const socket: QwenSocket = {
    send(payload) {
      sent.push(JSON.parse(payload) as Record<string, unknown>)
      return Promise.resolve()
    },
    async receive() {
      while (inbound.length === 0) {
        await new Promise<void>(resolve => { wake = resolve })
      }
      const next = inbound.shift()
      if (next === null || next === undefined) throw new QwenSocketClosedError()
      return JSON.stringify(next)
    },
    async close() { /* nothing to release */ },
  }
  return {
    socket,
    sent,
    push(frame) { inbound.push(frame); wake?.(); wake = undefined },
    end() { inbound.push(null); wake?.(); wake = undefined },
  }
}

function ids(): () => string {
  let sequence = 0
  return () => { sequence += 1; return `id-${sequence}` }
}

function adapterFor(scripted: Scripted, overrides: Record<string, unknown> = {}) {
  return new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'test-key',
    model: 'qwen-audio-3.0-realtime-plus',
    voice: 'longanqian',
    connector: () => Promise.resolve(scripted.socket),
    idFactory: ids(),
    ...overrides,
  })
}

const handshake = [
  {type: 'session.created', session: {id: 'sess-1'}},
  {type: 'session.updated', session: {id: 'sess-1'}},
]

function workspaceHeader(
  revision: number,
  workspaceInstanceId = 'wi-a',
): {
  readonly kind: 'workspace_context'
  readonly host_item_id: string
  readonly event_id: string
  readonly content: string
  readonly call_id: null
  readonly session_epoch: 1
  readonly workspace_instance_id: string
  readonly revision: number
} {
  return {
    kind: 'workspace_context',
    host_item_id: `workspace-header-${revision}`,
    event_id: `workspace-event-${revision}`,
    content: `<workspace_context kind="data">revision ${revision}</workspace_context>`,
    call_id: null,
    session_epoch: 1,
    workspace_instance_id: workspaceInstanceId,
    revision,
  }
}

async function injectConfirmedWorkspaceHeader(
  adapter: QwenAudioRealtimeAdapter,
  scripted: Scripted,
  item = workspaceHeader(1),
) {
  const pending = adapter.injectWorkspaceContext(item, {
    confirmationTimeout: 1,
    signal: new AbortController().signal,
  })
  await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.create'))
  const creates = scripted.sent.filter(frame => frame.type === 'conversation.item.create')
  const providerItem = creates.at(-1)?.item as Record<string, unknown>
  scripted.push({type: 'conversation.item.created', item: {id: providerItem.id}})
  return {proof: await pending, providerItem}
}

test('connect performs the Qwen handshake and never logs the credential', async () => {
  const scripted = scriptedSocket([...handshake])
  let seenHeaders: Record<string, string> = {}
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'secret-key-value',
    model: 'qwen-audio-3.0-realtime-plus',
    voice: 'longanqian',
    idFactory: ids(),
    connector: options => {
      seenHeaders = {...options.headers}
      assert.equal(options.endpoint,
        'wss://example.invalid/realtime?model=qwen-audio-3.0-realtime-plus')
      return Promise.resolve(scripted.socket)
    },
  })

  const identity = await adapter.connect({tools: [], signal: new AbortController().signal})
  assert.deepEqual(identity, {epoch: 1, provider_session_id: 'sess-1'})
  assert.equal(seenHeaders.Authorization, 'Bearer secret-key-value')

  const update = scripted.sent.find(frame => frame.type === 'session.update')
  assert.ok(update !== undefined)
  const session = update.session as Record<string, unknown>
  assert.deepEqual(session.modalities, ['audio', 'text'])
  assert.equal(session.voice, 'longanqian')
  assert.equal(session.input_audio_format, 'pcm')
  assert.equal(session.output_audio_format, 'pcm')
  assert.equal(session.max_history_turns, 20)
  assert.deepEqual(session.turn_detection, {type: 'smart_turn'})
  assert.equal(session.instructions, FRONTEND_INSTRUCTIONS)
  // A credential must never ride along inside the session payload.
  assert.doesNotMatch(JSON.stringify(update), /secret-key-value/u)
})

test('retiring a host item uses the provider conversation item id', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})

  const retirement = adapter.retireHostItem(
    'provider-host-1',
    new AbortController().signal,
  )
  await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.delete'))
  const deletion = scripted.sent.find(frame => frame.type === 'conversation.item.delete')
  assert.equal(deletion?.type, 'conversation.item.delete')
  assert.equal(deletion?.item_id, 'provider-host-1')
  scripted.push({type: 'conversation.item.deleted', item_id: 'provider-host-1'})
  await retirement
  await adapter.close()
})

test('a session id that changes between created and updated is rejected', async () => {
  const scripted = scriptedSocket([
    {type: 'session.created', session: {id: 'sess-1'}},
    {type: 'session.updated', session: {id: 'sess-2'}},
  ])
  const adapter = adapterFor(scripted)
  await assert.rejects(
    adapter.connect({tools: [], signal: new AbortController().signal}),
    (error: unknown) => error instanceof QwenRealtimeError
      && error.message.includes('session identity changed'),
  )
})

test('connect refuses a second concurrent session', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  await assert.rejects(
    adapter.connect({tools: [], signal: new AbortController().signal}),
    /already connected/u,
  )
})

test('audio is appended as base64 and a closed socket is swallowed', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})

  await adapter.sendAudio(new Uint8Array([0, 1, 2, 3]), new AbortController().signal)
  const append = scripted.sent.find(frame => frame.type === 'input_audio_buffer.append')
  assert.ok(append !== undefined)
  assert.equal(append.audio, Buffer.from([0, 1, 2, 3]).toString('base64'))

  await assert.rejects(
    adapter.sendAudio(new Uint8Array([1]), new AbortController().signal),
    /aligned PCM16/u,
  )
})

test('a host fact uses the official user-role activation shape and keeps host provenance', async () => {
  for (const asUserActivation of [false, true]) {
    const scripted = scriptedSocket([...handshake])
    const adapter = adapterFor(scripted)
    await adapter.connect({tools: [], signal: new AbortController().signal})

    const injection = adapter.injectHostItem({
      kind: 'progress',
      host_item_id: 'host-1',
      event_id: 'ev-1',
      content: '任务正在处理',
      call_id: null,
    }, {confirmationTimeout: 1, asUserActivation, signal: new AbortController().signal})

    // The adapter allocates the provider item id from the injected factory.
    await Promise.resolve()
    const create = scripted.sent.find(frame => frame.type === 'conversation.item.create')
    assert.ok(create !== undefined, 'the item create frame must be sent')
    const item = create.item as Record<string, unknown>
    assert.equal(item.type, 'message')
    assert.equal(item.role, 'user')
    const content = item.content as {text: string}[]
    assert.ok(content[0]!.text.startsWith(GUARD_ACTIVATION_PREFIX))
    assert.match(content[0]!.text, /以下内容不是用户说的话/u)
    assert.match(content[0]!.text, /Nova Audio Agent 任务进度事实：任务正在处理/u)

    scripted.push({type: 'conversation.item.created', item: {id: item.id}})
    const identity = await injection
    assert.deepEqual(identity, {
      session_epoch: 1,
      host_item_id: 'host-1',
      provider_item_id: item.id,
    })
  }
})

test('a host response disables tools and targets only the injected fact', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})

  await adapter.createResponse({
    kind: 'host_fact',
    item: {
      kind: 'final',
      host_item_id: 'guard-result-host',
      event_id: 'guard-result-event',
      content: '检测到水杯已移动。',
      call_id: null,
    },
    task_summary: null,
    origin_spoken: false,
  }, new AbortController().signal)

  const frame = scripted.sent.at(-1)
  assert.equal(typeof frame?.event_id, 'string')
  assert.deepEqual(frame, {
    event_id: frame?.event_id,
    type: 'response.create',
    response: {
      modalities: ['audio', 'text'],
      tool_choice: 'none',
      instructions: 'Nova Audio Agent host 已注入一条新事实。只转述最后一条尚未转述的 host 事实一次；不得调用工具，不得重复更早的提交、启动、进度或确认结果。',
    },
  })

  await adapter.ensureResponse(new AbortController().signal)
  const retry = scripted.sent.at(-1)
  assert.deepEqual(retry, {
    event_id: retry?.event_id,
    type: 'response.create',
    response: {modalities: ['audio', 'text']},
  }, 'a same-user-turn retry keeps the confirmation tool available')
})

test('a final host fact carries an item-local one-shot response instruction', async () => {
  for (const asUserActivation of [false, true]) {
    const scripted = scriptedSocket([...handshake])
    const adapter = adapterFor(scripted)
    await adapter.connect({tools: [], signal: new AbortController().signal})

    const injection = adapter.injectHostItem({
      kind: 'final',
      host_item_id: 'final-host-1',
      event_id: 'final-event-1',
      content: '摄像头画面不可用，监控任务未启动。',
      call_id: null,
    }, {confirmationTimeout: 1, asUserActivation, signal: new AbortController().signal})

    await Promise.resolve()
    const create = scripted.sent.find(frame => frame.type === 'conversation.item.create')
    assert.ok(create !== undefined)
    const item = create.item as Record<string, unknown>
    const content = item.content as {text: string}[]
    assert.match(content[0]!.text, /摄像头画面不可用，监控任务未启动。/u)
    assert.match(content[0]!.text, /只转述这条结果一次/u)
    assert.match(content[0]!.text, /不得.*重复此前的任务提交、启动或进度/u)
    assert.match(content[0]!.text, /不要调用工具/u)

    scripted.push({type: 'conversation.item.created', item: {id: item.id}})
    await injection
  }
})

test('Qwen workspace header replacement proves delete-confirm before distinct create-confirm', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const firstItem = {
    kind: 'workspace_context',
    host_item_id: 'workspace-header-1',
    event_id: 'workspace-event-1',
    content: '<workspace_context kind="data">current workspace</workspace_context>',
    call_id: null,
    session_epoch: 1,
    workspace_instance_id: 'wi-a',
    revision: 1,
  } as const
  const first = adapter.injectWorkspaceContext(firstItem, {
    confirmationTimeout: 1,
    signal: new AbortController().signal,
  })
  await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.create'))
  const firstCreate = scripted.sent.find(frame => frame.type === 'conversation.item.create')
  assert.ok(firstCreate)
  const firstProviderItem = firstCreate.item as Record<string, unknown>
  scripted.push({type: 'conversation.item.created', item: {id: firstProviderItem.id}})
  const firstProof = await first
  assert.equal(firstProof.delivery.capability, 'replace_provider_item')
  assert.equal(firstProof.delivery.prior_provider_item_id, null)

  const replacement = adapter.injectWorkspaceContext({
    ...firstItem,
    host_item_id: 'workspace-header-2',
    event_id: 'workspace-event-2',
    revision: 2,
  }, {confirmationTimeout: 1, signal: new AbortController().signal})
  await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.delete'))
  const deletion = scripted.sent.find(frame => frame.type === 'conversation.item.delete')
  assert.equal(deletion?.item_id, firstProviderItem.id)
  assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.create').length, 1)
  scripted.push({type: 'conversation.item.deleted', item_id: firstProviderItem.id})
  await until(() => scripted.sent.filter(frame => frame.type === 'conversation.item.create').length === 2)
  const creates = scripted.sent.filter(frame => frame.type === 'conversation.item.create')
  assert.equal(creates.length, 2)
  const secondProviderItem = creates[1]!.item as Record<string, unknown>
  assert.notEqual(secondProviderItem.id, firstProviderItem.id)
  scripted.push({type: 'conversation.item.created', item: {id: secondProviderItem.id}})
  const proof = await replacement
  assert.equal(proof.asUserActivation, false)
  assert.deepEqual(proof.delivery, {
    capability: 'replace_provider_item',
    delivered: true,
    session_epoch: 1,
    workspace_instance_id: 'wi-a',
    revision: 2,
    prior_provider_item_id: firstProviderItem.id,
    superseded_provider_item_id: firstProviderItem.id,
    provider_item_id: secondProviderItem.id,
  })
  assert.equal(adapter.turnRecallContextCapability, 'unavailable')
})

test('Qwen workspace Header exact replay is idempotent and stale revisions never delete', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = workspaceHeader(1)
  const first = await injectConfirmedWorkspaceHeader(adapter, scripted, item)
  const before = scripted.sent.length

  assert.deepEqual(await adapter.injectWorkspaceContext(item, {
    confirmationTimeout: 1,
    signal: new AbortController().signal,
  }), first.proof)
  assert.equal(scripted.sent.length, before)
  assert.equal(Object.isFrozen(first.proof), true)
  assert.equal(Object.isFrozen(first.proof.item), true)
  assert.equal(Object.isFrozen(first.proof.delivery), true)

  await assert.rejects(adapter.injectWorkspaceContext({
    ...item,
    event_id: 'workspace-event-same-revision-but-different',
  }, {confirmationTimeout: 1, signal: new AbortController().signal}), /revision is stale/u)
  assert.equal(scripted.sent.length, before)

  await assert.rejects(adapter.injectWorkspaceContext({
    ...item,
    host_item_id: 'workspace-header-stale',
    event_id: 'workspace-event-stale',
    content: '<workspace_context kind="data">stale changed</workspace_context>',
  }, {confirmationTimeout: 1, signal: new AbortController().signal}), /revision is stale/u)
  assert.equal(scripted.sent.length, before)
})

test('three Qwen workspace switches prove two ordered deletions and leave one latest Header', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const first = await injectConfirmedWorkspaceHeader(adapter, scripted, workspaceHeader(1, 'wi-a'))
  let priorId = first.providerItem.id

  for (const [revision, workspaceId] of [[2, 'wi-b'], [3, 'wi-c']] as const) {
    const pending = adapter.injectWorkspaceContext(workspaceHeader(revision, workspaceId), {
      confirmationTimeout: 1,
      signal: new AbortController().signal,
    })
    await until(() => scripted.sent.filter(frame => frame.type === 'conversation.item.delete').length
      === revision - 1)
    const deletion = scripted.sent.filter(frame => frame.type === 'conversation.item.delete').at(-1)
    assert.equal(deletion?.item_id, priorId)
    assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.create').length,
      revision - 1)
    scripted.push({type: 'conversation.item.deleted', item_id: priorId})
    await until(() => scripted.sent.filter(frame => frame.type === 'conversation.item.create').length
      === revision)
    const created = scripted.sent.filter(frame => frame.type === 'conversation.item.create').at(-1)
      ?.item as Record<string, unknown>
    assert.notEqual(created.id, priorId)
    scripted.push({type: 'conversation.item.created', item: {id: created.id}})
    const proof = await pending
    if (proof.delivery.capability !== 'replace_provider_item') throw new TypeError()
    assert.equal(proof.delivery.prior_provider_item_id, priorId)
    assert.equal(proof.delivery.provider_item_id, created.id)
    priorId = created.id
  }
  assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.create').length, 3)
  assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.delete').length, 2)
})

test('concurrent Qwen Header requests serialize the whole delete-confirm-create-confirm operation', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})

  const first = adapter.injectWorkspaceContext(workspaceHeader(1, 'wi-a'), {
    confirmationTimeout: 1,
    signal: new AbortController().signal,
  })
  const second = adapter.injectWorkspaceContext(workspaceHeader(2, 'wi-b'), {
    confirmationTimeout: 1,
    signal: new AbortController().signal,
  })
  await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.create'))
  await Promise.resolve()
  assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.create').length, 1)

  const firstCreated = scripted.sent.find(frame => frame.type === 'conversation.item.create')
    ?.item as Record<string, unknown>
  scripted.push({type: 'conversation.item.created', item: {id: firstCreated.id}})
  await first
  await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.delete'))
  const deletion = scripted.sent.find(frame => frame.type === 'conversation.item.delete')
  assert.equal(deletion?.item_id, firstCreated.id)
  assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.create').length, 1)
  scripted.push({type: 'conversation.item.deleted', item_id: firstCreated.id})

  await until(() => scripted.sent.filter(frame => frame.type === 'conversation.item.create').length === 2)
  const secondCreated = scripted.sent.filter(frame => frame.type === 'conversation.item.create')
    .at(-1)?.item as Record<string, unknown>
  assert.notEqual(secondCreated.id, firstCreated.id)
  scripted.push({type: 'conversation.item.created', item: {id: secondCreated.id}})
  const secondProof = await second
  assert.equal(secondProof.delivery.capability, 'replace_provider_item')
  if (secondProof.delivery.capability !== 'replace_provider_item') assert.fail('replacement proof required')
  assert.equal(secondProof.delivery.prior_provider_item_id, firstCreated.id)
  assert.equal(secondProof.delivery.provider_item_id, secondCreated.id)
})

test('Qwen Header replacement refuses wrong, missing, and provider-error delete confirmations', async () => {
  for (const scenario of ['wrong', 'missing', 'provider_error'] as const) {
    const scripted = scriptedSocket([...handshake])
    const adapter = adapterFor(scripted)
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const first = await injectConfirmedWorkspaceHeader(adapter, scripted)
    const replacement = adapter.injectWorkspaceContext(workspaceHeader(2), {
      confirmationTimeout: scenario === 'missing' ? 0.02 : 1,
      signal: new AbortController().signal,
    })
    await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.delete'))
    if (scenario === 'wrong') {
      scripted.push({type: 'conversation.item.deleted', item_id: 'not-the-owned-item'})
    } else if (scenario === 'provider_error') {
      scripted.push({
        type: 'error',
        error: {code: 'invalid_value', param: 'conversation.item.delete'},
      })
    }
    await assert.rejects(replacement, /deletion confirmation did not arrive/u, scenario)
    assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.create').length, 1)
    assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.delete').at(-1)?.item_id,
      first.providerItem.id)
    await adapter.close()
  }
})

test('Qwen Header creation mismatches and provider errors never become successful delivery', async () => {
  for (const scenario of ['wrong_ack', 'provider_error'] as const) {
    const scripted = scriptedSocket([...handshake])
    const adapter = adapterFor(scripted)
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const pending = adapter.injectWorkspaceContext(workspaceHeader(1), {
      confirmationTimeout: scenario === 'wrong_ack' ? 0.02 : 1,
      signal: new AbortController().signal,
    })
    await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.create'))
    if (scenario === 'wrong_ack') {
      scripted.push({type: 'conversation.item.created', item: {id: 'wrong-provider-item'}})
      await assert.rejects(pending, error => error instanceof ItemDeliveryUncertainError)
    } else {
      scripted.push({
        type: 'error',
        error: {code: 'invalid_value', param: 'conversation.item.create'},
      })
      await assert.rejects(pending)
    }
    const before = scripted.sent.length
    await assert.rejects(adapter.injectWorkspaceContext(workspaceHeader(2), {
      confirmationTimeout: 1,
      signal: new AbortController().signal,
    }), /uncertain until reconnect/u)
    assert.equal(scripted.sent.length, before)
    await adapter.close()
  }
})

test('an uncertain Qwen create after confirmed delete blocks later Headers until reconnect', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const first = await injectConfirmedWorkspaceHeader(adapter, scripted)
  const uncertain = adapter.injectWorkspaceContext(workspaceHeader(2), {
    confirmationTimeout: 0.02,
    signal: new AbortController().signal,
  })
  await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.delete'))
  scripted.push({type: 'conversation.item.deleted', item_id: first.providerItem.id})
  await until(() => scripted.sent.filter(frame => frame.type === 'conversation.item.create').length === 2)
  await assert.rejects(uncertain, error => error instanceof ItemDeliveryUncertainError)
  const before = scripted.sent.length
  await assert.rejects(adapter.injectWorkspaceContext(workspaceHeader(3), {
    confirmationTimeout: 1,
    signal: new AbortController().signal,
  }), /uncertain until reconnect/u)
  assert.equal(scripted.sent.length, before)
})

test('Qwen reconnect resets Header ownership and the new epoch starts without deletion', async () => {
  const firstSocket = scriptedSocket([...handshake])
  const secondSocket = scriptedSocket([
    {type: 'session.created', session: {id: 'sess-2'}},
    {type: 'session.updated', session: {id: 'sess-2'}},
  ])
  let dial = 0
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'test-key',
    model: 'qwen-audio-3.0-realtime-plus',
    voice: 'longanqian',
    connector: () => Promise.resolve(++dial === 1 ? firstSocket.socket : secondSocket.socket),
    idFactory: ids(),
  })
  const signal = new AbortController().signal
  await adapter.connect({tools: [], signal})
  await injectConfirmedWorkspaceHeader(adapter, firstSocket)
  await adapter.close()
  assert.equal((await adapter.connect({tools: [], signal})).epoch, 2)
  const epochTwo = {...workspaceHeader(2, 'wi-b'), session_epoch: 2 as const}
  const pending = adapter.injectWorkspaceContext(epochTwo, {
    confirmationTimeout: 1,
    signal,
  })
  await until(() => secondSocket.sent.some(frame => frame.type === 'conversation.item.create'))
  assert.equal(secondSocket.sent.some(frame => frame.type === 'conversation.item.delete'), false)
  const providerItem = secondSocket.sent.find(frame => frame.type === 'conversation.item.create')
    ?.item as Record<string, unknown>
  secondSocket.push({type: 'conversation.item.created', item: {id: providerItem.id}})
  const proof = await pending
  assert.equal(proof.delivery.prior_provider_item_id, null)
  assert.equal(proof.delivery.session_epoch, 2)
})

test('graph-enabled Qwen policy is conditional and default instructions stay byte-identical', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted, {workspaceGraphPolicy: true})
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const update = scripted.sent.find(frame => frame.type === 'session.update')
  const session = update?.session as Record<string, unknown>
  assert.equal(session.instructions, workspaceGraphFrontendInstructions)
  assert.match(String(session.instructions), /不得建议用户切换工作区/u)
  assert.match(String(session.instructions), /不得仅因图谱提示调用动作工具/u)
  assert.notEqual(workspaceGraphFrontendInstructions, FRONTEND_INSTRUCTIONS)
})

test('a tool output injects a function_call_output item', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const injection = adapter.injectHostItem({
    kind: 'tool_output',
    host_item_id: 'host-2',
    event_id: 'ev-2',
    content: '{"ok":true}',
    call_id: 'call-9',
  }, {confirmationTimeout: 1, asUserActivation: false, signal: new AbortController().signal})

  await Promise.resolve()
  const create = scripted.sent.find(frame => frame.type === 'conversation.item.create')
  const item = create!.item as Record<string, unknown>
  assert.equal(item.type, 'function_call_output')
  assert.equal(item.call_id, 'call-9')
  assert.equal(item.output, '{"ok":true}')

  scripted.push({type: 'conversation.item.created', item: {id: item.id}})
  await injection
})

test('an unconfirmed host item becomes ItemDeliveryUncertainError, not a silent success',
  async () => {
    const scripted = scriptedSocket([...handshake])
    const adapter = adapterFor(scripted)
    await adapter.connect({tools: [], signal: new AbortController().signal})
    await assert.rejects(
      adapter.injectHostItem({
        kind: 'final',
        host_item_id: 'host-3',
        event_id: 'ev-3',
        content: '完成',
        call_id: null,
      }, {
        confirmationTimeout: 0.02,
        asUserActivation: false,
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof ItemDeliveryUncertainError
        && error.host_item_id === 'host-3'
        && error.item_kind === 'final',
    )
  })

test('user activation is refused for a kind Guard cannot activate', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  await assert.rejects(adapter.injectHostItem({
    kind: 'recovery',
    host_item_id: 'host-4',
    event_id: 'ev-4',
    content: '摘要',
    call_id: null,
  }, {confirmationTimeout: 1, asUserActivation: true, signal: new AbortController().signal}),
  /Guard progress or final/u)
})

async function collect(
  adapter: QwenAudioRealtimeAdapter,
  signal: AbortSignal,
  count: number,
): Promise<RealtimeProviderEvent[]> {
  const seen: RealtimeProviderEvent[] = []
  for await (const event of adapter.events(signal)) {
    seen.push(event)
    if (seen.length === count) break
  }
  return seen
}

test('provider frames normalize to the neutral event contract', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()

  scripted.push({type: 'input_audio_buffer.speech_started', item_id: 'item-a'})
  scripted.push({type: 'input_audio_buffer.speech_stopped', item_id: 'item-a'})
  scripted.push({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-a',
    transcript: '你好',
  })
  scripted.push({type: 'response.created', response: {id: 'resp-1'}})
  scripted.push({
    type: 'response.audio.delta',
    response_id: 'resp-1',
    delta: Buffer.from([1, 2, 3, 4]).toString('base64'),
  })
  scripted.push({type: 'response.audio_transcript.delta', response_id: 'resp-1', delta: '嗯'})
  scripted.push({type: 'response.audio_transcript.done', response_id: 'resp-1', transcript: '嗯好'})
  scripted.push({
    type: 'response.function_call_arguments.done',
    call_id: 'call-1',
    item_id: 'item-b',
    name: 'memory__recall',
    arguments: '{"query":"x"}',
    response_id: 'resp-1',
  })
  scripted.push({type: 'response.done', response: {id: 'resp-1', status: 'completed'}})

  const events = await collect(adapter, stop.signal, 9)
  assert.deepEqual(events.map(event => event.kind), [
    'user_speech_started',
    'user_speech_ended',
    'user_transcript_final',
    'response_started',
    'response_audio_delta',
    'response_transcript_delta',
    'response_transcript_final',
    'tool_call_ready',
    'response_terminal',
  ])
  // Speech start and end must share one host-allocated speech id.
  const started = events[0] as Extract<RealtimeProviderEvent, {kind: 'user_speech_started'}>
  const ended = events[1] as Extract<RealtimeProviderEvent, {kind: 'user_speech_ended'}>
  assert.equal(started.speech_id, ended.speech_id)
  const audio = events[4] as Extract<RealtimeProviderEvent, {kind: 'response_audio_delta'}>
  assert.deepEqual([...audio.pcm], [1, 2, 3, 4])
  const call = events[7] as Extract<RealtimeProviderEvent, {kind: 'tool_call_ready'}>
  assert.deepEqual(call.arguments, {query: 'x'})
  assert.equal(call.response_id, 'resp-1')
  stop.abort()
})

test('speech end without a matching start is a protocol error, not a silent drop', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()
  scripted.push({type: 'input_audio_buffer.speech_stopped', item_id: 'orphan'})

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 1,
    kind: 'provider_error',
    code: 'protocol_error',
    recoverable: false,
  }])
  stop.abort()
})

test('a transport close surfaces a recoverable disconnect', async () => {
  // Python only reaches this branch on EOFError, which its test doubles raise; a
  // real websockets peer close raises ConnectionClosed and is not caught there, so
  // the recovery path the service keys off is unreachable in production. Node maps
  // any transport close onto it.
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()
  scripted.end()

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 1,
    kind: 'provider_error',
    code: 'disconnected',
    recoverable: true,
  }])
  stop.abort()
})

test('a cancel with no active response becomes response_cancel_rejected', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()

  await adapter.cancelResponse('resp-7', new AbortController().signal)
  const cancel = scripted.sent.find(frame => frame.type === 'response.cancel')
  assert.ok(cancel !== undefined)
  const cancelRequestId = cancel.event_id as string

  scripted.push({
    type: 'error',
    error: {
      code: 'invalid_value',
      message: '  Conversation has no active response. ',
      event_id: cancelRequestId,
    },
  })
  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 1,
    kind: 'response_cancel_rejected',
    response_id: 'resp-7',
    cancel_request_id: cancelRequestId,
    reason: 'no_active_response',
  }])
  stop.abort()
})

test('a second concurrent cancel in one epoch is refused', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  await adapter.cancelResponse('resp-1', new AbortController().signal)
  await assert.rejects(
    adapter.cancelResponse('resp-2', new AbortController().signal),
    /cancel is already pending/u,
  )
})

test('provider error codes are sanitized, bounded, and param-qualified', async () => {
  const cases: {
    readonly error: Record<string, unknown>
    readonly code: string
    readonly recoverable: boolean
  }[] = [
    {error: {code: 'response_idle_timeout'}, code: 'response_idle_timeout', recoverable: true},
    {
      error: {code: 'rate limit/exceeded', param: 'session.update'},
      code: 'rate_limit_exceeded.session.update',
      recoverable: false,
    },
    {
      error: {code: 'bad', param: 'not.in.allowlist'},
      code: 'bad.unknown_param',
      recoverable: false,
    },
    {error: {message: 'no code field'}, code: 'None', recoverable: false},
  ]

  for (const expected of cases) {
    const scripted = scriptedSocket([...handshake])
    const adapter = adapterFor(scripted)
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const stop = new AbortController()
    scripted.push({type: 'error', error: expected.error})
    const events = await collect(adapter, stop.signal, 1)
    assert.deepEqual(events, [{
      session_epoch: 1,
      kind: 'provider_error',
      code: expected.code,
      recoverable: expected.recoverable,
    }], JSON.stringify(expected.error))
    stop.abort()
  }
})

test('a stray no-active-response error without a pending cancel is dropped', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()

  scripted.push({type: 'error', error: {code: 'invalid_value', message: 'no active response found to cancel'}})
  scripted.push({type: 'response.created', response: {id: 'resp-2'}})

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events.map(event => event.kind), ['response_started'])
  stop.abort()
})

test('a non-canonical base64 audio delta is refused', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()
  scripted.push({type: 'response.audio.delta', response_id: 'resp-1', delta: 'not!base64'})

  const events = await collect(adapter, stop.signal, 1)
  assert.equal(events[0]?.kind, 'provider_error')
  stop.abort()
})

test('malformed json and non-object events are bounded protocol failures', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()
  // A frame whose `type` is absent is malformed for this protocol.
  scripted.push({session: {id: 'sess-1'}})

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 1,
    kind: 'provider_error',
    code: 'protocol_error',
    recoverable: false,
  }])
  stop.abort()
})

test('close is idempotent and releases pending confirmations', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const pending = adapter.injectHostItem({
    kind: 'progress',
    host_item_id: 'host-9',
    event_id: 'ev-9',
    content: '进行中',
    call_id: null,
  }, {confirmationTimeout: 5, asUserActivation: false, signal: new AbortController().signal})

  await Promise.resolve()
  await adapter.close()
  await adapter.close()
  await assert.rejects(pending)
})

/** Await with a deadline, so a regression fails fast instead of hanging the suite. */
async function within<T>(work: Promise<T>, milliseconds: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), milliseconds)
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Spin the macrotask queue until a condition holds, or fail rather than hang. */
async function until(condition: () => boolean, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (condition()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('condition never became true')
}

/** A socket whose sends can be held open, to order writes against a reconnect. */
function blockableSocket(initial: Record<string, unknown>[] = []) {
  const inbound: (Record<string, unknown> | null)[] = [...initial]
  const sent: Record<string, unknown>[] = []
  const gates: (() => void)[] = []
  let wake: (() => void) | undefined
  let blocking = false
  let received = 0
  return {
    sent,
    get received() { return received },
    get parked() { return gates.length },
    releaseAll() { for (const gate of gates.splice(0)) gate() },
    block() { blocking = true },
    unblock() { blocking = false },
    push(frame: Record<string, unknown>) { inbound.push(frame); wake?.(); wake = undefined },
    socket: {
      send(payload: string) {
        const record = (): void => { sent.push(JSON.parse(payload) as Record<string, unknown>) }
        if (!blocking) {
          record()
          return Promise.resolve()
        }
        return new Promise<void>(resolve => gates.push(() => { record(); resolve() }))
      },
      async receive() {
        while (inbound.length === 0) {
          await new Promise<void>(resolve => { wake = resolve })
        }
        const next = inbound.shift()
        received += 1
        if (next === null || next === undefined) throw new QwenSocketClosedError()
        return JSON.stringify(next)
      },
      close: () => Promise.resolve(),
    } satisfies QwenSocket,
  }
}

test('a write queued on a closed session never lands on its replacement', async () => {
  // The write chain outlives a connection. A frame queued behind a slow send must
  // not be delivered to the next session, ahead of that session's own
  // session.update, which would inject stale host context into it.
  const first = blockableSocket([...handshake])
  const second = blockableSocket([...handshake])
  let dial = 0
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'k',
    model: 'm',
    voice: 'v',
    idFactory: ids(),
    connector: () => {
      dial += 1
      return Promise.resolve(dial === 1 ? first.socket : second.socket)
    },
  })
  const signal = new AbortController().signal
  await adapter.connect({tools: [], signal})

  first.block()
  // Block on createResponse rather than sendAudio: sendAudio checks ownership and
  // returns early once the socket is detached, so it never parks and the race
  // cannot be staged through it.
  const blocked = adapter.createResponse({
    kind: 'host_fact',
    item: {
      kind: 'final',
      host_item_id: 'live-item',
      event_id: 'ev-live',
      content: '当前会话',
      call_id: null,
    },
    task_summary: null,
    origin_spoken: false,
  }, signal)
  // The write must actually be parked on the gate before anything else happens,
  // otherwise it runs after close() and the ordering under test never occurs.
  await until(() => first.parked === 1)

  const injection = adapter.injectHostItem({
    kind: 'progress',
    host_item_id: 'stale-host-item',
    event_id: 'ev-stale',
    content: '旧会话进度',
    call_id: null,
  }, {confirmationTimeout: 0.05, asUserActivation: false, signal})
  const settled = Promise.allSettled([blocked, injection])

  await adapter.close()
  // Start the replacement handshake but do not await it yet: its session.update is
  // queued behind the still-blocked writes. Releasing the old send now runs the
  // stale injection while this.#socket already points at the replacement, which is
  // exactly the ordering that delivered one session's host item into another.
  const reconnected = adapter.connect({tools: [], signal})
  // Release only once the replacement socket is actually installed. Releasing
  // earlier makes the stale write fail with "not connected" and the race is missed,
  // which is what made an earlier version of this test vacuous.
  await until(() => second.received >= 1)
  first.unblock()
  first.releaseAll()
  await within(reconnected, 5_000, 'the replacement handshake')
  await within(settled, 5_000, 'the old session writes to settle')

  const kinds = second.sent.map(frame => frame.type)
  assert.deepEqual(kinds, ['session.update'],
    'the replacement session must see only its own handshake')
  assert.doesNotMatch(JSON.stringify(second.sent), /stale-host-item/u)
})

test('a reconnected session exposes its own events, not the previous sentinel', async () => {
  // close() enqueues a terminal null to release any consumer. If connect() did not
  // discard it, the reconnected stream would report done on its first iteration and
  // the session would look permanently silent.
  const first = scriptedSocket([...handshake])
  const second = scriptedSocket([...handshake])
  let dial = 0
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'k',
    model: 'm',
    voice: 'v',
    idFactory: ids(),
    connector: () => {
      dial += 1
      return Promise.resolve(dial === 1 ? first.socket : second.socket)
    },
  })
  const signal = new AbortController().signal

  // Connect and close without ever consuming events, leaving the sentinel queued.
  await adapter.connect({tools: [], signal})
  await adapter.close()

  const identity = await adapter.connect({tools: [], signal})
  assert.equal(identity.epoch, 2)
  const stop = new AbortController()
  second.push({type: 'response.created', response: {id: 'resp-after-reconnect'}})

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 2,
    kind: 'response_started',
    response_id: 'resp-after-reconnect',
  }])
  stop.abort()
})

test('an event queue overflow fails the session instead of growing memory', async () => {
  // The transport bound only protects its own backlog; the read loop drains that into
  // the adapter queue immediately, so a fast provider needs its own limit here.
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  const signal = new AbortController().signal
  await adapter.connect({tools: [], signal})

  // Start the read loop WITHOUT consuming events, so the queue can actually fill.
  // Consuming while pushing keeps it below the bound and the overflow never happens,
  // which is how an earlier version of this test timed out instead of asserting.
  void adapter.injectHostItem({
    kind: 'progress',
    host_item_id: 'starts-the-reader',
    event_id: 'ev-reader',
    content: '启动读取',
    call_id: null,
  }, {confirmationTimeout: 0.01, asUserActivation: false, signal}).catch(() => undefined)

  for (let index = 0; index <= MAX_QWEN_EVENT_QUEUE; index += 1) {
    scripted.push({type: 'response.created', response: {id: `resp-${index}`}})
  }
  // Let the reader drain every frame into the adapter queue and trip the bound.
  for (let turn = 0; turn < 200; turn += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const stop = new AbortController()
  const seen: RealtimeProviderEvent[] = []
  for await (const event of adapter.events(stop.signal)) {
    seen.push(event)
    if (seen.length >= 4) break
  }
  stop.abort()

  // On overflow the queue is replaced by exactly one terminal error and a sentinel,
  // so the first event a consumer sees is the failure -- not the 4096 it missed.
  assert.equal(seen.length, 1, 'overflow must discard the backlog and terminate')
  assert.deepEqual(seen[0], {
    session_epoch: 1,
    kind: 'provider_error',
    code: 'event_queue_overflow',
    recoverable: false,
  })
})

test('waiting for events does not accumulate abort listeners', async () => {
  // One listener per wait would retain memory and trip MaxListenersExceededWarning.
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  const signal = new AbortController().signal
  await adapter.connect({tools: [], signal})

  const stop = new AbortController()
  const warnings: string[] = []
  const onWarning = (warning: Error): void => { warnings.push(warning.name) }
  process.on('warning', onWarning)
  try {
    const consumed: string[] = []
    const reader = (async () => {
      for await (const event of adapter.events(stop.signal)) {
        consumed.push(event.kind)
        if (consumed.length === 40) break
      }
    })()
    // Push one at a time so every event is delivered from a parked wait.
    for (let index = 0; index < 40; index += 1) {
      scripted.push({type: 'response.created', response: {id: `resp-${index}`}})
      await new Promise(resolve => setImmediate(resolve))
    }
    await reader
    assert.equal(consumed.length, 40)
    assert.ok(stop.signal.aborted === false)
    // A leak shows up as one retained listener per delivered event.
    assert.ok(getEventListeners(stop.signal, 'abort').length <= 1,
      'each wait must remove its own abort listener')
  } finally {
    process.off('warning', onWarning)
    stop.abort()
  }
  assert.deepEqual(warnings.filter(name => name === 'MaxListenersExceededWarning'), [])
})

test('close does not hang behind a receive that the transport never unblocks', async () => {
  // QwenSocket.close() is not required to reject an already-parked receive(), so
  // shutdown must bound its wait on the detached reader rather than block on it.
  let parked = false
  const inbound: Record<string, unknown>[] = [...handshake]
  const stalled: QwenSocket = {
    send: () => Promise.resolve(),
    receive: () => {
      const next = inbound.shift()
      if (next !== undefined) return Promise.resolve(JSON.stringify(next))
      parked = true
      // Never settles, and close() below does nothing about it.
      return new Promise<string>(() => undefined)
    },
    close: () => Promise.resolve(),
  }
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'k',
    model: 'm',
    voice: 'v',
    idFactory: ids(),
    connector: () => Promise.resolve(stalled),
    closeTimeout: 0.05,
  })
  const signal = new AbortController().signal
  await adapter.connect({tools: [], signal})

  // Start the reader and prove it is genuinely parked before closing.
  const stop = new AbortController()
  void (async () => {
    for await (const event of adapter.events(stop.signal)) void event
  })()
  await until(() => parked)

  const started = Date.now()
  await within(adapter.close(), 3_000, 'close to return')
  assert.ok(Date.now() - started < 2_000, 'close must not block on a parked read')
  stop.abort()
})

test('the close deadline keeps an otherwise idle child alive until cleanup settles', async () => {
  const fixture = fileURLToPath(new URL('fixtures/qwen-close-handle-child.js', import.meta.url))
  const result = await execFileAsync(process.execPath, [fixture], {
    encoding: 'utf8',
    timeout: 3_000,
  })
  assert.equal(result.stdout, 'closed\n')
  assert.equal(result.stderr, '')
})
