import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClientPairing} from '../src/server/client-pairing.js'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {test} from 'node:test'
import {WebSocket} from 'ws'

import {ClientServer} from '../src/server/client-server.js'
import type {ClientMedia} from '../src/server/client-protocol.js'
import {encodeAudioFrame} from '../src/desktop/desktop-wire.js'
const token = '0123456789abcdef0123456789abcdef'

async function peer(port: number, path = '/client/v1'): Promise<{socket: WebSocket; next: () => Promise<Record<string, unknown>>}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  const frames: Record<string, unknown>[] = []
  const readers: ((frame: Record<string, unknown>) => void)[] = []
  socket.on('message', data => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    const frame = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    const read = readers.shift()
    if (read) read(frame)
    else frames.push(frame)
  })
  await once(socket, 'open')
  return {socket, next: async () => frames.shift() ?? new Promise(resolve => readers.push(resolve))}
}

function hello(socket: WebSocket, credential = token): void {
  socket.send(JSON.stringify({type: 'hello', token: credential, protocol_version: 1}))
}

test('private endpoint authenticates before ready and routes controls once', {timeout: 5000}, async t => {
  let controls = 0
  const server = new ClientServer({token, port: 0, onControl: () => { controls++ }})
  t.after(() => server.close())
  const {port} = await server.start()
  const client = await peer(port)
  t.after(() => client.socket.terminate())
  hello(client.socket)
  const ready = await client.next()
  assert.equal(ready.type, 'client.ready')
  assert.equal(ready.protocol_version, 1)
  assert.equal(ready.media, undefined, 'unconfigured transport must not invent a production pipeline')
  const command = {type: 'client.command', request_id: 'r', connection_id: ready.connection_id,
    payload: {type: 'project.confirmation_decision', proposal_id: 'p', confirmed: true}}
  client.socket.send(JSON.stringify(command))
  assert.equal((await client.next()).status, 'applied')
  client.socket.send(JSON.stringify(command))
  assert.equal((await client.next()).status, 'applied')
  assert.equal(controls, 1)
})

test('bad token, unknown version, unauthenticated audio and non-versioned paths cannot access runtime', {timeout: 5000}, async t => {
  let authenticated = 0
  const server = new ClientServer({token, port: 0, onClientAuthenticated: () => { authenticated++ }})
  t.after(() => server.close())
  const {port} = await server.start()
  const wrong = await peer(port)
  const closed = once(wrong.socket, 'close')
  hello(wrong.socket, 'ffffffffffffffffffffffffffffffff')
  assert.equal((await closed)[0], 4003)
  const version = await peer(port)
  const versionClosed = once(version.socket, 'close')
  version.socket.send(JSON.stringify({type: 'hello', token, protocol_version: 2}))
  assert.equal((await versionClosed)[0], 4006)
  const audio = await peer(port)
  const audioClosed = once(audio.socket, 'close')
  audio.socket.send(Buffer.from([0, 0]))
  assert.equal((await audioClosed)[0], 4003)
  const debug = await peer(port, '/debug-board')
  assert.equal((await once(debug.socket, 'close'))[0], 4004)
  assert.equal(authenticated, 0)
})

test('disconnect fences queued controls and fresh connection resumes same service', {timeout: 5000}, async t => {
  let unblock: (() => void) | undefined
  let audioEntered: (() => void) | undefined
  const entered = new Promise<void>(resolve => { audioEntered = resolve })
  const hold = new Promise<void>(resolve => { unblock = resolve })
  let controls = 0
  const server = new ClientServer({token, port: 0, onControl: () => { controls++ },
    onAudio: async () => { audioEntered?.(); await hold }})
  t.after(() => server.close())
  const {port} = await server.start()
  const first = await peer(port)
  hello(first.socket)
  const ready1 = await first.next()
  first.socket.send(Buffer.from([0, 0]))
  await entered
  first.socket.send(JSON.stringify({type: 'client.command', request_id: 'stale', connection_id: ready1.connection_id,
    payload: {type: 'project.confirmation_decision', proposal_id: 'p', confirmed: true}}))
  await server.disconnectClient()
  unblock?.()
  const second = await peer(port)
  t.after(() => second.socket.terminate())
  hello(second.socket)
  const ready2 = await second.next()
  assert.equal(ready2.server_instance_id, ready1.server_instance_id)
  assert.notEqual(ready2.connection_id, ready1.connection_id)
  assert.equal(controls, 0)
})

