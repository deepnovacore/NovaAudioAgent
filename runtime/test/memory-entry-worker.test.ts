import assert from 'node:assert/strict'
import {mkdtemp,rm,chmod,realpath} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {VoiceMem} from 'voicemem'
import {PersonalMemoryStoreClient,PersonalMemoryStoreClientError} from '../src/voicemem/store-client.js'

test('real Worker mutations update recall and cached adaptation before durable receipt',async()=>{
 const server=createServer((request,response)=>{
  void (async()=>{
  let body='';for await(const chunk of request)body+=String(chunk)
  const input=JSON.parse(body) as {input:string[]}
  response.setHeader('content-type','application/json')
  response.end(JSON.stringify({data:input.input.map((_,index)=>({index,embedding:[1,0]}))}))
  })().catch((error:unknown)=>response.destroy(error instanceof Error?error:new Error(String(error))))
 })
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const address=server.address();assert(address&&typeof address==='object')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-worker-entry-')),path=join(dir,'memory.sqlite')
 const now='2026-09-11T00:00:00.000Z'
 const memory=new VoiceMem({path,userId:'user',model:{complete(){return Promise.resolve('{}')}},embeddings:{model:'test',embed(){return Promise.resolve([[1,0]])}}})
 const source=memory.store.admit({id:'source',userId:'user',scope:'personal',sessionId:'session',text:'brief replies',occurredAt:now,recordedAt:now,authority:'inferred',assistantReply:''})
 memory.store.commit(source,[{record:{id:'preference',userId:'user',scope:'personal',kind:'trait',text:'brief replies',subject:'user',attribute:'reply_preference',slots:[],entities:[],emotion:'',authority:'inferred',occurredAt:now,recordedAt:now,revision:1,supersededBy:null,evidenceIds:['source']},vector:[1,0],model:'test'}],[])
 await memory.close()
 await chmod(path,0o600)
 const options={path,userId:'user',embedding:{baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test',model:'test',dimensions:2}}
 let client=new PersonalMemoryStoreClient(options)
 try {
 await client.open();assert.equal(client.responseAdaptation().replyPreferences.length,1)
 const corrected=await client.correct('preference',1,'detailed replies',{type:'conversation',ref:'correction',observed_at:now})
 assert.equal(client.responseAdaptation().replyPreferences[0]?.text,'detailed replies')
 assert.equal(corrected.entry.origin,'stated')
 assert.equal(corrected.entry.kind,'preference')
 assert.equal(corrected.previous.version,2)
 await assert.rejects(client.correct('preference',1,'stale',{type:'conversation',ref:'stale',observed_at:now}),{code:'STORE_CONFLICT'})
 const recall=await client.recall('replies',{scope:'any'})
 assert.equal([...recall.hits,...recall.contextHits??[]].some(hit=>hit.text==='brief replies'),false)
 await client.forgetEntry(corrected.entry.id,1)
 assert.equal((await client.recall('replies',{scope:'any'})).hits.length,0)
 const file=await client.observeSource({source_ref:{type:'file',ref:'project',observed_at:now},content:'Directory contains Example',topic:'Example'})
 assert.equal(file?.source_refs[0]?.type,'file');assert.equal(file?.topic,'Example')
 await client.forgetSource('project')
 await client.close();client=new PersonalMemoryStoreClient(options);await client.open()
 assert.equal((await client.get(corrected.entry.id))?.status,'forgotten')
 assert.equal((await client.list()).entries.length,0)
 assert.equal(client.responseAdaptation().replyPreferences.length,0)
 }finally{await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true})}
})

for(const delay of [10,1000])test(`close drains or reports unknown for a correction delayed ${delay}ms`,async()=>{
 let release!:()=>void,started!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const began=new Promise<void>(resolve=>{started=resolve})
 const server=createServer((request,response)=>{
  void (async()=>{
  let body='';for await(const chunk of request)body+=String(chunk)
  const input=JSON.parse(body) as {input:string[]}
  if(input.input.includes('after close')){started();await gate}
  response.setHeader('content-type','application/json')
  response.end(JSON.stringify({data:input.input.map((_,index)=>({index,embedding:[1,0]}))}))
  })().catch((error:unknown)=>response.destroy(error instanceof Error?error:new Error(String(error))))
 })
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const address=server.address();assert(address&&typeof address==='object')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-worker-close-'))
 const options={path:join(dir,'memory.sqlite'),userId:'user',embedding:{baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test',model:'test',dimensions:2}}
 let client=new PersonalMemoryStoreClient(options)
 try {
  await client.open()
  const initial=await client.observeSource({source_ref:{type:'file',ref:'file',observed_at:'2026-09-11T00:00:00.000Z'},content:'before close'})
  assert(initial)
  const mutation=client.correct(initial.id,initial.version,'after close',{type:'conversation',ref:'correction',observed_at:'2026-09-11T00:00:00.000Z'})
  const outcome=mutation.then(entry=>({entry}),(error:unknown)=>({error}))
  await began
  const timer=setTimeout(release,delay)
  const start=Date.now();await client.close();assert(Date.now()-start<1000)
  clearTimeout(timer);release()
  const result=await outcome
  client=new PersonalMemoryStoreClient(options);await client.open()
  if(delay===10){assert('entry' in result);assert.equal((await client.get(initial.id))?.status,'corrected')}
  else {assert('error' in result);assert(result.error instanceof PersonalMemoryStoreClientError);assert.equal(result.error.code,'MUTATION_OUTCOME_UNKNOWN');assert.equal((await client.get(initial.id))?.status,'active')}
 }finally{release();await client.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true})}
})
