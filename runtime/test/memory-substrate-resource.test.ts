import {KnowledgeService} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,stat,writeFile,symlink,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import {connectorSourceId,type SourceConnection,type SourceChange} from '../src/memory-substrate/source-state.js'
import {EvidenceRecordSchema} from '../src/memory-substrate/store.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

test('legacy file fact cannot enter chat context or block a new stated memory with the same key',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-memory-boundary-'))
 const item={key:'plan',text:'我在写项目报告',topic:'工作',kind:'fact',due:null,direction:null,status:null,valid_until:null}
 const gateway:ModelGateway={async *stream(){/* unused */},complete(){return Promise.resolve({text:JSON.stringify({entries:[item]})})}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'boundary',gateway,model:'fixture',inputConsent:true,conversationProviders:['consumer']})
 try{
  await resource.open()
  const now=new Date().toISOString(),sourceId=resource.prefix+'old-file',evidenceId=resource.prefix+'e:old-file'
  await client.memory('append_evidence',{id:evidenceId,source_id:sourceId,source_kind:'file',locator:'old-example',observed_at:now,recorded_at:now,raw_text:'小红的项目报告',hash:createHash('sha256').update('old-example').digest('hex'),trust:'untrusted_external'})
  await client.memory('source_grant',{source_id:sourceId,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:'fixture',embedding_provider:null,conversation_providers:['consumer']}})
  const oldId=resource.prefix+createHash('sha256').update('fact:plan').digest('hex')
  await client.memory('merge',{entry_id:oldId,kind:'fact',origin:'inferred',written_by:'merge',evidence_refs:[evidenceId],content:{text:'小红的项目报告'},recorded_at:now})
  assert.equal((await resource.list()).entries.length,0)
  assert.equal((await resource.get(oldId)),null)
  assert.ok(!JSON.stringify(await resource.prepareResponseAdaptation('consumer')).includes('小红'))
  await resource.remember({sourceId:'fresh',sessionId:'s',sequence:1,occurredAt:now,text:'我在写项目报告',confirmed:true})
  await resource.flush()
  const entries=(await resource.list()).entries
  assert.equal(entries.length,1);assert.equal(entries[0]?.content,'我在写项目报告');assert.notEqual(entries[0]?.id,oldId)
  assert.equal((await client.memory('list',{}) as EntryRevision[]).filter(row=>row.entry_id===oldId).length,1,'legacy revision remains available for review')
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('delayed extraction cannot replace a revision written while the model was running',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-extraction-race-'))
 let started!:()=>void,release!:()=>void,calls=0
 const waiting=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const gateway:ModelGateway={async *stream(){ /* extraction uses complete */ },async complete(){
  if(++calls===2){started();await gate}
  return {text:JSON.stringify({entries:[{key:'spicy',text:calls===1?'我不吃辣':'最近可以吃一点',topic:'饮食',kind:'preference',due:null,direction:null,status:null,valid_until:null}]})}
 }}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'race',gateway,model:'fixture',inputConsent:true})
 try{
  await resource.open();await resource.remember({sourceId:'first',sessionId:'session',sequence:1,occurredAt:new Date().toISOString(),text:'我不吃辣'});await resource.flush()
  const first=(await resource.list()).entries[0]!
  await resource.remember({sourceId:'second',sessionId:'session',sequence:2,occurredAt:new Date().toISOString(),text:'最近可以吃一点'});await waiting
  const old=(await client.memory('list',{}) as EntryRevision[]).find(row=>row.entry_id===first.id)!
  await client.memory('merge',{entry_id:old.entry_id,expected_revision:old.revision,kind:old.kind,origin:old.origin,written_by:'merge',evidence_refs:old.evidence_refs,content:{...old.content,text:'最新状态：仍然不吃辣'},recorded_at:new Date().toISOString()})
  release();await resource.flush()
  assert.equal((await resource.get(first.id))?.content,'最新状态：仍然不吃辣')
  assert.equal((await resource.get(first.id))?.version,2)
  assert.equal((await client.memory('pending_evidence',{source_prefix:resource.prefix,provider:'fixture'}) as unknown[]).length,1,'conflict leaves evidence retryable')
 }finally{release?.();await resource.close();await rm(root,{recursive:true,force:true})}
})

