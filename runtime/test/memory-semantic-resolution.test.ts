import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

const entry=(key:string,text:string,valid_until:string|null=null)=>({key,text,topic:'饮食',kind:'preference',due:null,direction:null,status:null,valid_until})
interface Context {id:string;revision:number;text:string;written_by:string}
interface ResolutionPrompt {candidates:ReturnType<typeof entry>[];existing:Context[]}
const reply=(value:unknown)=>({text:JSON.stringify(value)})
const now=()=>new Date().toISOString()
async function remember(resource:SubstrateMemoryResource,id:string,text:string){await resource.remember({sourceId:id,sessionId:'synthetic',sequence:1,occurredAt:now(),text,confirmed:true});await resource.flush()}

// A key-derived add would create duplicates; missing correction priority would overwrite the correction.
test('semantic decisions keep one spicy preference through paraphrase, temporal update, correction and restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-resolution-chain-'));const path=join(root,'memory.sqlite');let resolves=0
 const gateway:ModelGateway={async *stream(){ /* complete only */ },complete(request){
  const prompt=JSON.parse(request.prompt) as ResolutionPrompt&{source:string}
  if(prompt.candidates){resolves++;const candidate=prompt.candidates[0]!;return Promise.resolve(reply({decisions:[{candidate_index:0,action:candidate.key==='avoid-spice'?'no_change':'update',target_id:prompt.existing[0]!.id}]}))}
  const items:Record<string,ReturnType<typeof entry>>={initial:entry('spicy','我不吃辣'),paraphrase:entry('avoid-spice','辣的菜我都不吃'),temporal:entry('recent-spice','最近可以吃一点辣','2099-10-01T00:00:00Z'),after:entry('changed-key','我很能吃辣')}
  return Promise.resolve(reply({entries:[items[prompt.source]!]}))
 }}
 let client=new MemoryLedgerClient(path),resource=new SubstrateMemoryResource({client,userId:'chain',gateway,model:'fixture',inputConsent:true})
 try{
  await resource.open();await remember(resource,'one','initial');const first=(await resource.list()).entries[0]!
  await remember(resource,'two','paraphrase');assert.equal((await resource.list()).entries.length,1);assert.equal((await resource.get(first.id))?.version,1)
  await remember(resource,'three','temporal');const updated=(await resource.list()).entries[0]!
  assert.equal(updated.id,first.id);assert.equal(updated.content,'最近可以吃一点辣');assert.equal(updated.version,2)
  const stored=(await client.memory('list',{}) as EntryRevision[])[0]!;assert.equal(stored.valid_until,'2099-10-01T00:00:00Z');assert.equal(stored.evidence_refs.length,2);assert.equal(stored.origin,'stated')
  await resource.correct(first.id,2,'医生要求：不吃辣',{type:'conversation',ref:'correction',observed_at:now()})
  await remember(resource,'four','after');assert.equal((await resource.list()).entries.length,1);assert.equal((await resource.get(first.id))?.content,'医生要求：不吃辣')
  await resource.close();client=new MemoryLedgerClient(path);resource=new SubstrateMemoryResource({client,userId:'chain',gateway,model:'fixture',inputConsent:true});await resource.open();await resource.flush()
  assert.equal((await resource.get(first.id))?.content,'医生要求：不吃辣');assert.equal((await resource.get(first.id))?.version,3);assert.equal(resolves,3)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('fabricated semantic target rejects the batch and leaves extraction pending',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-resolution-fabricated-'));let calls=0
 const gateway:ModelGateway={async *stream(){ /* complete only */ },complete(request){const prompt=JSON.parse(request.prompt) as ResolutionPrompt;return Promise.resolve(reply(prompt.candidates?{decisions:[{candidate_index:0,action:'update',target_id:'personal:another-user:invented'}]}:{entries:[entry(++calls===1?'spicy':'avoid-spice','我不吃辣')]}))}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'fabrication',gateway,model:'fixture',inputConsent:true})
 try{await resource.open();await remember(resource,'one','initial');await remember(resource,'two','paraphrase');assert.equal((await resource.list()).entries.length,1);assert.equal((await client.memory('pending_evidence',{source_prefix:resource.prefix,provider:'fixture'}) as unknown[]).length,1)}finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

for(const scenario of ['revoked','stale-update','stale-noop'] as const)test(`semantic ${scenario} while resolver awaits cannot commit or mark extraction complete`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-resolution-race-'));let start!:()=>void,release!:()=>void,calls=0
 const started=new Promise<void>(resolve=>{start=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const gateway:ModelGateway={async *stream(){ /* complete only */ },async complete(request){const prompt=JSON.parse(request.prompt) as ResolutionPrompt
  if(prompt.candidates){start();await gate;return reply({decisions:[{candidate_index:0,action:scenario==='stale-noop'?'no_change':'update',target_id:prompt.existing[0]!.id}]})}
  return reply({entries:[entry(++calls===1?'spicy':'new-spicy','最近可以吃一点辣')]})
 }}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'race',gateway,model:'fixture',inputConsent:true})
 try{
  await resource.open();await remember(resource,'one','initial');const old=(await client.memory('list',{}) as EntryRevision[])[0]!
  await resource.remember({sourceId:'two',sessionId:'synthetic',sequence:2,occurredAt:now(),text:'new',confirmed:true})
  // Bound the wait so the pre-resolution implementation fails instead of hanging.
  const reached=await Promise.race([started.then(()=>true),resource.flush().then(()=>false)]);assert.equal(reached,true,'old context must reach the semantic resolver')
  if(scenario==='revoked')await resource.setProcessingConsent('one',resource.processingGrant(false,2))
  else await client.memory('merge',{entry_id:old.entry_id,expected_revision:old.revision,kind:old.kind,origin:old.origin,written_by:'merge',evidence_refs:old.evidence_refs,content:{...old.content,text:'保留并发的新状态'},recorded_at:now()})
  release();await resource.flush();assert.equal((await resource.list()).entries.length,1);assert.equal((await resource.get(old.entry_id))?.content,scenario==='revoked'?old.content.text:'保留并发的新状态')
  const pending=await client.memory('pending_evidence',{source_prefix:resource.prefix,provider:'fixture'}) as {source_id:string}[];assert.ok(pending.some(row=>row.source_id===resource.prefix+'two'))
 }finally{release?.();await resource.close();await rm(root,{recursive:true,force:true})}
})

