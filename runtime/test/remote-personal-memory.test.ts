import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {test} from 'node:test'
import {mkdtemp, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {VirtualClock} from '../src/clock.js'
import {Memory} from '../src/memory.js'
import {RealtimeRuntimeBridge} from '../src/realtime/bridge.js'
import {compileToolSchema} from '../src/tool-schema.js'
import {loadSettings, requirePersonalMemory} from '../src/config.js'
import {personalMemoryFactory} from '../src/memory/factory.js'
import {RemotePersonalMemoryResource} from '../src/memory/remote-personal-memory.js'

// Removing identity-bound requests, reply validation, or lifetime fencing breaks these checks.
test('remote memory shares state across channels and bounds untrusted responses and lifetimes', async () => {
  const turns = new Map<string, string>()
  let mode = 'normal'
  let revision = 0
  const server = createServer((req, res) => {
    void (async () => {
    if (!['Bearer test-owner', 'Bearer test-voice'].includes(req.headers.authorization ?? '')) {res.writeHead(401).end('secret server details'); return}
    if (mode === 'oversize') {res.end(' '.repeat(1024 * 1024 + 1)); return}
    if (mode === 'timeout') return
    if (mode === 'bad-preferences' && req.url === '/v1/preferences') {res.end('{}'); return}
    if (mode === 'redirect') {res.writeHead(302, {location: '/leak'}).end(); return}
    if (mode === 'malformed') {res.end('{"revision":-1,"replyPreferences":[]}'); return}
    let raw = ''
    for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    assert.equal(body.userId, undefined)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/preferences') res.end(JSON.stringify({revision, replyPreferences: [...turns].map(([id,text]) => ({id,text,evidenceIds:[id]}))}))
    else if (req.url === '/v1/remember') {
      turns.set(String(body.sourceId), String(body.text)); revision++
      res.end(JSON.stringify({sourceId: body.sourceId, state:'stored'}))
    } else if (req.url === '/v1/forget') {
      turns.delete(String(body.sourceId)); revision++
      res.end(JSON.stringify({sourceId:body.sourceId,state:'deleted'}))
    } else res.end(JSON.stringify({source:'personal',state:turns.size ? 'ok':'empty',scope:body.scope,hits:[...turns].map(([memoryId,text]) => ({memoryId,text,evidenceIds:[memoryId],subject:'',attribute:'',emotion:''})),degraded:false}))
    })().catch(() => res.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const options = {url:`http://127.0.0.1:${address.port}`,token:'test-owner',timeoutMs:150}
  const desktop = new RemotePersonalMemoryResource(options)
  const voice = new RemotePersonalMemoryResource({...options,token:'test-voice'})
  try {
    await Promise.all([desktop.open(),voice.open()])
    await assert.rejects(desktop.recall('x', {limit:21}), {message:'personal_memory_error'})
    assert.deepEqual(await desktop.remember({sourceId:'a',sessionId:'desktop',sequence:1,text:'Short replies',occurredAt:null,previousAssistantReply:'a'.repeat(40000)}), {sourceId:'a',state:'stored'})
    assert.equal((await voice.recall('replies')).hits[0]?.text, 'Short replies')
    assert.equal(voice.responseAdaptation().replyPreferences[0]?.text, 'Short replies')
    await voice.forget('a')
    assert.equal(voice.responseAdaptation().replyPreferences.length, 0)
    const denied = new RemotePersonalMemoryResource({...options,token:'wrong'})
    await assert.rejects(denied.open(), {message:'personal_memory_unavailable'})
    assert.throws(() => denied.responseAdaptation(), {message:'personal_memory_unavailable'})
    for (const bad of ['malformed','redirect','timeout','oversize']) {
      mode = bad
      await assert.rejects(voice.recall('x'), {message:'personal_memory_unavailable'})
    }
    mode = 'normal'
    await desktop.remember({sourceId:'to-delete',sessionId:'desktop',sequence:2,text:'Stale preference',occurredAt:null})
    mode = 'bad-preferences'
    await assert.rejects(desktop.forget('to-delete'), {message:'personal_memory_unavailable'})
    assert.throws(() => desktop.responseAdaptation(), {message:'personal_memory_unavailable'})
    mode = 'normal'
    await desktop.open()
    const signal = AbortSignal.abort()
    await assert.rejects(desktop.recall('x', {signal}), {message:'personal_memory_unavailable'})
    mode = 'timeout'
    const pending = desktop.recall('x')
    await desktop.close()
    await assert.rejects(pending, {message:'personal_memory_unavailable'})
    assert.throws(() => desktop.responseAdaptation(), {message:'personal_memory_unavailable'})
    mode = 'normal'
    await desktop.open()
    assert.equal(desktop.responseAdaptation().replyPreferences.length, 0)
    await desktop.close()
    mode = 'timeout'
    const opening = assert.rejects(desktop.open(), {message:'personal_memory_unavailable'})
    await desktop.close()
    mode = 'normal'
    await desktop.open()
    await opening
    assert.equal(desktop.responseAdaptation().replyPreferences.length, 0)
  } finally {
    await Promise.all([desktop.close(),voice.close()])
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('remote memory accepts only HTTPS or numeric loopback HTTP without embedded credentials', () => {
  for (const url of ['http://example.com','http://0.0.0.0','https://user:pass@example.com','http://127.0.0.1/?token=x']) {
    assert.throws(() => new RemotePersonalMemoryResource({url,token:'test'}))
  }
})


test('HTTP memory configuration requires explicit host URL and credential without local model settings', () => {
  const env = {NOVA_AUDIO_AGENT_MEMORY_CONNECTION:'remote', NOVA_AUDIO_AGENT_MEMORY_URL:'http://127.0.0.1:8030', NOVA_AUDIO_AGENT_MEMORY_TOKEN:'test-owner'}
  assert.deepEqual(requirePersonalMemory(loadSettings(env)), {connection:'remote',url:'http://127.0.0.1:8030',token:'test-owner'})
  assert.ok(personalMemoryFactory(loadSettings(env))?.() instanceof RemotePersonalMemoryResource)
  assert.throws(() => requirePersonalMemory(loadSettings({...env,NOVA_AUDIO_AGENT_MEMORY_URL:''})))
  assert.throws(() => requirePersonalMemory(loadSettings({...env,NOVA_AUDIO_AGENT_MEMORY_TOKEN:''})))
})

test('remote connection failure never opens a local memory store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-remote-only-'))
  const server = createServer((request, response) => {request.resume();response.writeHead(401).end()})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const resource = personalMemoryFactory(loadSettings({
    NOVA_AUDIO_AGENT_MEMORY_CONNECTION:'remote',
    NOVA_AUDIO_AGENT_MEMORY_URL:`http://127.0.0.1:${address.port}`,
    NOVA_AUDIO_AGENT_MEMORY_TOKEN:'test-owner',
    NOVA_AUDIO_AGENT_MEMORY_PATH:join(directory,'must-not-exist.sqlite'),
  }))!()
  try {
    assert.ok(resource instanceof RemotePersonalMemoryResource)
    await assert.rejects(resource.open(), {message:'personal_memory_unavailable'})
    await assert.rejects(resource.recall('work'), {message:'personal_memory_unavailable'})
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await resource.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, {recursive:true,force:true})
  }
})

test('HTTP recall with absent optional metadata reaches the realtime bridge without losing evidence', async () => {
  const hit = {memoryId:'fact-1',text:'Tea preference',evidenceIds:['source-1'],subject:'',attributedTo:'',attribute:'',emotion:'',occurredAt:'',recordedAt:''}
  const server = createServer((req, res) => {
    req.resume()
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify(req.url === '/v1/preferences' ? {revision:0,replyPreferences:[]} : {
      source:'personal',state:'ok',scope:'recent',hits:[hit],contextHits:[{...hit,memoryId:'context-1'}],degraded:false,
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const personalMemory = new RemotePersonalMemoryResource({url:`http://127.0.0.1:${address.port}`,token:'test'})
  try {
    await personalMemory.open()
    const memory = new Memory()
    const origin = memory.append('conversation', {ts:1,trust:'trusted_user',priority:100,content:{text:'What tea do I prefer?'}})
    const bridge = new RealtimeRuntimeBridge({
      runtime: {clock:new VirtualClock(),memory,executors:new Map(),
        ingestUserInput:() => Promise.reject(new Error('unused')),dispatchExternal:() => ({accepted:false,delegate_id:null})},
      personalMemory,tools:compileToolSchema([], {includeMemoryRecall:true}),idFactory:() => 'host-1',
    })
    const result = await bridge.acceptPersonalMemoryRecall({
      kind:'tool_call_ready',session_epoch:1,call_id:'recall-1',item_id:'tool-1',response_id:'response-1',
      name:'memory__recall',arguments:{query:'tea',scope:'recent',source:'personal'},
    }, {originRef:`${origin.channel}:${origin.seq}`})
    const content = JSON.parse(result.host_item.content) as {state:string;hits:{memory_id:string;evidence_ids:string[]}[];context_hits:{memory_id:string;evidence_ids:string[]}[]}
    assert.equal(result.accepted,true)
    assert.equal(content.state,'ok')
    assert.deepEqual(content.hits.map(item => [item.memory_id,item.evidence_ids]), [['fact-1',['source-1']]])
    assert.deepEqual(content.context_hits.map(item => [item.memory_id,item.evidence_ids]), [['context-1',['source-1']]])
  } finally {
    await personalMemory.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