test('duplicate extraction targets reject the whole batch without a completion receipt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-extraction-duplicates-'))
 const entry={key:'spicy',text:'我不吃辣',topic:'饮食',kind:'preference',due:null,direction:null,status:null,valid_until:null}
 const gateway:ModelGateway={async *stream(){ /* extraction uses complete */ },complete(){return Promise.resolve({text:JSON.stringify({entries:[entry,{...entry,text:'我喜欢吃辣'}]})})}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'duplicate',gateway,model:'fixture',inputConsent:true})
 try{
  await resource.open();await resource.remember({sourceId:'first',sessionId:'session',sequence:1,occurredAt:new Date().toISOString(),text:'我不吃辣'});await resource.flush()
  assert.equal((await resource.list()).entries.length,0)
  assert.equal((await client.memory('pending_evidence',{source_prefix:resource.prefix,provider:'fixture'}) as unknown[]).length,1)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('a forgotten target stays forgotten without blocking other candidates in a new batch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-extraction-forgotten-'));let calls=0
 const entry={key:'spicy',text:'我不吃辣',topic:'饮食',kind:'preference',due:null,direction:null,status:null,valid_until:null}
 const gateway:ModelGateway={async *stream(){ /* extraction uses complete */ },complete(){return Promise.resolve({text:JSON.stringify({entries:++calls===1?[entry]:[entry,{...entry,key:'travel',text:'我喜欢海边旅行',topic:'旅行'}]})})}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'forget',gateway,model:'fixture',inputConsent:true})
 try{
  await resource.open();await resource.remember({sourceId:'first',sessionId:'session',sequence:1,occurredAt:new Date().toISOString(),text:'我不吃辣'});await resource.flush()
  const first=(await resource.list()).entries[0]!
  await resource.forgetEntry(first.id,first.version)
  await resource.remember({sourceId:'second',sessionId:'session',sequence:2,occurredAt:new Date().toISOString(),text:'我不吃辣，我喜欢海边旅行'});await resource.flush()
  assert.deepEqual((await resource.list()).entries.map(row=>row.content),['我喜欢海边旅行'])
  assert.equal((await resource.get(first.id))?.status,'forgotten')
  assert.equal((await client.memory('pending_evidence',{source_prefix:resource.prefix,provider:'fixture'}) as unknown[]).length,0)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('external ingestion without processing consent stays local even with conversation consent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-no-processing-'));let calls=0
 const gateway:ModelGateway={async *stream(){ /* extraction uses complete */ },complete(){calls++;return Promise.resolve({text:'{"entries":[]}'})}}
 const resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'test',gateway,model:'fixture',inputConsent:true})
 try{
  await resource.open();await resource.ingestEvidence({sourceId:'old-im',locator:'one',text:'周五交报告',observedAt:new Date().toISOString(),kind:'im',embeddingConsent:true})
  await resource.flush();assert.equal(calls,0)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('revocation survives late admission and provider changes require fresh processing consent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-revoke-processing-'));const path=join(root,'memory.sqlite');let calls=0
 const gateway:ModelGateway={async *stream(){ /* extraction uses complete */ },complete(){calls++;return Promise.resolve({text:'{"entries":[]}'})}}
 let resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId:'test',gateway,model:'fixture',extractionFingerprint:'provider-a'})
 try{
  await resource.open();const grant=resource.processingGrant(true)
  const input={sourceId:'im',locator:'one',text:'第一条',observedAt:new Date().toISOString(),kind:'im' as const,processingConsent:grant}
  await resource.ingestEvidence(input);await resource.flush();assert.equal(calls,1)
  await resource.setProcessingConsent('im',resource.processingGrant(false,2))
  await resource.ingestEvidence({...input,locator:'two',text:'撤销后的条目'});await resource.flush();assert.equal(calls,1)
  await resource.close();resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId:'test',gateway,model:'fixture',extractionFingerprint:'provider-b'})
  await resource.open();await resource.ingestEvidence({...input,locator:'three',text:'新服务商'});await resource.flush();assert.equal(calls,1)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('model reply after consent revocation never commits partial candidates or a completion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-late-processing-'));let begin!:()=>void,finish!:(r:{text:string})=>void
 const started=new Promise<void>(r=>{begin=r}),response=new Promise<{text:string}>(r=>{finish=r})
 const gateway:ModelGateway={async *stream(){ /* extraction uses complete */ },complete(){begin();return response}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'test',gateway,model:'fixture'})
 try{
  await resource.open();await resource.ingestEvidence({sourceId:'im',locator:'one',text:'给你报告',observedAt:new Date().toISOString(),kind:'im',processingConsent:resource.processingGrant(true)})
  await started;await resource.setProcessingConsent('im',resource.processingGrant(false,2))
  finish({text:'{"entries":[{"key":"late","text":"旧结果","topic":"计划","kind":"fact","due":null,"direction":null,"status":null,"valid_until":null}]}'})
  await resource.flush();assert.equal((await resource.list()).entries.length,0)
  const pending=await client.memory('pending_evidence',{source_prefix:resource.prefix}) as unknown[];assert.equal(pending.length,1)
 }finally{finish?.({text:'{"entries":[]}'});await resource.close();await rm(root,{recursive:true,force:true})}
})