test('second client is busy and unsafe frames terminate only their connection', {timeout: 5000}, async t => {
  const server = new ClientServer({token, port: 0})
  t.after(() => server.close())
  const {port} = await server.start()
  const first = await peer(port)
  hello(first.socket)
  await first.next()
  const second = await peer(port)
  assert.equal((await once(second.socket, 'close'))[0], 4009)
  const closed = once(first.socket, 'close')
  first.socket.send(Buffer.from([0]))
  assert.equal((await closed)[0], 4003)
  const third = await peer(port)
  t.after(() => third.socket.terminate())
  hello(third.socket)
  assert.equal((await third.next()).type, 'client.ready')
})

test('a missing control consumer rejects rather than caching a false delivery receipt', {timeout: 5000}, async t => {
  const server = new ClientServer({token, port: 0})
  t.after(() => server.close())
  const client = await peer((await server.start()).port)
  t.after(() => client.socket.terminate())
  hello(client.socket)
  const ready = await client.next()
  const command = JSON.stringify({type: 'client.command', request_id: 'missing', connection_id: ready.connection_id,
    payload: {type: 'project.confirmation_decision', proposal_id: 'p', confirmed: true}})
  client.socket.send(command)
  assert.equal((await client.next()).status, 'rejected')
  client.socket.send(command)
  assert.equal((await client.next()).status, 'rejected')
})

test('a blocked provider cannot accumulate unbounded empty input messages', {timeout: 5000}, async t => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const server = new ClientServer({token, port: 0, onAudio: async () => { entered(); await blocked }})
  t.after(async () => { release(); await server.close() })
  const {port} = await server.start()
  const client = await peer(port)
  hello(client.socket)
  await client.next()
  client.socket.send(Buffer.from([0, 0]))
  await waiting
  const closed = once(client.socket, 'close')
  for (let n = 0; n < 129; n++) client.socket.send(Buffer.alloc(0))
  assert.equal((await closed)[0], 4003)
})

test('media negotiation selects configured relay and rejects incompatible offers before admission', {timeout: 5000}, async t => {
  let admissions = 0
  const server = new ClientServer({token, port: 0,
    media: {transport: 'host_pcm_v1', path: 'relay', audio_owner: 'client', pipeline: 'cascaded'},
    onClientAuthenticated: () => { admissions++ },
  })
  t.after(() => server.close())
  const {port} = await server.start()
  for (const media of [{transports: ['qwen_aoq_v1']}, {transports: []}, null, {transports: ['host_pcm_v1'], endpoint: 'https://untrusted'}]) {
    const client = await peer(port)
    const closed = once(client.socket, 'close')
    client.socket.send(JSON.stringify({type: 'hello', token, protocol_version: 1, media}))
    assert.equal((await closed)[0], 4006)
  }
  assert.equal(admissions, 0)
  const client = await peer(port)
  t.after(() => client.socket.terminate())
  client.socket.send(JSON.stringify({type: 'hello', token, protocol_version: 1,
    media: {transports: ['qwen_aoq_v1', 'host_pcm_v1']}}))
  const ready = await client.next()
  assert.deepEqual(ready.media, {transport: 'host_pcm_v1', path: 'relay', audio_owner: 'client', pipeline: 'cascaded'})
  assert.equal(admissions, 1)
})


test('server rejects an invalid configured media path before allocating a listener', () => {
  for (const media of [null, {transport: 'qwen_aoq_v1', path: 'direct'},
    {transport: 'host_pcm_v1', path: 'relay', audio_owner: 'client', pipeline: 'integrated', token: 'must-not-leak'}]) {
    assert.throws(() => new ClientServer({token, port: 0, media: media as unknown as ClientMedia}))
  }
})


