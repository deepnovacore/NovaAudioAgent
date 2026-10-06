import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {MemoryEntry,PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {PreparedMaterial} from '../src/personal-agent/contracts.js'
const material:PreparedMaterial={prepared:{trust:'untrusted_external',text:'Prepared grounded detail',evidence_refs:['file:1']},memory_refs:[],action_label:'继续讨论'}
test('brief host persists processing before preparation, survives restart, and opens grounded unread topic',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-host-')),path=join(dir,'state.json'),store=new PersonalStore(path)
 let calls=0,valid=true
 const state=initialState();state.settings={discovery_enabled:false,discovery_interval_minutes:30,timezone:'Asia/Shanghai',briefing_outlook_enabled:true};await store.write(state)
 const make=()=>new PersonalAgentHost({path,userScope:'local',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>valid?{subject_key:'project:1',source:{type:'file',ref}}:null,evidenceRefs:()=>['file:1'],now:()=>new Date('2026-09-14T00:30:00Z'),prepareBrief:async()=>{calls++;assert.equal(Object.values((await store.read()).brief_runs)[0]?.status,'processing');return material}})
 let host=make()
 try{
 await host.open();await Promise.all([host.scheduledTick(),host.scheduledTick()]);assert.equal(calls,1);assert.equal(host.snapshot().feed.length,1);assert.equal(host.conversationSnapshot().unread_count,1)
 await host.command({type:'personal.command',request_id:'show-brief',method:'conversations.select',params:{id:'chat:proactive'}})
 assert.equal(host.conversationSnapshot().messages[0]?.text,'今日前瞻\n'+material.prepared.text)
 const id=host.snapshot().feed[0]!.id
 await host.command({type:'personal.command',request_id:'open1',method:'conversations.open_feed',params:{feed_id:id}})
 assert.equal((await store.read()).conversations.items.find(c=>c.kind==='topic')?.prepared?.text,material.prepared.text)
 await host.close();host=make();await host.open();await host.scheduledTick();assert.equal(calls,1)
 valid=false
 const result=await host.command({type:'personal.command',request_id:'open2',method:'conversations.open_feed',params:{feed_id:id}})
 assert.equal((result as {ok:boolean}).ok,false)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('proposal preparation is once only and stale evidence cannot publish after model wait',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-prepare-host-'))
 let valid=true,calls=0,release!:(value:PreparedMaterial)=>void,started!:()=>void
 const waiting=new Promise<void>(resolve=>{started=resolve})
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'local',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>valid?{subject_key:'project:1',source:{type:'file',ref}}:null,evidenceRefs:()=>['file:1'],prepareProposal:()=>{calls++;started();return new Promise(resolve=>{release=resolve})}})
 try{await host.open();const snapshot=await host.discoverySnapshot(),proposal={kind:'notify',summary:'A',why_now:'B',evidence_refs:['file:1'],memory_refs:[]}
 const pending=host.admit(proposal,snapshot);await waiting;valid=false;release(material);assert.equal(await pending,'rejected');assert.equal(host.snapshot().feed.length,0)
 valid=true;assert.equal(await host.admit(proposal,snapshot),'suppressed_duplicate');assert.equal(calls,1)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('shutdown fences an uncooperative preparation and restart does not repeat its durable claim',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-abort-')),path=join(dir,'state.json'),store=new PersonalStore(path)
 const state=initialState();state.settings={discovery_enabled:false,discovery_interval_minutes:30,timezone:'Asia/Shanghai',briefing_outlook_enabled:true};await store.write(state)
 let started!:()=>void,calls=0;const waiting=new Promise<void>(resolve=>{started=resolve})
 const make=()=>new PersonalAgentHost({path,userScope:'local',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>({subject_key:'project:1',source:{type:'file',ref}}),evidenceRefs:()=>['file:1'],now:()=>new Date('2026-09-14T00:30:00Z'),prepareBrief:()=>{calls++;started();return new Promise(()=>{/* intentionally ignores signal */})}})
 let host=make()
 try{await host.open();const tick=host.scheduledTick();await waiting;await host.close();await tick;host=make();await host.open();await host.scheduledTick();assert.equal(calls,1);assert.equal(host.snapshot().feed.length,0)}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('task completion preserves its originating topic card and updates one topic result',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-task-topic-'))
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'local',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>({subject_key:'project:1',source:{type:'file',ref}}),evidenceRefs:()=>['file:1']})
 try{await host.open();await host.admit({kind:'notify',summary:'Original matter',why_now:'Needs attention',evidence_refs:['file:1'],memory_refs:[]},await host.discoverySnapshot())
 const original=host.snapshot().feed[0]!
 await host.command({type:'personal.command',request_id:'topic',method:'conversations.open_feed',params:{feed_id:original.id}})
 const topic=host.conversationSnapshot().selected_id;await host.rememberWorkOwner('work-1',topic)
 await host.taskResult('work-1','Completed result');await host.taskResult('work-1','Completed result')
 assert.equal(host.snapshot().feed.length,1);assert.equal(host.snapshot().feed[0]?.id,original.id);assert.equal(host.snapshot().feed[0]?.subject_key,original.subject_key);assert.equal(host.snapshot().feed[0]?.lifecycle,'resolved')
 assert.deepEqual(host.conversationSnapshot().messages.map(m=>m.text),['Completed result'])
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('admitted text failures remain visible and pending admission recovers interrupted',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-generation-status-')),path=join(dir,'state.json'),store=new PersonalStore(path)
 const make=()=>new PersonalAgentHost({path,userScope:'local',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null})
 let host=make()
 try{await host.open();host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.reject(Error('model failed')),close:()=>Promise.resolve()}),()=>{/* no renderer */})
 await host.submitConversationText('chat:main','Question','failure');await host.waitConversation('chat:main');assert.equal(host.conversationSnapshot().messages[0]?.generation_status,'failed')
 await host.submitConversationText('chat:main','Question','failure');assert.equal(host.conversationSnapshot().messages.length,1)
 await host.close();const state=await store.read();state.conversations.items.find(item=>item.id==='chat:main')!.messages.push({id:'pending',conversation_id:'chat:main',role:'user',text:'Unfinished',created_at:new Date().toISOString(),generation_status:'pending',request_id:'admitted'});await store.write(state)
 host=make();await host.open();assert.equal(host.conversationSnapshot().messages[1]?.generation_status,'interrupted');assert.equal((await store.read()).conversations.items[0]?.messages[1]?.generation_status,'interrupted')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('failed brief retries after five minutes and publication survives restart once',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-retry-')),path=join(dir,'state.json'),store=new PersonalStore(path)
 const state=initialState();state.settings={discovery_enabled:false,discovery_interval_minutes:30,timezone:'Asia/Shanghai',briefing_outlook_enabled:true};await store.write(state)
 let calls=0,now=new Date('2026-09-14T00:30:00Z')
 const make=()=>new PersonalAgentHost({path,userScope:'local',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>({subject_key:'project:1',source:{type:'file',ref}}),evidenceRefs:()=>['file:1'],now:()=>now,prepareBrief:()=>{calls++;return calls===1?Promise.reject(Error('offline')):Promise.resolve(material)}})
 let host=make()
 try{
  await host.open();await host.scheduledTick();assert.equal(calls,1);assert.equal(host.snapshot().feed.length,0)
  now=new Date('2026-09-14T00:34:00Z');await host.scheduledTick();assert.equal(calls,1)
  await host.close();host=make();await host.open();now=new Date('2026-09-14T00:35:00Z');await host.scheduledTick();assert.equal(calls,2);assert.equal(host.snapshot().feed.length,1)
  await host.close();host=make();await host.open();now=new Date('2026-09-14T00:41:00Z');await host.scheduledTick();assert.equal(calls,2);assert.equal(host.snapshot().feed.length,1)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})


test('daily snapshot reaches older overdue Todos beyond first page and excludes unauthorized and completed items',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-pages-'))
 const old='2026-08-01T00:00:00Z'
 const todo=(id:string,status:'open'|'done'='open'):MemoryEntry=>({id,version:1,content:id,kind:'todo',origin:'stated',source_refs:[{type:'conversation',ref:'chat:old',observed_at:old}],evidence_refs:[id],observed_at:old,recorded_at:old,topic:'work',status:'active',corrected_to:null,confidence_note:null,life:{id,version:1,status,due:'2026-09-10',goal_id:null,idea_id:null,success_criteria:null}})
 const mentioned=todo('mentioned');mentioned.life!.due=null;mentioned.sources=[{evidence_id:'mentioned',type:'im',observed_at:old,mentioned_me:true}];const future=todo('future');future.life!.due='2026-10-01';future.observed_at='2026-09-14T00:00:00Z'
 const rows=[todo('older'),todo('done','done'),todo('denied'),mentioned,future]
 const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.resolve({source:'personal',state:'empty',scope:'any',hits:[],degraded:false}),list:options=>Promise.resolve(options?.cursor?{entries:rows,cursor:null}:{entries:[],cursor:'older'}),get:id=>Promise.resolve(rows.find(row=>row.id===id)??null),canProcessEvidence:id=>Promise.resolve(id!=='denied'),dailyBriefEvidence:()=>Promise.resolve([{evidence_id:'mention',locator:'im:one',text:'Please check',source_kind:'im',observed_at:old,trust:'untrusted_external'}]),readEvidence:id=>Promise.resolve(id==='mention'?{evidence_id:id,locator:'im:one',text:'Please check',source_kind:'im',observed_at:old,trust:'untrusted_external'}:null)}
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'local',pool:new SuggestionPool(),memory:()=>memory,evidence:()=>null,now:()=>new Date('2026-09-14T00:30:00Z')})
 try{await host.open();const snapshot=await host.dailyBriefSnapshot();assert.deepEqual(snapshot.memory.map(row=>row.id),['older','mentioned']);assert.deepEqual(snapshot.evidence_refs,['mention']);assert.equal(snapshot.daily?.coverage.memory_scanned,5);assert.equal(snapshot.daily?.evidence[0]?.text,'Please check')}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('brief attempts cap at three, empty is terminal, and interrupted processing recovers',async()=>{
 for(const mode of ['failed','empty','processing'] as const){
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-state-')),path=join(dir,'state.json'),store=new PersonalStore(path)
  const state=initialState();state.settings={discovery_enabled:false,discovery_interval_minutes:30,timezone:'Asia/Shanghai',briefing_outlook_enabled:true}
  const key='brief:Asia/Shanghai:2026-09-14:outlook'
  if(mode==='processing')state.brief_runs[key]={status:'processing',attempts:1,last_attempt_at:'2026-09-14T00:25:00.000Z'}
  await store.write(state);let calls=0,now=new Date('2026-09-14T00:30:00Z')
  const host=new PersonalAgentHost({path,userScope:'local',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>({subject_key:'project:1',source:{type:'file',ref}}),evidenceRefs:()=>['file:1'],now:()=>now,prepareBrief:()=>{calls++;return mode==='failed'?Promise.reject(Error('offline')):Promise.resolve(mode==='empty'?null:material)}})
  try{await host.open();for(let attempt=0;attempt<5;attempt++){now=new Date(Date.parse('2026-09-14T00:30:00Z')+attempt*5*60000);await host.scheduledTick()}
   const run=(await store.read()).brief_runs[key]!;assert.equal(calls,mode==='failed'?3:1);assert.equal(run.status,mode==='processing'?'success':mode);assert.equal(host.snapshot().feed.length,mode==='processing'?1:0)
  }finally{await host.close();await rm(dir,{recursive:true,force:true})}
 }
})


test('daily coverage bounds model inputs after full pagination and prioritizes due and direct mentions',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-bounds-')),today='2026-09-14T00:00:00Z'
 const rows:MemoryEntry[]=Array.from({length:132},(_,index)=>({id:'m'+index,version:1,content:'Current note',kind:'todo',origin:'stated',source_refs:[{type:'conversation',ref:'chat:1',observed_at:today}],evidence_refs:['e'+index],observed_at:today,recorded_at:today,topic:'work',status:'active',corrected_to:null,confidence_note:null,life:{id:'l'+index,version:1,status:'open',due:null,goal_id:null,idea_id:null,success_criteria:null}}))
 rows[130]!.life!.due='2026-09-01';rows[131]!.observed_at='2026-08-01T00:00:00Z';rows[131]!.sources=[{evidence_id:'e131',type:'im',observed_at:today,mentioned_me:true}]
 const evidence=Array.from({length:130},(_,index)=>({evidence_id:'raw'+index,locator:'source:'+index,text:'x'.repeat(2500),source_kind:index===129?'im':'calendar',observed_at:today,trust:'untrusted_external' as const}))
 const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.resolve({source:'personal',state:'empty',scope:'any',hits:[],degraded:false}),list:options=>{const offset=Number(options?.cursor??0);return Promise.resolve({entries:rows.slice(offset,offset+100),cursor:offset===0?'100':null})},get:id=>Promise.resolve(rows.find(row=>row.id===id)??null),canProcessEvidence:()=>Promise.resolve(true),dailyBriefEvidence:()=>Promise.resolve(evidence),readEvidence:id=>Promise.resolve(evidence.find(row=>row.evidence_id===id)??null)}
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'local',pool:new SuggestionPool(),memory:()=>memory,evidence:()=>null,now:()=>new Date(today)})
 try{await host.open();const snapshot=await host.dailyBriefSnapshot();assert.equal(snapshot.memory.length,128);assert.deepEqual(snapshot.memory.slice(0,2).map(row=>row.id),['m130','m131']);assert.equal(snapshot.evidence_refs.length,128);assert.equal(snapshot.evidence_refs[0],'raw129');assert.equal(snapshot.daily?.evidence[0]?.text.length,2000);assert.equal(snapshot.daily?.coverage.memory_scanned,132);assert.equal(snapshot.daily?.coverage.memory_truncated,4);assert.equal(snapshot.daily?.coverage.evidence_truncated,2);assert.equal(snapshot.daily?.coverage.evidence_text_truncated,128)}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('revoking raw-source processing while a brief model runs prevents publication',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-revoked-')),path=join(dir,'state.json'),store=new PersonalStore(path)
 const state=initialState();state.settings={discovery_enabled:false,discovery_interval_minutes:30,timezone:'Asia/Shanghai',briefing_outlook_enabled:true};await store.write(state)
 let allowed=true,release!:(value:PreparedMaterial)=>void,started!:()=>void
 const pending=new Promise<void>(resolve=>{started=resolve})
 const evidence={evidence_id:'im-revoked',locator:'im:one',text:'Please review',source_kind:'im',observed_at:'2026-09-14T00:00:00Z',trust:'untrusted_external' as const}
 const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.resolve({source:'personal',state:'empty',scope:'any',hits:[],degraded:false}),list:()=>Promise.resolve({entries:[],cursor:null}),readEvidence:()=>Promise.resolve(evidence),canProcessEvidence:()=>Promise.resolve(allowed),dailyBriefEvidence:()=>Promise.resolve([evidence])}
 const host=new PersonalAgentHost({path,userScope:'local',pool:new SuggestionPool(),memory:()=>memory,evidence:()=>null,now:()=>new Date('2026-09-14T00:30:00Z'),prepareBrief:()=>{started();return new Promise(resolve=>{release=resolve})}})
 try{await host.open();const tick=host.scheduledTick();await pending;allowed=false;release({prepared:{trust:'untrusted_external',text:'Review',evidence_refs:[evidence.evidence_id]},memory_refs:[],action_label:'查看'});await tick;assert.equal(host.snapshot().feed.length,0);assert.equal(Object.values((await store.read()).brief_runs)[0]?.status,'failed')}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