test('two hundred connector objects emit one invalidation and one ready notification',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-batch-events-'));let calls=0,begin!:()=>void,release!:()=>void
 const started=new Promise<void>(r=>{begin=r}),gate=new Promise<void>(r=>{release=r})
 const gateway:ModelGateway={async *stream(){ /* extraction uses complete */ },async complete(){calls++;begin();await gate;return {text:'{"entries":[]}'}}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'batch',gateway,model:'fixture'})
 const events:SourceChange[]=[]
 try{
  await resource.open();resource.setOnSourceChange(e=>{events.push(e);return Promise.resolve()})
  const id=resource.prefix+'connection';await client.memory('source_connection',{action:'create',id,namespace:id})
  const c=await client.memory('source_connection',{action:'fence',id,state:'connected',expected_epoch:0}) as SourceConnection
  const changes=[]
  for(let n=0;n<200;n++){
   const key='object-'+n,source_id=connectorSourceId(id,0,key)
   await resource.setProcessingConsent(source_id,resource.processingGrant(true))
   changes.push({object_key:key,source_id,semantic_hash:key,metadata:{},status:'current' as const,evidence:[EvidenceRecordSchema.parse({id:resource.prefix+'e:'+key,source_id,source_kind:'mail',locator:key,observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),raw_text:key,hash:key,trust:'untrusted_external'})]})
  }
  await resource.applySourcePage({fence:c.fence,batch_id:'1',page_id:'1',changes,pending_ids:[],continuation:null,checkpoint:null,complete:true})
  await started;assert.deepEqual(events.map(e=>e.phase),['invalidated'])
  release();await resource.flush();assert.equal(calls,200)
  assert.deepEqual(events.map(e=>e.phase),['invalidated','ready'])
 }finally{release?.();await resource.close();await rm(root,{recursive:true,force:true})}
})