test('authenticated language is validated and omitted language does not inherit the prior client', {timeout: 5000}, async t => {
  const languages: unknown[] = []
  const server = new ClientServer({token, port: 0, onClientAuthenticated: language => { languages.push(language) }})
  t.after(() => server.close())
  const {port} = await server.start()
  for (const language of ['en', undefined]) {
    const client = await peer(port)
    client.socket.send(JSON.stringify({type: 'hello', token, protocol_version: 1, language}))
    await client.next()
    await server.disconnectClient()
  }
  assert.deepEqual(languages, ['en', undefined])
  const invalid = await peer(port)
  const closed = once(invalid.socket, 'close')
  invalid.socket.send(JSON.stringify({type: 'hello', token, protocol_version: 1, language: 'fr'}))
  await closed
  assert.deepEqual(languages, ['en', undefined])
})
test('authenticated paired identity survives reconnect and remains distinct from shared master', {timeout:5000},async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-task-client-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const pairing=new ClientPairing(token,join(dir,'devices.json'))
 const device=pairing.redeem(pairing.create('wss://example.com/client/v1').code,'Device')
 const identities:unknown[]=[]
 const server=new ClientServer({token,port:0,pairing,onControl:(_control,context)=>{identities.push(context)}})
 t.after(()=>server.close());const {port}=await server.start()
 const connections:unknown[]=[]
 for(const credential of [device.token,device.token,token]){
  const client=await peer(port);hello(client.socket,credential);const ready=await client.next();connections.push(ready.connection_id)
  client.socket.send(JSON.stringify({type:'client.command',request_id:'same',connection_id:ready.connection_id,payload:{type:'personal.command',request_id:'same',method:'tasks.list',params:{}}}))
  assert.equal((await client.next()).status,'applied');await server.disconnectClient()
 }
 assert.notEqual(connections[0],connections[1])
 assert.deepEqual(identities,[{client_id:'remote:'+device.device_id,can_takeover:true},{client_id:'remote:'+device.device_id,can_takeover:true},{client_id:'remote:master',can_takeover:false}])
 assert.throws(()=>pairing.clientIdentity('f'.repeat(32)),/authentication failed/)
})

test('personal clients receive a compact coalesced snapshot with a 1 MiB budget', {timeout: 5000}, async t => {
  const server = new ClientServer({token, port: 0})
  t.after(() => server.close())
  const client = await peer((await server.start()).port)
  t.after(() => client.socket.terminate())
  client.socket.send(JSON.stringify({type:'hello',token,protocol_version:1,capabilities:['personal']}))
  assert.ok((await client.next()).capabilities instanceof Array)
  const snapshot = {type:'personal.state',revision:1,life:{profile:{about:'x'.repeat(300_000)}},sources:['private'],feishu:{secret:true},connectors:{secret:true},news:{enabled:true,items:[{id:'n',title:'Article',summary:'Summary',url:'https://example.com',private_field:'secret'}],sources:[{token:'secret'}]},capabilities:{sources:true,memory:{list:true}},workbench_context:{status:'ready',candidate_count:3,recap:{text:'Busy',projects:[{name:'Nova',line:'Workbench',path:'/private'}]},cards:[{id:'c',candidate_id:'c',tab:'todos',title:'Try it',body:'Body',why:'Why',next:'Next',refs:[{entry_id:'source:1',version:'v',label:'private excerpt'}]}]},profile_preparation:{status:'ready',draft:{about:{text:'About',refs:[{entry_id:'p'}]},work:[{title:'W',text:'T',refs:[{entry_id:'p'}]}]},sources:[{id:'p',label:'private label'}]}}
  await server.sendText(JSON.stringify(snapshot))
  await server.sendText(JSON.stringify({...snapshot,revision:2}))
  const state = await client.next()
  assert.equal(state.revision,2)
  assert.equal(state.sources,undefined)
  assert.equal(state.feishu,undefined)
  assert.equal(state.connectors,undefined)
  assert.deepEqual(state.news,{enabled:true,refreshing:false,items:[{id:'n',title:'Article',summary:'Summary',url:'https://example.com'}],saved:[]})
  assert.deepEqual(state.capabilities,{memory:{list:true}})
  assert.deepEqual(state.workbench_context,{status:'ready',recap:{text:'Busy',projects:[{name:'Nova',line:'Workbench'}]},cards:[{id:'c',tab:'todos',title:'Try it',body:'Body',why:'Why',next:'Next',source_count:1}]})
  assert.deepEqual(state.profile_preparation,{status:'ready',draft:{about:'About',work:[{title:'W',text:'T'}]}})
  assert.doesNotMatch(JSON.stringify(state),/private/)
  await server.sendText(JSON.stringify({...snapshot,revision:3,life:{profile:{about:'x'.repeat(1_048_576)}}}))
  assert.deepEqual(await client.next(),{type:'personal.state',revision:3,reload_required:true})
})

