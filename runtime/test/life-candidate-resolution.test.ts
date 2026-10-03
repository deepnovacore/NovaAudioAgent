/* eslint-disable @typescript-eslint/require-await */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {emptyLifeState} from '../src/personal-agent/life.js'
import {validateCandidate,type EvaluatedCandidate} from '../src/understanding/candidates.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

function candidate(text:string,operation:'record'|'update'='record',patch?:Record<string,string|null>):EvaluatedCandidate{
 const source={id:'synthetic:'+text,version:1,origin:'user' as const,text,observed_at:'2026-09-21T15:30:00Z',timezone:'Asia/Shanghai'}
 return {source,candidate:validateCandidate(source,{source_id:source.id,source_version:1,span:{start:0,end:text.length,quote:text},kind:'todo',text:'Japanese first lesson',operation,...(patch?{patch}:{})}),decision:{attribution:'user',modality:'request',support:'supported',importance:'useful',capture:'explicit'},status:'proposed',reasons:[]}
}
const guard=()=>{/* fixture source stays current */}
const signal=()=>new AbortController().signal
async function setup(reply:(request:Parameters<ModelGateway['complete']>[0],client:MemoryLedgerClient)=>Promise<unknown>){
 const root=await mkdtemp(join(tmpdir(),'nova-life-resolution-')),client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const gateway:ModelGateway={async *stream(){/* complete only */},async complete(request){return {text:JSON.stringify(await reply(request,client))}}}
 const resource=new SubstrateMemoryResource({client,userId:'life-resolution',gateway,model:'fixture-model',extractionFingerprint:'authorized-extractor',inputConsent:true})
 await resource.open();const backend=resource.lifeBackend();await backend.load(emptyLifeState())
 return {client,resource,backend,async close(){await resource.close();await rm(root,{recursive:true,force:true})}}
}
function prompt(request:Parameters<ModelGateway['complete']>[0]){return JSON.parse(request.prompt) as {candidates:{operation?:string;patch?:Record<string,string>}[];existing:{id:string;life_data:{title:string;status:string}}[]}}

test('cross-turn identity preserves paraphrases, applies status/date patches and rejects unmatched explicit updates',async()=>{
 let mode:'update'|'no_change'='update'
 const fixture=await setup(async request=>{const p=prompt(request);return {decisions:[{candidate_index:0,action:mode,target_id:p.existing[0]!.id}]}})
 try{
  const {resource,backend}=fixture
  const commit=async(row:EvaluatedCandidate,id:string)=>{const plan=await resource.resolveLifeCandidate(row,signal(),guard);if(plan.input===null)return null;const snapshot=(await backend.peek!())!;return backend.mutate({input:plan.input,requestId:id,expectedRevision:snapshot.revision,provenance:{type:'explicit_candidate',row,resolution:plan.resolution}})}
  const first=await commit(candidate('Please record Japanese first lesson.'),'create')
  assert.equal(first!.state.todos.length,1)
  mode='no_change';assert.equal(await commit(candidate('Please also note my Japanese first lesson.'),'repeat'),null)
  assert.equal((await backend.peek!())!.state.todos[0]!.version,1)
  mode='update';const rescheduled=await commit(candidate('Reschedule Japanese first lesson to tomorrow.','update',{due:'2026-09-22'}),'reschedule')
  assert.equal(rescheduled!.state.todos[0]!.due,'2026-09-22');assert.equal(rescheduled!.state.todos[0]!.title,'Japanese first lesson');assert.equal(rescheduled!.state.todos[0]!.note,'')
  const completed=await commit(candidate('Mark Japanese first lesson completed.','update',{status:'done'}),'complete')
  assert.equal(completed!.state.todos[0]!.status,'done');assert.equal(completed!.state.todos[0]!.version,3)
  const cancelled=await commit(candidate('Cancel Japanese first lesson.','update',{status:'cancelled'}),'cancel')
  assert.equal(cancelled!.state.todos[0]!.status,'cancelled');assert.equal(cancelled!.state.todos.length,1)
  mode='no_change';assert.equal(await commit(candidate('Japanese first lesson is cancelled.','update',{status:'cancelled'}),'cancel-repeat'),null)
  const missing=candidate('Reschedule unrelated swimming.','update',{due:'2026-09-23'}),{id,...raw}=missing.candidate;assert.ok(id)
  missing.candidate=validateCandidate(missing.source,{...raw,text:'unrelated swimming'})
  await assert.rejects(resource.resolveLifeCandidate(missing,signal(),guard),/candidate_update_no_match/)
 }finally{await fixture.close()}
})