test('substrate resource keeps identity, correction, restart and source deletion on worker',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-substrate-'));const path=join(root,'memory.sqlite')
 let calls=0
 const gateway:ModelGateway={async *stream(){ /* unused by extraction */ },complete(){calls++;return Promise.resolve({text:JSON.stringify({entries:[{key:'weekly-report',text:'周五交报告',topic:'报告',kind:'commitment',due:'2026-09-18T10:00:00Z',direction:'owed_by_me',status:'open',valid_until:null}]})})}}
 let resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId:'test',gateway,model:'test'})
 try{
  await resource.open()
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'chat:one',locator:'message:one',text:'我周五给你报告',observedAt:'2026-09-12T10:00:00Z',kind:'im',senderId:'sender',accountId:'account'})
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'chat:one',locator:'message:one',text:'我周五给你报告',observedAt:'2026-09-12T10:00:00Z',kind:'im',senderId:'sender',accountId:'account'})
  await resource.flush()
  assert.equal(calls,1,'completed evidence does not repeat extraction')
  const first=(await resource.list()).entries[0]!;assert.equal(first.kind,'commitment');assert.equal(first.commitment?.status,'open');assert.equal(first.origin,'inferred');assert.equal(first.version,1)
  assert.ok(first.commitment?.counterparty?.startsWith(resource.prefix+'person:'))
  assert.equal(first.evidence_refs?.length,1)
  assert.equal((await resource.readEvidence(first.evidence_refs[0]!))?.locator,'message:one')
  assert.ok(first.source_refs.length,'legacy source references remain available')
  await resource.reextract(first.id);assert.equal(calls,2);assert.equal((await resource.get(first.id))?.version,1,'equivalent re-extraction does not append revisions')
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'expired',locator:'expired',text:'旧消息',observedAt:'2020-01-01T00:00:00Z',kind:'im',retentionUntil:'2020-02-01T00:00:00Z'});await resource.flush();assert.equal(calls,2,'expired raw text never reaches the model')
  const corrected=await resource.correct(first.id,first.version,'改到下周一交报告',{type:'conversation',ref:'correction:one',observed_at:'2026-09-12T11:00:00Z'})
  assert.equal(corrected.entry.commitment?.due,null,'free-text correction must not retain a stale parsed deadline')
  assert.equal(corrected.entry.id,first.id);assert.equal(corrected.entry.version,2);assert.equal(corrected.entry.origin,'stated')
  await assert.rejects(resource.correct(first.id,1,'旧修改',{type:'conversation',ref:'correction:stale',observed_at:'2026-09-12T11:00:00Z'}),/CONFLICT/)
  await resource.forgetSource('chat:one');assert.equal((await resource.list()).entries[0]?.content,'改到下周一交报告')
  await resource.close();resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId:'test',gateway,model:'test'});await resource.open()
  await resource.flush();assert.equal(calls,2,'correction evidence is never extracted after restart')
  assert.equal((await resource.get(first.id))?.version,2)
  await resource.forgetEntry(first.id,2);assert.equal((await resource.list()).entries.length,0)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})


