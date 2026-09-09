import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import type {WorkerOptions} from 'node:worker_threads'

import {
  PersonalMemoryStoreClient,
  PersonalMemoryStoreClientError,
  type PersonalMemoryStoreWorker,
} from '../src/voicemem/store-client.js'

type Listener = (value: never) => void

class FakeWorker implements PersonalMemoryStoreWorker {
  readonly messages: unknown[] = []
  readonly listeners = new Map<string, Listener[]>()
  terminated = 0

  postMessage(value: unknown): void { this.messages.push(value) }
  on(event: 'message' | 'error' | 'exit', listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  terminate(): Promise<number> {
    this.terminated += 1
    this.emit('exit', 1)
    return Promise.resolve(1)
  }
  emit(event: 'message' | 'error' | 'exit', value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never)
  }
  respond(requestId: number, result: unknown): void {
    this.emit('message', {kind: 'response', request_id: requestId, ok: true, result})
  }
  refuse(requestId: number, errorCode: string): void {
    this.emit('message', {kind: 'response', request_id: requestId, ok: false, error_code: errorCode})
  }
  adaptation(value: unknown): void {
    this.emit('message', {kind: 'response_adaptation', adaptation: value})
  }
}

function client(worker = new FakeWorker()): {readonly client: PersonalMemoryStoreClient; readonly worker: FakeWorker; readonly configurations: WorkerOptions[]} {
  const configurations: WorkerOptions[] = []
  const instance = new PersonalMemoryStoreClient({
    path: '/private/tmp/nova-personal-test/personal.sqlite',
    userId: 'host-user',
    embedding: {baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'embed-test', dimensions: 2},
    extractionModel: 'extract-test',
    workerFactory: (_url, options) => {
      configurations.push(options)
      return worker
    },
  })
  return {client: instance, worker, configurations}
}

function requestId(worker: FakeWorker, index: number): number {
  const message = worker.messages[index] as {readonly request_id?: unknown}
  const id = message.request_id
  assert.equal(typeof id, 'number')
  return id as number
}

function empty(scope: 'recent' | 'any') {
  return {source: 'personal', state: 'empty', scope, hits: [], rightBrainHits: [], degraded: false}
}

function responseAdaptation(revision = 0, replyPreferences: readonly unknown[] = []) {
  return {revision, replyPreferences}
}

function opened(adaptation = responseAdaptation()) {
  return {response_adaptation: adaptation}
}

test('client fixes path, host user, and serializable embedding config in worker data', async () => {
  const {client: store, worker, configurations} = client()
  assert.equal(configurations.length, 0)
  const opening = store.open()
  assert.deepEqual(configurations[0]?.workerData, {
    path: '/private/tmp/nova-personal-test/personal.sqlite',
    userId: 'host-user',
    embedding: {baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'embed-test', dimensions: 2},
    extractionModel: 'extract-test',
  })
  worker.respond(requestId(worker, 0), opened())
  await opening

  const recall = store.recall('What did I say?', {scope: 'any', limit: 2})
  assert.deepEqual(worker.messages[1], {
    kind: 'request', request_id: requestId(worker, 1), operation: 'recall',
    query: 'What did I say?', scope: 'any', limit: 2,
  })
  worker.respond(requestId(worker, 1), empty('any'))
  assert.deepEqual(await recall, {source: 'personal', state: 'empty', scope: 'any', hits: [], contextHits: [], degraded: false})
  await store.close()
})

test('close before open does not start a worker lifecycle', async () => {
  const {client: store, worker, configurations} = client()
  await store.close()
  assert.equal(configurations.length, 0)
  assert.equal(worker.messages.length, 0)
  assert.equal(worker.terminated, 0)
  await assert.rejects(store.open(), error => error instanceof PersonalMemoryStoreClientError && error.code === 'CLIENT_CLOSED')
  assert.equal(configurations.length, 0)
})

test('recall before open reports a closed store without starting a worker', async () => {
  const {client: store, configurations} = client()
  await assert.rejects(store.recall('facts'), error => error instanceof PersonalMemoryStoreClientError && error.code === 'STORE_CLOSED')
  assert.equal(configurations.length, 0)
  await store.close()
})