test('resolver never sees another user, another kind, or evidence without the actual extraction provider grant',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-resolution-scope-'));const seen:Context[][]=[];let extracted=0
 const gateway:ModelGateway={async *stream(){ /* complete only */ },complete(request){const prompt=JSON.parse(request.prompt) as ResolutionPrompt
  if(prompt.candidates){seen.push(prompt.existing);return Promise.resolve(reply({decisions:[{candidate_index:0,action:'update',target_id:prompt.existing[0]!.id}]}))}
  return Promise.resolve(reply({entries:[entry(++extracted===1?'spicy':'drift','我不吃辣')]}))
 }}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'scope',gateway,model:'fixture',extractionFingerprint:'actual-provider',inputConsent:true})
 try{
  await resource.open();await remember(resource,'one','initial');const old=(await client.memory('list',{}) as EntryRevision[])[0]!
  for(const [id,kind,provider] of [[resource.prefix+'blocked','preference','wrong-provider'],['personal:another:entry','preference','actual-provider'],[resource.prefix+'todo','plan','actual-provider']] as const){
   const evidenceId=id+':e';await client.memory('append_evidence',{id:evidenceId,source_id:id,source_kind:'conversation',locator:id,observed_at:now(),recorded_at:now(),raw_text:'我不吃辣',hash:id,trust:'trusted_user'})
   await client.memory('source_grant',{source_id:id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null}})
   await client.memory('record_extraction',{evidence_id:evidenceId,attempt_id:'fixture',extracted:{}})
   await client.memory('merge',{entry_id:id,kind,origin:'stated',written_by:'merge',evidence_refs:[evidenceId],content:{key:'spicy',text:'我不吃辣',topic:'饮食'},recorded_at:now()})
  }
  await remember(resource,'two','paraphrase');assert.deepEqual(seen.map(rows=>rows.map(row=>row.id)),[[old.entry_id]]);assert.equal((await resource.get(old.entry_id))?.version,2)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