test('shared worker creates a private database and rejects symlink targets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-private-memory-'));const path=join(root,'new','memory.sqlite')
 const client=new MemoryLedgerClient(path)
 try {
  await client.open();await client.open()
  if(process.platform!=='win32'){assert.equal((await stat(path)).mode&0o777,0o600);assert.equal((await stat(join(root,'new'))).mode&0o777,0o700)}
  await client.close()
  const target=join(root,'other.sqlite');await writeFile(target,'',{mode:0o644});const linked=join(root,'linked.sqlite');await symlink(target,linked)
  const rejected=new MemoryLedgerClient(linked)
  try{await assert.rejects(rejected.open());if(process.platform!=='win32')assert.equal((await stat(target)).mode&0o777,0o644)}finally{await rejected.close()}
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('batch source forget deduplicates refs and refreshes once after all deletes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-forget-batch-'))
 const client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'batch-forget',gateway:{async *stream(){await Promise.resolve();yield* []},complete(){return Promise.resolve({text:'{"entries":[]}'})}},model:'fixture'})
 const calls:{operation:string;input:unknown}[]=[];const original=client.memory.bind(client);let rejectSecond=true
 client.memory=async(operation,input)=>{calls.push({operation,input});if(operation==='delete_source'&&rejectSecond&&String((input as {source_id:string}).source_id).endsWith('second'))throw Error('transient_delete_failure');return original(operation,input)}
 try{
  await resource.open();calls.length=0
  await assert.rejects(resource.forgetSources(['first','second','first']),/transient_delete_failure/)
  assert.deepEqual(calls.filter(call=>call.operation==='delete_source').map(call=>String((call.input as {source_id:string}).source_id).split(':').at(-1)),['first','second'])
  assert.equal(calls.filter(call=>call.operation==='list').length,1,'a partial failure refreshes the successfully deleted sources')
  rejectSecond=false;calls.length=0
  await resource.forgetSources(['first','second','first'])
  assert.deepEqual(calls.filter(call=>call.operation==='delete_source').map(call=>String((call.input as {source_id:string}).source_id).split(':').at(-1)),['first','second'])
  assert.equal(calls.filter(call=>call.operation==='list').length,1,'successful batch refreshes the snapshot once')
  calls.length=0;await resource.forgetSources([]);assert.equal(calls.length,0)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('connector admission resolves while model extraction is still pending',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-admit-'))
 let start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve})
 let finish!:(value:{text:string})=>void;const response=new Promise<{text:string}>(resolve=>{finish=resolve})
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(){start();return response}}
 const resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'test',gateway,model:'test'})
 try {
  await resource.open();let admitted=false
  const admission=resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'chat',locator:'one',text:'待提取消息',observedAt:new Date().toISOString(),kind:'im'}).then(()=>{admitted=true})
  await started;assert.equal(admitted,true,'sync cursor must not wait for model completion')
  finish({text:'{"entries":[]}'});await admission;await resource.flush()
 }finally{finish({text:'{"entries":[]}'});await resource.close();await rm(root,{recursive:true,force:true})}
})

test('semantic memory retrieval finds paraphrases and hydrates only current evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-semantic-'));const client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 let release!:(vectors:Float32Array[])=>void;let markStarted!:()=>void
 const started=new Promise<void>(resolve=>{markStarted=resolve})
 const embedding={id:'fixture',dims:2,embed(texts:readonly string[]){if(texts[0]==='延迟查询'){markStarted();return new Promise<Float32Array[]>(resolve=>{release=resolve})}return Promise.resolve(texts.map(text=>new Float32Array(text.includes('旅行')||text.includes('假期')?[1,0]:[0,1])))}}
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(request){const {source,candidates}=JSON.parse(request.prompt) as {source:string;candidates?:unknown[]};return Promise.resolve({text:JSON.stringify(candidates?{decisions:candidates.map((_,candidate_index)=>({candidate_index,action:'add',target_id:null}))}:{entries:[{key:source,text:source,topic:'生活',kind:'fact',due:null,direction:null,status:null,valid_until:null}]})})}}
 const resource=new SubstrateMemoryResource({client,userId:'semantic',gateway,model:'fixture',embedding,embeddingFingerprint:'endpoint-a:fixture:2'})
 try {
  await resource.open()
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'trip',locator:'trip',observedAt:new Date().toISOString(),text:'喜欢去海边旅行',kind:'im',embeddingConsent:true})
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'food',locator:'food',observedAt:new Date().toISOString(),text:'吃饭不放辣椒',kind:'im',embeddingConsent:true})
  await resource.flush()
  assert.equal((await resource.list()).entries.length,2,'both unrelated memories survive valid resolver add decisions')
  const answer=await resource.recall('假期安排',{limit:1});assert.equal(answer.degraded,false);assert.equal(answer.hits[0]?.text,'喜欢去海边旅行')
  const hit=answer.hits[0]
  assert.equal((await resource.evidenceFor(hit.memoryId,hit.revision))[0]?.text,'喜欢去海边旅行')
  assert.deepEqual(await resource.evidenceFor(hit.memoryId,999),[])
  const mismatched=await client.memory('search',{entry_prefix:resource.prefix,provider:'endpoint-b:fixture:2',query:'假期安排',vector:[1,0],scope:'any',limit:1}) as {hits:unknown[];degraded:boolean}
  assert.equal(mismatched.hits.length,0);assert.equal(mismatched.degraded,true,'different provider fingerprints never mix vectors')
  const pending=resource.recall('延迟查询');await started
  await resource.forgetSource('trip');release([new Float32Array([1,0])])
  assert.ok(!(await pending).hits.some(row=>row.memoryId===hit.memoryId),'deletion during provider work cannot return a stale hit')
  assert.deepEqual(await resource.evidenceFor(hit.memoryId,hit.revision),[])
 }finally{release?.([new Float32Array([1,0])]);await resource.close();await rm(root,{recursive:true,force:true})}
})