test('remember sends only host turn metadata and returns its durable receipt', async () => {
  const {client: store,worker}=client()
  const opening=store.open();worker.respond(requestId(worker,0),opened());await opening
  const remembered=store.remember!({sourceId:'source-1',sessionId:'session-1',sequence:1,text:'hello',occurredAt:null,previousAssistantReply:' Delivered answer. ',
    speaker:'spoofed',operation:'recall'} as Parameters<NonNullable<typeof store.remember>>[0] & {speaker:string;operation:string})
  assert.deepEqual(worker.messages[1],{kind:'request',request_id:requestId(worker,1),operation:'remember',sourceId:'source-1',sessionId:'session-1',sequence:1,text:'hello',occurredAt:null,previousAssistantReply:' Delivered answer. '})
  worker.respond(requestId(worker,1),{state:'pending',source_id:'source-1'})
  assert.deepEqual(await remembered,{state:'stored',sourceId:'source-1'})
  await store.close()
})

test('previous assistant reply preserves the 40,000 UTF-16-unit boundary', async () => {
  const {client: store,worker}=client()
  const opening=store.open();worker.respond(requestId(worker,0),opened());await opening
  const exact='😀'.repeat(20_000)
  const admitted=store.remember!({sourceId:'astral-prefix',sessionId:'s',sequence:1,text:'hello',occurredAt:null,previousAssistantReply:exact})
  assert.equal((worker.messages[1] as {readonly previousAssistantReply?: unknown}).previousAssistantReply,exact)
  worker.respond(requestId(worker,1),{state:'pending',source_id:'astral-prefix'})
  await admitted
  assert.throws(() => store.remember!({sourceId:'too-long-prefix',sessionId:'s',sequence:2,text:'hello',occurredAt:null,previousAssistantReply:'😀'.repeat(20_001)}))
  assert.equal(worker.messages.length,2)
  await store.close()
})

test('read-only clients do not expose durable admission', () => {
  const store=new PersonalMemoryStoreClient({path:'/private/tmp/read-only.sqlite',userId:'host-user',
    embedding:{baseUrl:'https://example.invalid/v1',apiKey:'test-key',model:'embed-test'}})
  assert.equal(store.remember,undefined)
  assert.equal(Object.hasOwn(store,'remember'),false)
})

test('response adaptation is unavailable before open and after close', async () => {
  const {client: store, worker} = client()
  assert.throws(() => store.responseAdaptation(), error => error instanceof PersonalMemoryStoreClientError && error.code === 'STORE_CLOSED')
  const opening = store.open()
  worker.respond(requestId(worker, 0), opened())
  await opening
  await store.close()
  assert.throws(() => store.responseAdaptation(), error => error instanceof PersonalMemoryStoreClientError && error.code === 'CLIENT_CLOSED')
})

test('client caches only bounded response adaptations and returns immutable copies', async () => {
  const {client: store, worker} = client()
  const opening = store.open()
  worker.respond(requestId(worker, 0), opened(responseAdaptation(0, [{id: 'preference-1', text: 'Keep answers concise.', evidenceIds: ['source-1']}])) )
  await opening

  const initial = store.responseAdaptation()
  assert.deepEqual(initial, {revision: 0, replyPreferences: [{id: 'preference-1', text: 'Keep answers concise.', evidenceIds: ['source-1']}]})
  assert.equal(Object.isFrozen(initial), true)
  assert.equal(Object.isFrozen(initial.replyPreferences), true)
  assert.equal(Object.isFrozen(initial.replyPreferences[0]!.evidenceIds), true)
  assert.notEqual(store.responseAdaptation(), initial)

  worker.adaptation(responseAdaptation(1, [{id: 'preference-2', text: 'Use short sentences.', evidenceIds: ['source-2']}]))
  assert.deepEqual(store.responseAdaptation(), {revision: 1, replyPreferences: [{id: 'preference-2', text: 'Use short sentences.', evidenceIds: ['source-2']}]})
  await store.close()
})