test('personal result state is projected and oversized results preserve their outcome', {timeout:5000}, async t => {
  const server = new ClientServer({token,port:0})
  t.after(()=>server.close())
  const client=await peer((await server.start()).port)
  t.after(()=>client.socket.terminate())
  client.socket.send(JSON.stringify({type:'hello',token,protocol_version:1,capabilities:['personal']}))
  assert.ok(((await client.next()).capabilities as string[]).includes('personal'))
  await server.sendText(JSON.stringify({type:'personal.result',request_id:'r',ok:true,data:{type:'personal.state',revision:4,life:{},sources:['secret']}}))
  assert.deepEqual((await client.next()).data,{type:'personal.state',revision:4,life:{}})
  await server.sendText(JSON.stringify({type:'personal.result',request_id:'r2',ok:true,data:'x'.repeat(1_048_576)}))
  assert.deepEqual(await client.next(),{type:'personal.result',request_id:'r2',ok:true,reload_required:true})
})

test('legacy clients retain ready capabilities and 16 KiB text limit', {timeout:5000}, async t=>{
  const server=new ClientServer({token,port:0});t.after(()=>server.close())
  const client=await peer((await server.start()).port);t.after(()=>client.socket.terminate())
  hello(client.socket)
  assert.equal(((await client.next()).capabilities as string[]).includes('personal'),false)
  await assert.rejects(server.sendText(JSON.stringify({type:'personal.state',revision:1,life:{text:'x'.repeat(17000)}})),/too large/)
})

test('personal paired devices cannot take over or manage connectors', {timeout:5000}, async t=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-personal-client-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const pairing=new ClientPairing(token,join(dir,'devices.json'))
  const device=pairing.redeem(pairing.create('wss://example.com/client/v1').code,'Mobile')
  const contexts:unknown[]=[]
  const server=new ClientServer({token,port:0,pairing,onControl:(_control,context)=>{contexts.push(context)}})
  t.after(()=>server.close())
  const client=await peer((await server.start()).port);t.after(()=>client.socket.terminate())
  client.socket.send(JSON.stringify({type:'hello',token:device.token,protocol_version:1,capabilities:['personal']}))
  const ready=await client.next()
  for(const method of ['state','connector.status','feishu.status','sources.add']) {
    client.socket.send(JSON.stringify({type:'client.command',request_id:method,connection_id:ready.connection_id,payload:{type:'personal.command',request_id:method,method,params:{}}}))
    assert.equal((await client.next()).status,method==='state'?'applied':'rejected')
  }
  assert.deepEqual(contexts,[{client_id:'remote:master',can_takeover:false}])
  await server.sendText(JSON.stringify({type:'personal.state',revision:99,life:{}}))
  await server.disconnectClient()
})

for (const personal of [false,true]) test(`shared workbench enforces mobile privileges regardless of hello personal=${personal}`, {timeout:5000}, async t=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-shared-client-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const pairing=new ClientPairing(token,join(dir,'devices.json'))
  const device=pairing.redeem(pairing.create('wss://example.com/client/v1').code,'Mobile')
  const contexts:unknown[]=[]
  const controls:unknown[]=[]
  let pcmBytes=0
  const server=new ClientServer({token,port:0,pairing,sharedWorkbench:true,prepareLegacyVoice:async()=>'legacy-chat',
    onAudio:pcm=>{pcmBytes+=pcm.length},onControl:(control,context)=>{controls.push(control);if(control.type==='personal.command')contexts.push(context)}})
  t.after(()=>server.close())
  const client=await peer((await server.start()).port);t.after(()=>client.socket.terminate())
  client.socket.send(JSON.stringify({type:'hello',token:device.token,protocol_version:1,...(personal?{capabilities:['personal']}:{})}))
  const ready=await client.next()
  for(const method of ['tasks.list','presentation.set','connector.status','feishu.status','sources.add']) {
    client.socket.send(JSON.stringify({type:'client.command',request_id:method,connection_id:ready.connection_id,payload:{type:'personal.command',request_id:method,method,params:method==='presentation.set'?{mode:'workbench'}:{}}}))
    assert.equal((await client.next()).status,['tasks.list','presentation.set'].includes(method)?'applied':'rejected')
  }
  assert.deepEqual(contexts,[{client_id:'remote:master',can_takeover:false},{client_id:'remote:master',can_takeover:false}])
  if(!personal){
    assert.deepEqual(controls[0],{type:'input.audio',conversation_id:'legacy-chat'})
    client.socket.send(Buffer.from([0,0]))
    client.socket.send(JSON.stringify({type:'client.command',request_id:'text',connection_id:ready.connection_id,payload:{type:'input.text',text:'hello'}}))
    assert.equal((await client.next()).status,'applied')
    assert.equal(pcmBytes,2)
    assert.deepEqual(controls.at(-1),{type:'input.text',text:'hello',conversation_id:'legacy-chat'})
    await server.sendText(JSON.stringify({type:'personal.state',revision:1,sources:['private'],life:{text:'x'.repeat(1_100_000)}}))
    await server.sendText(JSON.stringify({type:'personal.result',request_id:'secret',ok:true,data:{sources:['private']}}))
    await server.sendText(JSON.stringify({type:'caption',conversation_id:'other-chat',text:'private'}))
    await server.sendText(JSON.stringify({type:'caption',conversation_id:'legacy-chat',text:'safe'}))
    assert.equal((await client.next()).text,'safe')
    assert.equal(client.socket.readyState,WebSocket.OPEN)
  }
})