test('missing embeddings report lexical degradation explicitly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-lexical-'))
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(){return Promise.resolve({text:'{"entries":[]}'})}}
 const resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'lexical',gateway,model:'fixture'})
 try{await resource.open();assert.equal((await resource.recall('旅行')).degraded,true)}finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('A backs document originals and denies automatic embedding without consent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-consent-'));let embeddings=0;let extractions=0
 const embedding={id:'consent',dims:2,embed(texts:readonly string[]){embeddings+=texts.length;return Promise.resolve(texts.map(()=>new Float32Array([1,0])))}}
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(){extractions++;return Promise.resolve({text:'{"entries":[{"key":"private","text":"本地笔记","topic":"生活","kind":"fact","due":null,"direction":null,"status":null,"valid_until":null}]}'})}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite'));const resource=new SubstrateMemoryResource({client,userId:'consent',gateway,model:'fixture',embedding})
 try{
  await resource.open();await resource.observeSource({source_ref:{type:'file',ref:'local',observed_at:new Date().toISOString()},content:'本地笔记'});await resource.flush()
  assert.equal(embeddings,0,'merge alone does not authorize uploading a derived entry')
  const count=extractions
  const record=await resource.recordEvidence({sourceId:'knowledge:one',locator:'document#chunk:1',text:'原始文档内容',observedAt:new Date().toISOString(),kind:'file',embeddingConsent:true})
  assert.ok(record.evidence_id.startsWith(resource.prefix+'e:'));assert.equal((await resource.readEvidence(record.evidence_id))?.text,'原始文档内容')
  const pending=await client.memory('pending_evidence',{source_prefix:resource.prefix}) as {id:string}[];assert.ok(!pending.some(row=>row.id===record.evidence_id));assert.equal(extractions,0,'unconsented local observation waits without extraction')
  await resource.flush();assert.equal(extractions,count,'document index owns extraction rather than maintenance')
  assert.equal(await resource.readEvidence('someone-else:e:1'),null)
  await resource.forgetSource('knowledge:one');assert.equal(await resource.readEvidence(record.evidence_id),null)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('indexed files remain in knowledge without creating personal facts',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-canonical-directory-'))
 let calls=0
 const gateway:ModelGateway={async *stream(){ /* extraction is non-streaming */ },complete(){calls++;return Promise.resolve({text:JSON.stringify({entries:[{key:'plan',text:calls<3?'旧计划':'新计划',topic:'计划',kind:'fact',due:null,direction:null,status:null,valid_until:null}]})})}}
 const client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'directory',gateway,model:'fixture'})
 const knowledge=new KnowledgeService({store:new KnowledgeStoreClient({path:join(root,'index','knowledge.sqlite')}),embedding:{id:'fixture',dims:2,embed:texts=>Promise.resolve(texts.map(()=>new Float32Array([1,0])))}})
 try{
  await resource.open();await knowledge.open();await knowledge.bindEvidenceLedger({processingGrant:(...args)=>resource.processingGrant(...args),canProcess:(...args)=>resource.canProcessEvidence(...args),record:input=>resource.recordEvidence(input),read:id=>resource.readEvidence(id),remove:id=>resource.forgetSource(id)})
  const path=join(root,'README.md');await writeFile(path,'旧计划')
  const first=await knowledge.syncFile(path,root,new AbortController().signal,undefined,resource.processingGrant(true))
  assert.equal(first.evidence_ids?.length,1)
  const observation={source_ref:{type:'file' as const,ref:'knowledge:'+first.id,observed_at:new Date().toISOString()},content:'should never replace canonical original',evidence_ids:first.evidence_ids}
  await resource.observeSource(observation)
  assert.equal((await resource.list()).entries.length,0)
  assert.equal((await resource.readEvidence(first.evidence_ids[0]!))?.text,'旧计划')
  await writeFile(path,'新计划')
  const next=await knowledge.syncFile(path,root,new AbortController().signal,first.id,resource.processingGrant(true))
  assert.notEqual(next.id,first.id)
  assert.equal(await resource.readEvidence(first.evidence_ids[0]!),null)
  assert.equal((await resource.list()).entries.length,0)
  await resource.observeSource({...observation,source_ref:{...observation.source_ref,ref:'knowledge:'+next.id},evidence_ids:next.evidence_ids!})
  assert.equal((await resource.list()).entries.length,0)
  assert.equal((await resource.readEvidence(next.evidence_ids![0]!))?.text,'新计划')
  assert.equal(calls,0,'file content never enters personal extraction')
 }finally{await knowledge.close();await resource.close();await rm(root,{recursive:true,force:true})}
})