test('an adaptation notice immediately after open cannot outrun its baseline snapshot', async () => {
  const {client: store, worker} = client()
  const opening = store.open()
  worker.respond(requestId(worker, 0), opened(responseAdaptation(0)))
  worker.adaptation(responseAdaptation(1, [{id: 'preference-1', text: 'Use short sentences.', evidenceIds: ['source-1']}]))
  await opening
  assert.equal(store.responseAdaptation().revision, 1)
  await store.close()
})

test('malformed response adaptation notice is a protocol failure', async () => {
  const {client: store, worker} = client()
  const opening = store.open()
  worker.respond(requestId(worker, 0), opened())
  await opening
  worker.adaptation(responseAdaptation(1, [{id: 'preference-1', text: 'x'.repeat(1_001), evidenceIds: []}]))
  assert.throws(() => store.responseAdaptation(), error => error instanceof PersonalMemoryStoreClientError && error.code === 'WORKER_PROTOCOL_FAILURE')
  await assert.rejects(store.recall('facts'), error => error instanceof PersonalMemoryStoreClientError && error.code === 'CLIENT_CLOSED')
  await store.close()
})

test('VoiceMem adapter maps internal retrieval and tombstones to the Nova contract', async () => {
  const {client: store, worker} = client()
  const opening = store.open()
  worker.respond(requestId(worker, 0), opened())
  await opening
  const recall = store.recall('experience')
  worker.respond(requestId(worker, 1), {
    ...empty('recent'), state: 'ok', rightBrainHits: [{
      memoryId: 'm', kind: 'heartnote', text: 'a tiring day', subject: 'user',
      attribute: '', emotion: 'tired', occurredAt: null, recordedAt: '2026-09-06',
      score: 0.7, evidenceIds: ['source-1'],
    }],
  })
  const result = await recall
  assert.equal(result.contextHits?.[0]?.kind, 'experience')
  assert.equal('rightBrainHits' in result, false)
  const admitted = store.remember!({sourceId:'source-1',sessionId:'s',sequence:1,text:'hello',occurredAt:null})
  worker.respond(requestId(worker, 2), {state:'forgotten', source_id:'source-1'})
  assert.deepEqual(await admitted, {state:'deleted', sourceId:'source-1'})
  await store.close()
})

test('client validates bounded projection and rejects malformed worker data', async () => {
  const {client: store, worker} = client()
  const opening = store.open()
  worker.respond(requestId(worker, 0), opened())
  await opening
  const recall = store.recall('facts')
  worker.respond(requestId(worker, 1), {
    source: 'personal', state: 'ok', scope: 'recent', hits: [{memoryId: 'm', kind: 'fact', text: 'x'.repeat(801),
      subject: 'user', attribute: '', emotion: '', occurredAt: null, recordedAt: '2026-01-01T00:00:00Z', score: 1, evidenceIds: []}],
    rightBrainHits: [], degraded: false,
  })
  await assert.rejects(recall, error => error instanceof PersonalMemoryStoreClientError && error.code === 'WORKER_PROTOCOL_FAILURE')
  await store.close()
})

test('aborting a recall drops its late worker response without poisoning later RPCs', async () => {
  const {client: store, worker} = client()
  const opening = store.open()
  worker.respond(requestId(worker, 0), opened())
  await opening

  const controller = new AbortController()
  const cancelled = store.recall('cancel me', {signal: controller.signal})
  const cancelledId = requestId(worker, 1)
  controller.abort()
  await assert.rejects(cancelled, {name: 'AbortError'})
  worker.respond(cancelledId, empty('recent'))

  const next = store.recall('still healthy')
  worker.respond(requestId(worker, 2), empty('recent'))
  assert.deepEqual(await next, {source: 'personal', state: 'empty', scope: 'recent', hits: [], contextHits: [], degraded: false})
  await store.close()
})

test('worker storage failures remain explicit rather than becoming empty recall', async () => {
  const {client: store, worker} = client()
  const opening = store.open()
  worker.respond(requestId(worker, 0), opened())
  await opening
  const recall = store.recall('facts')
  worker.refuse(requestId(worker, 1), 'STORE_RECALL_FAILED')
  await assert.rejects(recall, error => error instanceof PersonalMemoryStoreClientError && error.code === 'STORE_RECALL_FAILED')
  await store.close()
})

