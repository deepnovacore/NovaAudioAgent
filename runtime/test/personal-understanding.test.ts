import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalUnderstanding} from '../src/personal-agent/understanding.js'
import {LifeService} from '../src/personal-agent/life.js'
import {understandingFixture} from '../src/understanding/fixture.js'
test('candidate acceptance is explicit, source checked, edited and idempotent',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-candidate-'));const life=new LifeService(join(dir,'life.json'));await life.open();const rows=understandingFixture();let source=rows[0]!.source
 const u=new PersonalUnderstanding({life,source:()=>source,pipeline:()=>Promise.resolve(rows),changed:()=>{/* observer */}})
 try{u.start();await new Promise(r=>setTimeout(r,0));assert.equal(life.snapshot().todos.length,0);assert.equal(u.snapshot().items.length,3)
  const todo=rows.find(r=>r.candidate.kind==='todo')!;await u.action({id:todo.candidate.id,action:'accept',text:'Compare courses'});await u.action({id:todo.candidate.id,action:'accept'});assert.equal(life.snapshot().todos.length,1)
  const profile=rows.find(r=>r.candidate.kind==='profile')!;await u.action({id:profile.candidate.id,action:'accept',expected_profile_version:0});assert.ok(life.snapshot().profile.about.includes('听力'))
  source={...source,text:source.text+'Changed'};const goal=rows.find(r=>r.candidate.kind==='goal')!;await assert.rejects(u.action({id:goal.candidate.id,action:'accept'}),/stale_source/);assert.equal(life.snapshot().goals.length,0)
 }finally{await u.close();await life.close();await rm(dir,{recursive:true,force:true})}
})

import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {validateCandidate,type EvidenceSource,type EvaluatedCandidate} from '../src/understanding/candidates.js'
const tick=()=>new Promise<void>(r=>setTimeout(r,20))
function record(source:EvidenceSource,capture:'explicit'|'suggested'|'none'='explicit'):EvaluatedCandidate{return {source,candidate:validateCandidate(source,{source_id:source.id,source_version:source.version,span:{start:0,end:source.text.length,quote:source.text},kind:'todo',text:source.text}),decision:{attribution:'user',modality:'request',support:'supported',importance:'useful',...{capture}},status:'proposed',reasons:[]}}
test('new persisted user messages auto-capture only explicit records, undo, and never replay on reopen',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-auto-'));const calls:string[]=[]
 const make=()=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null,understand:source=>{calls.push(source.text);return Promise.resolve([record(source,source.text.startsWith('记')?'explicit':'suggested')])}})
 let host=make();const bind=()=>host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'好的'}),close:()=>Promise.resolve()}),()=>{/* test observer */})
 try{await host.open();bind();await host.submitConversationText('chat:main','记下明天买牛奶','once');await host.waitConversation('chat:main');await tick();assert.equal(calls.length,1);assert.equal(host.life.snapshot().todos.length,1)
  await host.submitConversationText('chat:main','记下明天买牛奶','once');await tick();assert.equal(calls.length,1)
  const notice=(host.understanding.snapshot() as unknown as {recorded:{id:string}[]}).recorded[0]!;await host.understanding.action({id:notice.id,action:'undo'});assert.equal(host.life.snapshot().todos.length,0)
  await host.submitConversationText('chat:main','帮我解释怎么选牛奶');await host.waitConversation('chat:main');await tick();assert.equal(host.life.snapshot().todos.length,0);assert.equal(host.understanding.snapshot().items.length,1)
  await host.close();host=make();await host.open();assert.equal(calls.length,2);assert.equal(host.understanding.snapshot().items.length,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('superseded and switched conversations abort background capture even if model ignores abort',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-auto-stale-'));const pending:{source:EvidenceSource,signal:AbortSignal,resolve:(rows:EvaluatedCandidate[])=>void}[]=[]
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null,understand:(source,signal)=>new Promise(resolve=>pending.push({source,signal,resolve}))})
 try{await host.open();host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'好'}),close:()=>Promise.resolve()}),()=>{/* test observer */})
  await host.submitConversationText('chat:main','记下旧计划');await host.waitConversation('chat:main');await host.submitConversationText('chat:main','记下新计划');await host.waitConversation('chat:main');assert.equal(pending.length,2);assert.equal(pending[0]!.signal.aborted,true)
  pending[0]!.resolve([record(pending[0]!.source)]);await tick();assert.equal(host.life.snapshot().todos.length,0)
  await host.command({type:'personal.command',request_id:'switch',method:'conversations.select',params:{id:'chat:proactive'}});assert.equal(pending[1]!.signal.aborted,true);pending[1]!.resolve([record(pending[1]!.source)]);await tick();assert.equal(host.life.snapshot().todos.length,0);assert.equal(host.understanding.snapshot().items.length,0)
 }finally{for(const p of pending)p.resolve([]);await host.close();await rm(dir,{recursive:true,force:true})}
})
test('voice partial and duplicate final never capture; final captures once and edited records cannot be undone',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-auto-voice-'));const calls:EvidenceSource[]=[];let emit:(frame:Record<string,unknown>)=>void=()=>{/* test observer */}
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null,understand:source=>{calls.push(source);return Promise.resolve([record(source)])}})
 const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await tick();assert.ok(check())}
 try{await host.open();host.setConversationRuntime((_c,send)=>{emit=send;return Promise.resolve({runTurn:()=>Promise.resolve({assistant:'好'}),close:()=>Promise.resolve()})},()=>{/* test observer */})
  await host.command({type:'personal.command',request_id:'voice',method:'conversations.voice',params:{id:'chat:main',enabled:true}})
  emit({type:'caption',role:'user',final:false,text:'记下买',turn_id:'voice-user'});await tick();assert.equal(calls.length,0)
  emit({type:'caption',role:'user',final:true,text:'记下买牛奶',turn_id:'voice-user'});await until(()=>host.life.snapshot().todos.length===1)
  emit({type:'caption',role:'user',final:true,text:'记下买牛奶',turn_id:'voice-user'});await tick();assert.equal(calls.length,1)
  const todo=host.life.snapshot().todos[0]!,notice=host.understanding.snapshot().recorded[0]!;await host.life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,title:'牛奶和面包'},'edit')
  await assert.rejects(host.understanding.action({id:notice.id,action:'undo'}),/version_conflict/);assert.equal(host.life.snapshot().todos[0]!.title,'牛奶和面包')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})


test('local-only host keeps explicit creates but refuses unresolved status updates',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-auto-local-update-'));let update=false
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null,understand:source=>{
  const row=record(source)
  if(update){const {id,...raw}=row.candidate;assert.ok(id);row.candidate=validateCandidate(source,{...raw,operation:'update',patch:{status:'done'}})}
  return Promise.resolve([row])
 }})
 try{await host.open();host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'好'}),close:()=>Promise.resolve()}),()=>{/* observer */})
  await host.submitConversationText('chat:main','记录学习任务');await host.waitConversation('chat:main');await tick();assert.equal(host.life.snapshot().todos.length,1)
  update=true;await host.submitConversationText('chat:main','把学习任务标为完成');await host.waitConversation('chat:main');await tick()
  assert.equal(host.life.snapshot().todos.length,1);assert.equal(host.life.snapshot().todos[0]!.status,'open');assert.equal(host.understanding.snapshot().status,'failed')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
