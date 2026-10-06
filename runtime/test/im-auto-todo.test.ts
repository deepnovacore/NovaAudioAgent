import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {LifeService} from '../src/personal-agent/life.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

test('direct actionable IM becomes one sourced durable Todo without external execution; manual changes win',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-auto-im-'))
 const gateway={complete:(request:{system:string;prompt:string})=>{const text=request.system.includes('IM_ACTION')?JSON.stringify({action:{title:'提交材料',note:'请提交材料',due:null,quote:'请提交材料',assigned_to_me:true,requires_action:true,resolved:false}}):request.system.includes('IM_MATCH')?JSON.stringify({decisions:[{candidate_index:0,action:'add',target_id:null}]}):JSON.stringify({entries:[]});return Promise.resolve({text,model:'fixture',usage:{input_tokens:0,output_tokens:0}})}} as unknown as ModelGateway
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(dir,'ledger.sqlite')),userId:'fixture',gateway,model:'fixture',inputConsent:true,consolidation:{enabled:false}})
 const life=new LifeService(join(dir,'life.json'),()=>{/* test observer */},()=>memory.lifeBackend())
 try{
  await memory.open();await life.open()
  const im={sender_id:'ou_sender',account_id:'account',provider:'feishu',source_url:'https://applink.feishu.cn/client/chat/open?messageId=synthetic',message_id:'om_request',chat_id:'oc_test',recipient_id:'ou_me',mention:'direct' as const,auto_capture:true}
  const input={sourceId:'feishu:account:0:oc_test',locator:'feishu://message/om_request',text:'@我 请提交材料',observedAt:new Date().toISOString(),kind:'im' as const,im,processingConsent:memory.processingGrant(true)}
  await memory.ingestEvidence(input);await memory.flush();await life.refresh()
  let todo=life.snapshot().todos[0];assert.ok(todo);assert.equal(todo.title,'提交材料');assert.equal(todo.sources?.[0]?.type,'im');assert.equal(todo.sources?.[0]?.mentioned_me,true);assert.equal(todo.auto_recorded,true);assert.equal(todo.sources?.[0]?.url,im.source_url)
  const entries=(await memory.list()).entries;assert.equal(entries.find(e=>e.kind==='todo')?.origin,'inferred')
  await life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,title:'我改的标题',status:'cancelled'},'user-edit')
  await memory.ingestEvidence(input);await memory.flush();await life.refresh();assert.equal(life.snapshot().todos.length,1);assert.equal(life.snapshot().todos[0]?.status,'cancelled');assert.equal(life.snapshot().todos[0]?.title,'我改的标题')
  await memory.ingestEvidence({...input,locator:'feishu://message/om_other',im:{...im,message_id:'om_other',mention:'none'}});await memory.flush();await life.refresh();assert.equal(life.snapshot().todos.length,1,'a message that does not mention you never creates a Todo')
  await memory.setProcessingConsent(input.sourceId,memory.processingGrant(false,2));await life.refresh();todo=life.snapshot().todos[0]!;assert.deepEqual(todo.sources,[])
 }finally{await life.close();await memory.close();await rm(dir,{recursive:true,force:true})}
})

test('daily calendar selection uses event dates and exclusive ends in the user timezone',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-daily-calendar-'))
 const client=new MemoryLedgerClient(join(dir,'ledger.sqlite'))
 const gateway={complete:()=>Promise.resolve({text:'{"entries":[]}'})} as unknown as ModelGateway
 const memory=new SubstrateMemoryResource({client,userId:'calendar-fixture',gateway,model:'fixture',consolidation:{enabled:false}})
 try{
  await memory.open()
  const cases=[
   {id:'old-update-today-event',start:{dateTime:'2026-10-04T10:00:00+08:00'},end:{dateTime:'2026-10-04T11:00:00+08:00'}},
   {id:'all-day-today',start:{date:'2026-10-04'},end:{date:'2026-10-05'}},
   {id:'all-day-ended',start:{date:'2026-10-03'},end:{date:'2026-10-04'}},
   {id:'midnight-ended',start:'2026-10-03T10:00:00+08:00',end:'2026-10-03T16:00:00Z'},
   {id:'spans-today',start:'2026-10-03T10:00:00+08:00',end:'2026-10-04T01:00:00+08:00'},
   {id:'tomorrow',start:{date:'2026-10-05'},end:{date:'2026-10-06'}},
  ]
  for(const value of cases){
   const source=memory.prefix+value.id
   await client.memory('append_evidence',{id:memory.prefix+'e:'+value.id,source_id:source,source_kind:'calendar',locator:value.id,observed_at:'2026-09-01T00:00:00Z',recorded_at:'2026-09-01T00:00:00Z',raw_text:value.id,hash:value.id,trust:'untrusted_external',extracted:{calendar:{start:value.start,end:value.end}}})
   await client.memory('source_grant',{source_id:source,expected_revision:0,grant:memory.processingGrant(true)})
  }
  const selected=await memory.dailyBriefEvidence({localDate:'2026-10-04',timezone:'Asia/Shanghai'})
  assert.deepEqual(new Set(selected.map(e=>e.locator)),new Set(['old-update-today-event','all-day-today','spans-today']))
 }finally{await memory.close();await rm(dir,{recursive:true,force:true})}
})