test('close forces a worker that does not acknowledge close within its bounded grace', async () => {
  const {client: store, worker} = client()
  const opening = store.open()
  worker.respond(requestId(worker, 0), opened())
  await opening
  await store.close()
  assert.equal((worker.messages[1] as {readonly operation?: unknown}).operation, 'close')
  assert.equal(worker.terminated, 1)
})

test('the real worker opens and closes the private VoiceMem database without a foreground store', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-personal-memory-'))
  const store = new PersonalMemoryStoreClient({
    path: join(directory, 'personal.sqlite'), userId: 'host-user',
    // Opening is local only. This deliberately never calls the embedding provider.
    embedding: {baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'embed-test'},
  })
  t.after(async () => {
    await store.close()
    await rm(directory, {recursive: true, force: true})
  })
  await store.open()
})

async function loopbackProvider(): Promise<{readonly baseUrl:string; readonly close:()=>Promise<void>; readonly release:()=>void; readonly calls:Map<string,number>; readonly extractionStarted:Promise<void>}> {
  let release!:()=>void, began!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  const extractionStarted=new Promise<void>(resolve=>{began=resolve})
  const calls=new Map<string,number>()
  const server=createServer((request,response)=>{
    void (async () => {
    const body=await new Promise<string>(resolve=>{let value='';request.on('data',part=>{value+=String(part)});request.on('end',()=>resolve(value))})
    const input=JSON.parse(body) as {input?:string[];messages?:{content:string}[]}
    if(request.url==='/v1/embeddings') {
      response.end(JSON.stringify({data:(input.input??[]).map((_,index)=>({index,embedding:[1,0]}))}))
      return
    }
    const prompt=input.messages?.[1]?.content ?? '{}'
    // Support both the pinned SDK's JSON prompt and the new upstream-aligned extraction format.
    const section = /## New Messages\n([\s\S]*?)\n\n## Observation Date/u.exec(prompt)?.[1]
    const legacy = prompt.startsWith('{') ? JSON.parse(prompt) as {text?:string;operation?:string} : undefined
    if (legacy?.operation === 'attribute_reaction' || (section === undefined && legacy?.text === undefined)) {
      response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({memory:[],significant:false,assistant_helped:false})}}]}))
      return
    }
    const text = section === undefined ? legacy!.text!
      : (JSON.parse(section) as {content:string}[])[0]!.content.replace(/^host-user: /u, '')
    calls.set(text,(calls.get(text)??0)+1)
    if(text==='slow') { began(); await gate }
    if(text==='poison') { response.statusCode=500; response.end('{}'); return }
    const extraction=section !== undefined
      ? {memory:text==='preference'?[]:[{text,attribute:'',slot:'',entities:[]}],emotion:'',
        traits:text==='preference'?[{label:'Keep replies concise.',slot:'表达风格',reply_preference:true}]:[]}
      : text==='preference'
      ? {facts:[],emotions:[],traits:[{text:'Keep replies concise.',subject:'host-user',attribute:'reply_preference',slots:[],entities:[]}]}
      : {facts:[{text,subject:'host-user',attribute:'',slots:[],entities:[]}],emotions:[],traits:[]}
    response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(extraction)}}]}))
    })().catch(() => { response.statusCode=500; response.end('{}') })
  })
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})})
  const address=server.address();assert.ok(address&&typeof address!=='string')
  return {baseUrl:`http://127.0.0.1:${address.port}/v1`,calls,release,extractionStarted,close:async()=>{
    release();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))
  }}
}

async function eventually(check:()=>boolean | Promise<boolean>):Promise<void>{
  for(let attempt=0;attempt<100;attempt++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10))}
  assert.fail('condition did not become true')
}