test('a multi-chunk document lands in one batch with markers, in order, under a single source grant',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-evidence-batch-'))
 const client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const embedding={id:'fixture',dims:2,embed:(texts:readonly string[])=>Promise.resolve(texts.map(()=>new Float32Array([1,0])))}
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(){throw new Error('file content never enters extraction')}}
 const resource=new SubstrateMemoryResource({client,userId:'batch',gateway,model:'fixture',embedding})
 const store=new KnowledgeStoreClient({path:join(root,'index','knowledge.sqlite')}),knowledge=new KnowledgeService({store,embedding})
 const ops:string[]=[],memory=client.memory.bind(client)
 client.memory=((operation:string,value:unknown)=>{ops.push(operation);return memory(operation as never,value)})
 try{
  await resource.open();await knowledge.open()
  await knowledge.bindEvidenceLedger({processingGrant:(...args)=>resource.processingGrant(...args),canProcess:(...args)=>resource.canProcessEvidence(...args),record:input=>resource.recordEvidence(input),recordBatch:inputs=>resource.recordEvidenceBatch(inputs),read:id=>resource.readEvidence(id),remove:id=>resource.forgetSource(id)})
  const path=join(root,'long.md');await writeFile(path,['甲','乙','丙'].map(mark=>`# ${mark}\n\n${mark}的段落`).join('\n\n'))
  ops.length=0
  const synced=await knowledge.syncFile(path,root,new AbortController().signal,undefined,resource.processingGrant(true))
  const ids=(await store.listChunks(synced.id,0)).map(chunk=>chunk.evidence_id!);assert.equal(ids.length,3)
  assert.equal(ops.filter(op=>op==='record_evidence_batch').length,1);assert.equal(ops.filter(op=>op==='append_evidence'||op==='record_extraction').length,0)
  assert.equal(ops.filter(op=>op==='source_grant').length,2,'one read and one write for the whole document')
  const texts=await Promise.all(ids.map(async id=>(await resource.readEvidence(id))?.text))
  assert.deepEqual(texts.map(text=>text?.match(/[甲乙丙]/u)?.[0]),['甲','乙','丙'])
  const pending=await client.memory('pending_evidence',{source_prefix:resource.prefix}) as {id:string}[]
  assert.ok(!pending.some(row=>ids.includes(row.id)),'every chunk carries its extraction marker')
  for(const id of ids)assert.equal(await resource.canProcessEvidence(id,'embedding'),true)
 }finally{await knowledge.close();await resource.close();await rm(root,{recursive:true,force:true})}
})
