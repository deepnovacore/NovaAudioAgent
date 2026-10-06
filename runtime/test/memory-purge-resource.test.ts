import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
const now=()=>new Date().toISOString()
const entry=(key:string,text:string)=>({key,text,topic:'饮食',kind:'preference',due:null,direction:null,status:null,valid_until:null})

test('resource purge validates scope and version and immediately clears deleted model-facing content',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-resource-')),client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const gateway:ModelGateway={async *stream(){ /* complete only */ },complete(){return Promise.resolve({text:JSON.stringify({entries:[entry('spicy','SYNTHETIC_PURGE_SECRET')]})})}}
 const resource=new SubstrateMemoryResource({client,userId:'purge',gateway,model:'fixture',inputConsent:true,conversationProviders:['consumer']}),port:PersonalMemoryResource=resource
 try{
  assert.ok(port.purgeEntry,'resource must expose the explicit local-user purge capability')
  assert.ok(port.pendingPurges,'resource must expose incomplete deletion receipts')
  await resource.open();assert.deepEqual(await port.pendingPurges(),[]);await resource.remember({sourceId:'one',sessionId:'synthetic',sequence:1,text:'SYNTHETIC_PURGE_SECRET',occurredAt:now(),confirmed:true});await resource.flush()
  const first=(await resource.list()).entries[0]!;assert.ok((await resource.prepareResponseAdaptation('consumer')).memoryContext?.voice.includes('SYNTHETIC_PURGE_SECRET'))
  await assert.rejects(port.purgeEntry('personal:other:entry',first.version,'wrong-scope'))
  await assert.rejects(port.purgeEntry(first.id,null,'wrong-version'))
  await assert.rejects(port.purgeEntry(first.id,Number(first.version)+1,'stale-version'))
  const result=await port.purgeEntry(first.id,first.version,'purge-synthetic-1');assert.equal(result.status,'complete');assert.ok(result.removed_entries>=1);assert.ok(result.removed_evidence>=1);assert.ok(result.removed_entry_ids?.includes(first.id));assert.ok(result.removed_evidence_ids?.includes(first.evidence_refs![0]!))
  assert.equal((await resource.list()).entries.length,0);assert.equal(await resource.readEvidence(first.evidence_refs![0]!),null);assert.equal((await resource.prepareResponseAdaptation('consumer')).memoryContext?.voice,'');assert.equal(resource.responseAdaptation().memoryContext?.voice,'')
  assert.equal((await port.purgeEntry(first.id,first.version,'purge-synthetic-1')).status,'complete','retry does not require a deleted entry to still exist')
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('purge fences an already-running extraction even when the model changes its entry key',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-pending-'));let calls=0,start!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{start=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const gateway:ModelGateway={async *stream(){ /* complete only */ },async complete(){if(++calls===2){start();await gate}return {text:JSON.stringify({entries:[entry(calls===1?'spicy':'drifting-key','我不吃辣')]})}}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'pending',gateway,model:'fixture',inputConsent:true}),port:PersonalMemoryResource=resource
 try{
  assert.ok(port.purgeEntry,'resource must expose the explicit local-user purge capability')
  await resource.open();await resource.remember({sourceId:'first',sessionId:'synthetic',sequence:1,text:'我不吃辣',occurredAt:now(),confirmed:true});await resource.flush();const first=(await resource.list()).entries[0]!
  await resource.remember({sourceId:'second',sessionId:'synthetic',sequence:2,text:'我平时不吃辣椒',occurredAt:now(),confirmed:true});await started
  await port.purgeEntry(first.id,first.version,'purge-pending');release();await resource.flush()
  assert.equal((await resource.list()).entries.length,0,'an old model result cannot recreate erased understanding under a new key')
 }finally{release?.();await resource.close();await rm(root,{recursive:true,force:true})}
})

test('incomplete purge receipts survive a blocked refresh and remain available after the row disappears',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-receipt-')),client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const gateway:ModelGateway={async *stream(){ /* complete only */ },complete(){return Promise.resolve({text:'{"entries":[]}'})}}
 const resource=new SubstrateMemoryResource({client,userId:'receipts',gateway,model:'fixture'}),port:PersonalMemoryResource=resource
 const memory=client.memory.bind(client)
 try{
  assert.ok(port.purgeEntry);assert.ok(port.pendingPurges);assert.ok(port.completePurgeIndex);await resource.open()
  const id=resource.prefix+'deleted',receipt={status:'incomplete' as const,operation_id:'synthetic-op',removed_entries:1,removed_evidence:1,removed_entry_ids:[],removed_evidence_ids:[],index_evidence_ids:[resource.prefix+'e:indexed'],backup_cleanup:{status:'incomplete' as const,unresolved:['backup_cleanup_pending']}}
  client.memory=async(operation,input)=>{
   if(operation==='purge'){assert.deepEqual(input,{request_id:'retry',entry_prefix:resource.prefix,selection:{kind:'entry',id,expected_revision:2}});return receipt}
   if(String(operation)==='purge_index_complete'){assert.deepEqual(input,{entry_prefix:resource.prefix,entry_id:id,operation_id:'synthetic-op'});return {...receipt,index_evidence_ids:[]}}
   if(operation==='purge_status')return [{...receipt,entry_id:id,expected_revision:2}]
   if(operation==='list')throw Error('STORE_MEMORY_CONFLICT')
   return memory(operation,input)
  }
  assert.deepEqual(await port.purgeEntry(id,2,'retry'),receipt)
  assert.deepEqual(await port.pendingPurges(),[{...receipt,entry_id:id,expected_revision:2}])
  await assert.rejects(port.completePurgeIndex('personal:other:entry','synthetic-op'))
  await assert.rejects(port.completePurgeIndex(id,''))
  assert.deepEqual(await port.completePurgeIndex(id,'synthetic-op'),{...receipt,index_evidence_ids:[]})
  assert.equal(resource.responseAdaptation().memoryContext?.voice,'')
 }finally{client.memory=memory;await resource.close();await rm(root,{recursive:true,force:true})}
})
