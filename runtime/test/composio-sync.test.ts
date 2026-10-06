import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {ComposioConnector} from '../src/connectors/composio/index.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
test('configured connector stores local evidence without processing consent and disconnect retains it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-google-sync-'));let modelCalls=0,pages=0
 const cursor={phase:'history' as const,start:Date.now()-86400000,end:Date.now(),calendar:0,baseline:'100',token:null,nextToken:null,nextBaseline:null,loaded:true,pending:[],seenTokens:[]}
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(){modelCalls++;return Promise.resolve({text:'{"entries":[]}'})}}
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',gateway,model:'fixture'})
 const client={createAuthConfig:()=>Promise.resolve('ac_fixture'),link:()=>Promise.resolve({accountId:'ca_fixture',url:'https://connect.composio.dev/link/fixture',expiresAt:new Date().toISOString()}),inspect:()=>Promise.resolve({identity:'fixture@example.test',requestedScopes:[]}),verify:()=>Promise.resolve({identity:'fixture@example.test',scope:{kind:'gmail' as const,labels:['INBOX'],pastDays:30}})}
 const connector=new ComposioConnector({memory:()=>memory,client,onChange:()=>{ /* observe via snapshot */ },provider:{page:()=>{pages++;if(pages===2||pages===3)return Promise.resolve({objects:[],continuation:cursor,checkpoint:{historyId:'100'},complete:false,snapshot:false});return Promise.resolve({objects:[{key:'fixture',kind:'mail',semanticHash:'hash',text:'A real task to remember',locator:'https://mail.google.com/',observedAt:new Date().toISOString(),retentionUntil:null,metadata:{},status:'current'}],continuation:null,checkpoint:{historyId:'100'},complete:true,snapshot:true})}},automatic:false})
 try{
  await memory.open();await connector.open()
  const linked=await connector.command('connector.link',{toolkit:'gmail'}) as {id:string}
  await connector.command('connector.complete',{id:linked.id})
  await connector.command('connector.configure',{id:linked.id,scope:{kind:'gmail',labels:['INBOX'],pastDays:30},processingConsent:false})
  await connector.syncOnce(linked.id);await memory.flush()
  assert.equal(modelCalls,0)
  const pending=await memory.options.client.memory('source_pending',{id:linked.id}) as {objects:{status:string}[]}
  assert.equal(pending.objects[0]?.status,'current')
  await connector.syncOnce(linked.id) // finish initial reconciliation
  const completed=await memory.options.client.memory('source_connection',{action:'get',id:linked.id}) as {sync_status:{retry_at:number}}
  assert(completed.sync_status.retry_at>Date.now()+50000) // another connector's pending work must not poll this account every second
  await connector.syncOnce(linked.id) // persist pending history cursor
  await connector.syncOnce(linked.id) // no progress must not consume a page receipt
  assert.equal(connector.snapshot().connections[0]?.error,'no_progress')
  await connector.syncOnce(linked.id)
  assert.equal(connector.snapshot().connections[0]?.error,null)
  await connector.command('connector.disconnect',{id:linked.id})
  const retained=await memory.options.client.memory('source_pending',{id:linked.id}) as typeof pending
  assert.equal(retained.objects.length,1)
 }finally{await connector.close();await memory.close();await rm(root,{recursive:true,force:true})}
})

test('pause can fence a pending sync rather than waiting behind its network response',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-google-fence-'));let entered!:()=>void,finish!:()=>void
 const started=new Promise<void>(r=>{entered=r}),gate=new Promise<void>(r=>{finish=r})
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete:()=>Promise.resolve({text:'{"entries":[]}'})}
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',gateway,model:'fixture'})
 const client={createAuthConfig:()=>Promise.resolve('ac_fixture'),link:()=>Promise.resolve({accountId:'ca_fixture',url:'https://connect.composio.dev/link/fixture',expiresAt:new Date().toISOString()}),inspect:()=>Promise.resolve({identity:'fixture@example.test',requestedScopes:[]}),verify:()=>Promise.resolve({identity:'fixture@example.test',scope:{kind:'gmail' as const,labels:['INBOX'],pastDays:30}})}
 const connector=new ComposioConnector({memory:()=>memory,client,onChange:()=>{ /* snapshot only */ },provider:{page:async()=>{entered();await gate;return {objects:[],continuation:null,checkpoint:{historyId:'100'},complete:true,snapshot:true}}},automatic:false})
 try{
  await memory.open();await connector.open();const linked=await connector.command('connector.link',{toolkit:'gmail'}) as {id:string}
  await connector.command('connector.complete',{id:linked.id});await connector.command('connector.configure',{id:linked.id,scope:{kind:'gmail',labels:['INBOX'],pastDays:30},processingConsent:false})
  await connector.command('connector.sync',{id:linked.id});await started
  const sync=connector.syncOnce(linked.id)
  await connector.command('connector.pause',{id:linked.id});finish();await sync
  const c=await memory.options.client.memory('source_connection',{action:'get',id:linked.id}) as {state:string;batch:number;checkpoint:unknown}
  assert.equal(c.state,'paused');assert.equal(c.batch,0);assert.equal(c.checkpoint,null)
 }finally{finish?.();await connector.close();await memory.close();await rm(root,{recursive:true,force:true})}
})


test('deletion interrupted after generation bump is resumed when connector opens',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-google-delete-'))
 const gateway:ModelGateway={async *stream(){ /* no model use in deletion recovery */ },complete:()=>Promise.resolve({text:'{"entries":[]}'})}
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',gateway,model:'fixture'})
 const connector=new ComposioConnector({memory:()=>memory,client:null,onChange(){ /* observe persisted state directly */ },automatic:false})
 try{
  await memory.open();const id=memory.prefix+'connector:interrupted'
  await memory.options.client.memory('source_connection',{action:'create',id,namespace:id})
  await memory.options.client.memory('source_connection',{action:'scope',id,expected_scope_revision:0,scope:{provider:'composio',toolkit:'gmail',userId:'fixture',authConfigId:'fixture',accountId:'fixture',identity:'fixture@example.test',selection:null}})
  await memory.options.client.memory('source_connection',{action:'delete_begin',id,expected_epoch:1})
  await connector.open()
  const c=await memory.options.client.memory('source_connection',{action:'get',id}) as {deleting:number[]}
  assert.deepEqual(c.deleting,[])
 }finally{await connector.close();await memory.close();await rm(root,{recursive:true,force:true})}
})
