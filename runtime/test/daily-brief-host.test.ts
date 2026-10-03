import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {PreparedMaterial} from '../src/personal-agent/contracts.js'
const material:PreparedMaterial={prepared:{trust:'untrusted_external',text:'Prepared grounded detail',evidence_refs:['file:1']},memory_refs:[],action_label:'继续讨论'}
test('brief host persists claim before preparation, survives restart, and opens grounded unread topic',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-host-')),path=join(dir,'state.json'),store=new PersonalStore(path)
 let calls=0,valid=true
 const state=initialState();state.settings={discovery_enabled:false,discovery_interval_minutes:30,timezone:'Asia/Shanghai',briefing_outlook_enabled:true};await store.write(state)
 const make=()=>new PersonalAgentHost({path,userScope:'local',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>valid?{subject_key:'project:1',source:{type:'file',ref}}:null,evidenceRefs:()=>['file:1'],now:()=>new Date('2026-09-14T00:30:00Z'),prepareBrief:async()=>{calls++;assert((await store.read()).dedupe.some(k=>k.startsWith('brief:')));return material}})
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
