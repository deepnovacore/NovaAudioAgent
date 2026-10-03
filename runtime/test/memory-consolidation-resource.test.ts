import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'
const now=()=>new Date().toISOString()
const extraction={entries:[{key:'spicy',text:'我不吃辣',topic:'饮食',kind:'preference',due:null,direction:null,status:null,valid_until:null}]}
const answer=(entries:{id:string;revision:number}[])=>({profile_derived:[{text:'清淡饮食',refs:[{id:entries[0]!.id,revision:entries[0]!.revision}]}],one_page:[{text:'整理时不吃辣',refs:[{id:entries[0]!.id,revision:entries[0]!.revision}]}]})

test('daily resource persists a derived summary once and immediately invalidates it after correction',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-daily-resource-'));const path=join(root,'memory.sqlite');let summaries=0
 const gateway:ModelGateway={async *stream(){ /* complete only */ },complete(request){const p=JSON.parse(request.prompt) as {day?:string;entries:{id:string;revision:number}[]};if(p.day)summaries++;return Promise.resolve({text:JSON.stringify(p.day?answer(p.entries):extraction)})}}
 let client=new MemoryLedgerClient(path),resource=new SubstrateMemoryResource({client,userId:'daily',gateway,model:'fixture',inputConsent:true,consolidation:{enabled:true}})
 try{
  await resource.open();await resource.remember({sourceId:'one',sessionId:'test',sequence:1,text:'我不吃辣',occurredAt:now(),confirmed:true});await resource.flush()
  assert.equal(summaries,1);const rows=await client.memory('list',{}) as EntryRevision[];assert.equal(rows.filter(row=>row.kind==='memory_summary').length,1);assert.equal(rows.find(row=>row.kind==='memory_summary')?.origin,'inferred');assert.equal((await resource.list()).entries.length,1)
  assert.ok(resource.responseAdaptation().memoryContext?.voice.includes('整理时不吃辣'))
  await resource.close();client=new MemoryLedgerClient(path);resource=new SubstrateMemoryResource({client,userId:'daily',gateway,model:'fixture',inputConsent:true,consolidation:{enabled:true}});await resource.open();await resource.flush();assert.equal(summaries,1)
  const first=(await resource.list()).entries[0]!;await resource.correct(first.id,first.version,'现在可以吃微辣',{type:'conversation',ref:'correct',observed_at:now()})
  assert.ok(!resource.responseAdaptation().memoryContext?.voice.includes('整理时不吃辣'));assert.ok(resource.responseAdaptation().memoryContext?.voice.includes('现在可以吃微辣'))
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

for(const change of ['revoke','correct','close'] as const)test(`daily summary cannot publish after ${change} while the model is pending`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-daily-race-'));let start!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{start=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const gateway:ModelGateway={async *stream(){ /* complete only */ },async complete(request){const p=JSON.parse(request.prompt) as {day?:string;entries:{id:string;revision:number}[]};if(p.day){start();await gate;return {text:JSON.stringify(answer(p.entries))}}return {text:JSON.stringify(extraction)}}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'race',gateway,model:'fixture',inputConsent:true,closeClient:false,consolidation:{enabled:true}})
 try{
  await resource.open();await resource.remember({sourceId:'one',sessionId:'test',sequence:1,text:'我不吃辣',occurredAt:now(),confirmed:true})
  assert.equal(await Promise.race([started.then(()=>true),resource.flush().then(()=>false)]),true)
  let closing:Promise<void>|undefined
  if(change==='revoke'){await resource.setProcessingConsent('one',resource.processingGrant(false,2));assert.equal(resource.responseAdaptation().memoryContext?.voice,'')}
  if(change==='correct'){const first=(await resource.list()).entries[0]!;await resource.correct(first.id,first.version,'现在可以吃微辣',{type:'conversation',ref:'correct',observed_at:now()})}
  if(change==='close')closing=resource.close()
  release();if(closing)await closing;else await resource.flush()
  assert.equal((await client.memory('list',{}) as EntryRevision[]).filter(row=>row.kind==='memory_summary').length,0)
 }finally{release?.();await resource.close();await client.close();await rm(root,{recursive:true,force:true})}
})