for(const action of ['add','no_change','update'] as const)test(`all old contexts are fenced for ${action}, including a revocation after resolution`,async()=>{
 const fixture=await setup(async request=>{const p=prompt(request);return {decisions:[{candidate_index:0,action,target_id:action==='add'?null:p.existing[0]!.id}]}})
 try{
  const {resource,backend,client}=fixture
  let snapshot=(await backend.peek!())!
  await backend.mutate({input:{op:'create',kind:'todo',title:'Japanese first lesson'},requestId:'old',expectedRevision:snapshot.revision})
  snapshot=(await backend.peek!())!
  await backend.mutate({input:{op:'create',kind:'todo',title:'Japanese first lesson alternative'},requestId:'unselected',expectedRevision:snapshot.revision})
  const row=action==='update'?candidate('Reschedule Japanese first lesson.','update',{due:'2026-09-23'}):candidate('Please record Japanese first lesson.')
  const plan=await resource.resolveLifeCandidate(row,signal(),guard)
  assert.equal(plan.resolution.contexts.length,2)
  const entry=(await client.memory('list',{}) as EntryRevision[]).find(r=>r.kind==='todo'&&r.entry_id!==plan.resolution.decision.target_id)!
  const evidence=await client.memory('evidence',{id:entry.evidence_refs[0]}) as {source_id:string}
  await client.memory('source_grant',{source_id:evidence.source_id,expected_revision:1,grant:resource.processingGrant(false,2)})
  snapshot=(await backend.peek!())!
  if(plan.input!==null)await assert.rejects(backend.mutate({input:plan.input,requestId:'late',expectedRevision:snapshot.revision,provenance:{type:'explicit_candidate',row,resolution:plan.resolution}}),/version_conflict/)
  else await assert.rejects(client.memory('life_load',{namespace:resource.prefix+'life:',resolution:plan.resolution}))
  assert.equal((await backend.peek!())!.state.todos.length,2);assert.ok((await backend.peek!())!.state.todos.every(todo=>todo.version===1))
 }finally{await fixture.close()}
})

test('resolver rejects a stale current-source guard after model await and never exposes unauthorized old objects',async()=>{
 let current=true,calls=0
 const fixture=await setup(async request=>{calls++;const p=prompt(request);assert.equal(p.existing.length,1);current=false;return {decisions:[{candidate_index:0,action:'no_change',target_id:p.existing[0]!.id}]}})
 try{
  const {resource,backend,client}=fixture;let snapshot=(await backend.peek!())!
  await backend.mutate({input:{op:'create',kind:'todo',title:'Japanese first lesson'},requestId:'old',expectedRevision:snapshot.revision})
  snapshot=(await backend.peek!())!
  await backend.mutate({input:{op:'create',kind:'todo',title:'Japanese first lesson private'},requestId:'private',expectedRevision:snapshot.revision})
  const entry=(await client.memory('list',{}) as EntryRevision[]).find(r=>r.content.text==='Japanese first lesson private')!
  const evidence=await client.memory('evidence',{id:entry.evidence_refs[0]}) as {source_id:string}
  await client.memory('source_grant',{source_id:evidence.source_id,expected_revision:1,grant:resource.processingGrant(false,2)})
  await assert.rejects(resource.resolveLifeCandidate(candidate('Please record Japanese first lesson.'),signal(),()=>{if(!current)throw Error('candidate_stale_source')}),/candidate_stale_source/)
  assert.equal(calls,1);assert.equal((await backend.peek!())!.state.todos.length,2)
 }finally{await fixture.close()}
})