test('a fresh result snapshot cancels an older coalesced snapshot', {timeout:5000},async t=>{
  const server=new ClientServer({token,port:0});t.after(()=>server.close())
  const client=await peer((await server.start()).port);t.after(()=>client.socket.terminate())
  client.socket.send(JSON.stringify({type:'hello',token,protocol_version:1,capabilities:['personal']}));await client.next()
  await server.sendText(JSON.stringify({type:'personal.state',revision:1,life:{}}))
  await server.sendText(JSON.stringify({type:'personal.result',request_id:'fresh',ok:true,data:{type:'personal.state',revision:2,life:{}}}))
  assert.equal(((await client.next()).data as {revision:number}).revision,2)
  await new Promise(resolve=>setTimeout(resolve,300))
  await server.sendText(JSON.stringify({type:'caption',text:'barrier'}))
  assert.equal((await client.next()).type,'caption')
})

test('legacy shared endpoint fails explicitly when voice cannot be acquired', {timeout:5000},async t=>{
  const server=new ClientServer({token,port:0,sharedWorkbench:true,prepareLegacyVoice:async()=>{throw Error('voice_not_owned')}});t.after(()=>server.close())
  const client=await peer((await server.start()).port)
  const closed=once(client.socket,'close')
  hello(client.socket)
  assert.equal((await closed)[0],4009)
})


test('personal snapshot budget never relaxes audio backpressure', {timeout:5000},async t=>{
  const server=new ClientServer({token,port:0});t.after(()=>server.close())
  const client=await peer((await server.start()).port);t.after(()=>client.socket.terminate())
  client.socket.send(JSON.stringify({type:'hello',token,protocol_version:1,capabilities:['personal']}));await client.next()
  t.mock.getter(WebSocket.prototype,'bufferedAmount',()=>300_000)
  await server.sendText(JSON.stringify({type:'personal.result',request_id:'read',ok:true,data:'x'.repeat(300_000)}))
  assert.equal((await client.next()).type,'personal.result')
  const closed=once(client.socket,'close')
  await assert.rejects(server.sendBinary(encodeAudioFrame({utterance_id:'u',generation_epoch:1,sequence:0,pcm:new Uint8Array([0,0])})),/queue full/)
  assert.equal((await closed)[0],4008)
})

test('personal protocol faults preserve credentials while revocation stays 4003', {timeout:5000}, async t => {
  const server=new ClientServer({token,port:0})
  t.after(()=>server.close())
  const {port}=await server.start(), client=await peer(port)
  client.socket.send(JSON.stringify({type:'hello',token,protocol_version:1,capabilities:['personal']}))
  await client.next()
  const closed=once(client.socket,'close')
  client.socket.send(Buffer.alloc(0))
  assert.equal((await closed)[0],1002)
  const wrong=await peer(port)
  const rejected=once(wrong.socket,'close')
  wrong.socket.send(JSON.stringify({type:'hello',token:'f'.repeat(32),protocol_version:1,capabilities:['personal']}))
  assert.equal((await rejected)[0],4003)
})