/** Run every teardown even if an earlier close fails; remove files only after all owners close. */
async function cleanup(actions: readonly (() => unknown)[]): Promise<void> {
  const failures: unknown[] = []
  for (const action of actions) { try { await action() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'memory fixture cleanup failed')
}

async function awaitExtraction(started: Promise<void>): Promise<void> {
  const stop = new AbortController()
  try {
    await Promise.race([started, delay(5_000, undefined, {signal: stop.signal}).then(() => {
      throw new Error('loopback extraction request did not arrive within 5000ms')
    })])
  } finally { stop.abort() }
}

test('real worker durably admits, recalls during learning, retries only on reopen, and projects astral text safely', {timeout:10000}, async t => {
  let provider: Awaited<ReturnType<typeof loopbackProvider>>
  try { provider=await loopbackProvider() }
  catch(error) {
    if((error as NodeJS.ErrnoException).code==='EPERM' && process.env.NOVA_MEMORY_SDK_ACCEPTANCE !== '1') { t.skip('sandbox does not permit loopback listeners'); return }
    throw error
  }
  const directory=await mkdtemp(join(process.cwd(),'voicemem-worker-'))
  let store=new PersonalMemoryStoreClient({path:join(directory,'personal.sqlite'),userId:'host-user',
    embedding:{baseUrl:provider.baseUrl,apiKey:'loopback',model:'embed-test',dimensions:2},extractionModel:'extract-test'})
  t.after(() => cleanup([() => store.close(), () => provider.close(), () => rm(directory, {recursive:true,force:true})]))
  await store.open()
  assert.deepEqual(await store.remember!({sourceId:'slow-id',sessionId:'s',sequence:1,text:'slow',occurredAt:null}),{state:'stored',sourceId:'slow-id'})
  await awaitExtraction(provider.extractionStarted)
  assert.deepEqual(await store.recall('slow'),{source:'personal',state:'empty',scope:'recent',hits:[],contextHits:[],degraded:false})
  provider.release()
  await eventually(()=>provider.calls.get('slow')===1)

  const astral='😀'.repeat(401)
  await store.remember!({sourceId:'astral-id',sessionId:'s',sequence:2,text:astral,occurredAt:null})
  await eventually(()=>provider.calls.get(astral)===1)
  let projected!: Awaited<ReturnType<typeof store.recall>>
  await eventually(async () => { projected=await store.recall('astral',{scope:'any'}); return projected.hits.some(hit=>hit.text.length===800) })
  const text=projected.hits.find(hit=>hit.text.length===800)!.text
  assert.equal(text,'😀'.repeat(400));assert.equal(text.length,800)

  await store.remember!({sourceId:'poison-id',sessionId:'s',sequence:3,text:'poison',occurredAt:null})
  await eventually(()=>provider.calls.get('poison')===1)
  await store.remember!({sourceId:'good-id',sessionId:'s',sequence:4,text:'good',occurredAt:null})
  await eventually(()=>provider.calls.get('good')===1)
  assert.equal(provider.calls.get('poison'),1)
  await store.close()
  store=new PersonalMemoryStoreClient({path:join(directory,'personal.sqlite'),userId:'host-user',
    embedding:{baseUrl:provider.baseUrl,apiKey:'loopback',model:'embed-test',dimensions:2},extractionModel:'extract-test'})
  await store.open()
  await eventually(()=>provider.calls.get('poison')===2)
})

test('real worker persists the exact previous reply and republishes learned global preferences on reopen', async t => {
  let provider: Awaited<ReturnType<typeof loopbackProvider>>
  try { provider=await loopbackProvider() }
  catch(error) {
    if((error as NodeJS.ErrnoException).code==='EPERM' && process.env.NOVA_MEMORY_SDK_ACCEPTANCE !== '1') { t.skip('sandbox does not permit loopback listeners'); return }
    throw error
  }
  const directory=await mkdtemp(join(process.cwd(),'voicemem-worker-preferences-'))
  const path=join(directory,'personal.sqlite')
  let store=new PersonalMemoryStoreClient({path,userId:'host-user',
    embedding:{baseUrl:provider.baseUrl,apiKey:'loopback',model:'embed-test',dimensions:2},extractionModel:'extract-test'})
  const owners: {db?: DatabaseSync} = {}
  t.after(() => cleanup([() => store.close(), () => owners.db?.close(), () => provider.close(), () => rm(directory, {recursive:true,force:true})]))
  await store.open()
  const deliveredPrefix='😀'.repeat(20_000)
  await store.remember!({sourceId:'preference-id',sessionId:'s',sequence:1,text:'preference',occurredAt:null,previousAssistantReply:deliveredPrefix})
  await eventually(()=>provider.calls.get('preference')===1 && store.responseAdaptation().replyPreferences.length===1)
  assert.deepEqual(store.responseAdaptation().replyPreferences,[{id:store.responseAdaptation().replyPreferences[0]!.id,text:'Keep replies concise.',evidenceIds:['preference-id']}])
  await store.remember!({sourceId:'failed-id',sessionId:'s',sequence:2,text:'poison',occurredAt:null})
  await eventually(()=>provider.calls.get('poison')===1)
  assert.equal(store.responseAdaptation().revision, 1, 'failed learning cannot invent a response preference snapshot')
  const db=owners.db=new DatabaseSync(path)
  assert.equal((JSON.parse(String(db.prepare("SELECT payload FROM vm_sources WHERE id='preference-id'").get()!.payload)) as {previousAssistantReply?: unknown}).previousAssistantReply,deliveredPrefix)
  await store.close()

  store=new PersonalMemoryStoreClient({path,userId:'host-user',
    embedding:{baseUrl:provider.baseUrl,apiKey:'loopback',model:'embed-test',dimensions:2},extractionModel:'extract-test'})
  await store.open()
  assert.deepEqual(store.responseAdaptation().replyPreferences,[{id:store.responseAdaptation().replyPreferences[0]!.id,text:'Keep replies concise.',evidenceIds:['preference-id']}])
})

test('real worker snapshots only host-user reply preferences', async t => {
  const directory=await mkdtemp(join(process.cwd(),'voicemem-worker-preference-filter-'))
  const path=join(directory,'personal.sqlite')
  const options={path,userId:'host-user',embedding:{baseUrl:'https://example.invalid/v1',apiKey:'test-key',model:'embed-test',dimensions:2}}
  const initialized=new PersonalMemoryStoreClient(options)
  const owners: {db?: DatabaseSync; reopened?: PersonalMemoryStoreClient} = {}
  t.after(() => cleanup([() => owners.reopened?.close(), () => owners.db?.close(), () => initialized.close(), () => rm(directory, {recursive:true,force:true})]))
  await initialized.open()
  await initialized.close()
  const db=owners.db=new DatabaseSync(path)
  const insert=(id:string,subject:string,sourceRole:'user'|'assistant') => {
    const record={id,userId:'host-user',scope:'personal',kind:'trait',text:`${id} text`,subject,attribute:'reply_preference',slots:[],entities:[],emotion:'',authority:'inferred',occurredAt:null,recordedAt:'2026-09-06T00:00:00.000Z',sourceRole,revision:1,supersededBy:null,evidenceIds:[`${id}-source`]}
    db.prepare('INSERT INTO vm_memories VALUES (?,?,?,?,?,?,?,?)').run('host-user','personal',id,JSON.stringify(record),'[1,0]','embed-test',1,1)
  }
  insert('self-user','host-user','user')
  insert('third-party','another-user','user')
  insert('assistant-role','host-user','assistant')

  const reopened=owners.reopened=new PersonalMemoryStoreClient(options)
  await reopened.open()
  assert.deepEqual(reopened.responseAdaptation().replyPreferences,[{id:'self-user',text:'self-user text',evidenceIds:['self-user-source']}])
})


test('storage damage fails a read or background drain without terminating the worker', async t => {
  let provider: Awaited<ReturnType<typeof loopbackProvider>>
  try { provider=await loopbackProvider() }
  catch(error) {
    if((error as NodeJS.ErrnoException).code==='EPERM' && process.env.NOVA_MEMORY_SDK_ACCEPTANCE !== '1') { t.skip('sandbox does not permit loopback listeners'); return }
    throw error
  }
  const directory=await mkdtemp(join(process.cwd(),'voicemem-worker-damage-'))
  const path=join(directory,'personal.sqlite')
  const store=new PersonalMemoryStoreClient({path,userId:'host-user',
    embedding:{baseUrl:provider.baseUrl,apiKey:'loopback',model:'embed-test',dimensions:2},extractionModel:'extract-test'})
  const owners: {db?: DatabaseSync} = {}
  t.after(() => cleanup([() => provider.release(), () => store.close(), () => owners.db?.close(), () => provider.close(), () => rm(directory, {recursive:true,force:true})]))
  await store.open()
  const db=owners.db=new DatabaseSync(path)
  await store.remember!({sourceId:'slow-id',sessionId:'s',sequence:1,text:'slow',occurredAt:null})
  await awaitExtraction(provider.extractionStarted)
  await store.remember!({sourceId:'queued-id',sessionId:'s',sequence:2,text:'queued',occurredAt:null})
  const queued=String(db.prepare("SELECT payload FROM vm_sources WHERE id='queued-id'").get()!.payload)
  db.prepare("UPDATE vm_sources SET payload=? WHERE id='queued-id'").run('{')
  provider.release()
  await eventually(async()=> (await store.recall('slow',{scope:'any'})).hits.length>0)
  // A storage error during finally's pending scan must not become an unhandled rejection.
  await store.remember!({sourceId:'after-id',sessionId:'s',sequence:3,text:'after',occurredAt:null})
  assert.ok((await store.recall('slow',{scope:'any'})).hits.length>0)
  db.prepare("UPDATE vm_sources SET payload=? WHERE id='queued-id'").run(queued)

  const row=db.prepare('SELECT id,payload FROM vm_memories LIMIT 1').get()!
  db.prepare("UPDATE vm_memories SET payload=json_set(payload,'$.subject','') WHERE id=?").run(String(row.id))
  await assert.rejects(store.recall('slow',{scope:'any'}),error =>
    error instanceof PersonalMemoryStoreClientError && error.code==='STORE_RECALL_FAILED')
  db.prepare('UPDATE vm_memories SET payload=? WHERE id=?').run(String(row.payload),String(row.id))
  assert.ok((await store.recall('slow',{scope:'any'})).hits.length>0, 'repair is visible through the same live client')
})

test('source deletion is opt-in and requires a matching durable tombstone receipt', async () => {
  assert.equal(client().client.forget, undefined)
  const worker = new FakeWorker()
  const store = new PersonalMemoryStoreClient({path:'/private/tmp/mem0-client-test',userId:'host-user',
    embedding:{baseUrl:'https://example.invalid/v1',apiKey:'test',model:'test'},
    supportsForget:true,workerFactory:()=>worker})
  const opening=store.open();worker.respond(requestId(worker,0),opened());await opening
  try {
    const deletion=store.forget!('source-1')
    assert.deepEqual(worker.messages[1],{kind:'request',request_id:requestId(worker,1),operation:'forget',sourceId:'source-1'})
    worker.respond(requestId(worker,1),{state:'forgotten',source_id:'source-1'})
    assert.deepEqual(await deletion,{sourceId:'source-1',state:'deleted'})
    const malformed=store.forget!('source-2')
    worker.respond(requestId(worker,2),{state:'learned',source_id:'source-2'})
    await assert.rejects(malformed,{message:'personal_memory_unavailable'})
  } finally {await store.close()}
})


test('close is bounded and unreferences a worker whose terminate never settles', async () => {
  const worker = new FakeWorker()
  let unreferenced = false
  Object.assign(worker, {unref: () => {unreferenced = true}, terminate: () => new Promise<number>(() => { /* emulate a stuck native worker */ })})
  const {client: store} = client(worker)
  const opening = store.open()
  worker.respond(requestId(worker, 0), {response_adaptation: responseAdaptation()})
  await opening
  const start = performance.now()
  await store.close()
  assert.ok(performance.now() - start < 1_000)
  assert.equal(unreferenced, true)
})


test('a stalled worker request rejects at its deadline and terminates its owner', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const {client: store, worker} = client()
  const opening = store.open()
  worker.respond(requestId(worker, 0), {response_adaptation: responseAdaptation()})
  await opening
  const recalled = assert.rejects(store.recall('tea'), {code: 'WORKER_ERROR'})
  t.mock.timers.tick(5_000)
  await recalled
  assert.equal(worker.terminated, 1)
  await store.close()
})