for(const revokeUnselected of [false,true])test(`multiple relevant entries use the selected real ID and fence unselected context (revoke=${revokeUnselected})`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-resolution-multiple-'));let start!:()=>void,release!:()=>void,calls=0;let exposed:Context[]=[]
 const started=new Promise<void>(resolve=>{start=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const gateway:ModelGateway={async *stream(){ /* complete only */ },async complete(request){const prompt=JSON.parse(request.prompt) as ResolutionPrompt
  if(prompt.candidates){exposed=prompt.existing;start();await gate;return reply({decisions:[{candidate_index:0,action:'update',target_id:prompt.existing.find(row=>row.text==='我不吃辣')!.id}]})}
  return reply({entries:[entry(++calls===1?'spicy':'new-spicy',calls===1?'我不吃辣':'我最近可以吃一点辣')]})
 }}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'multiple',gateway,model:'fixture',inputConsent:true})
 try{
  await resource.open();await remember(resource,'one','initial');const old=(await resource.list()).entries[0]!
  const id=resource.prefix+'dessert',evidenceId=id+':e'
  await client.memory('append_evidence',{id:evidenceId,source_id:id,source_kind:'conversation',locator:id,observed_at:now(),recorded_at:now(),raw_text:'饮食习惯是少吃甜点',hash:id,trust:'trusted_user'})
  await client.memory('source_grant',{source_id:id,expected_revision:0,grant:resource.processingGrant(true)})
  await client.memory('record_extraction',{evidence_id:evidenceId,attempt_id:'fixture',extracted:{}})
  await client.memory('merge',{entry_id:id,kind:'preference',origin:'stated',written_by:'merge',evidence_refs:[evidenceId],content:{key:'dessert',text:'少吃甜点',topic:'饮食'},recorded_at:now()})
  await resource.remember({sourceId:'two',sessionId:'synthetic',sequence:2,occurredAt:now(),text:'new',confirmed:true})
  assert.equal(await Promise.race([started.then(()=>true),resource.flush().then(()=>false)]),true)
  assert.deepEqual(new Set(exposed.map(row=>row.id)),new Set([old.id,id]))
  if(revokeUnselected)await resource.setProcessingConsent(id,resource.processingGrant(false,2))
  release();await resource.flush();assert.equal((await resource.list()).entries.length,2)
  assert.equal((await resource.get(old.id))?.content,revokeUnselected?'我不吃辣':'我最近可以吃一点辣');assert.equal((await resource.get(id))?.content,'少吃甜点')
  const pending=await client.memory('pending_evidence',{source_prefix:resource.prefix,provider:'fixture'}) as {source_id:string}[];assert.equal(pending.some(row=>row.source_id===resource.prefix+'two'),revokeUnselected)
 }finally{release?.();await resource.close();await rm(root,{recursive:true,force:true})}
})

test('re-extracting the same evidence with a changed key still resolves the existing entry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-resolution-reextract-'));let extracts=0
 const gateway:ModelGateway={async *stream(){ /* complete only */ },complete(request){const prompt=JSON.parse(request.prompt) as ResolutionPrompt
  return Promise.resolve(reply(prompt.candidates?{decisions:[{candidate_index:0,action:'no_change',target_id:prompt.existing[0]!.id}]}:{entries:[entry(++extracts===1?'spicy':'avoid-chili','我不吃辣')]}))
 }}
 const resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'same-evidence',gateway,model:'fixture',inputConsent:true})
 try{await resource.open();await remember(resource,'one','initial');const first=(await resource.list()).entries[0]!;await resource.reextract(first.id);assert.equal((await resource.list()).entries.length,1);assert.equal((await resource.get(first.id))?.version,1)}finally{await resource.close();await rm(root,{recursive:true,force:true})}
})
