import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkbenchContext,contextCardSchema} from '../src/personal-agent/workbench-context.js'
import {candidateId,type ContextInput} from '../src/personal-agent/context-candidates.js'
import {GatewayPersonalWriter} from '../src/model/personal-writer.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
/** The documents a digest fixture cites, fed back as the eligible inputs they would be in production. */
const refFile=(ref:{entry_id:string;version:string}):ContextInput=>({kind:'file',id:ref.entry_id,version:ref.version,content:'Project notes.',source_id:'s',file_id:ref.entry_id,root:'/nova',rel_path:'notes.md',role:'document',mtime_ms:1,priority:1})
test('generated suggestion copy stays short enough for a single readable card',()=>{
 const card={candidate_id:'c',tab:'ideas',title:'具体提议',body:'一句简短的说明。',refs:[{entry_id:'source:doc',version:'v1'}]}
 assert.equal(contextCardSchema.safeParse(card).success,true)
 assert.equal(contextCardSchema.safeParse({...card,body:'细节'.repeat(61)}).success,false)
})
test('a goal suggestion is kept only against a goal candidate from the same project',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-'))
 const refs=[{entry_id:'source:nova',version:'v1'}]
 const digests=[{project_key:'k',name:'nova',role:'own' as const,summary:'Voice agent',focus:'Fixing workbench content',next_step:null,refs}]
 let tabFor:(tab:string)=>'todos'|'goals'=tab=>tab as 'todos'|'goals'
 const generate=(candidates:readonly {candidate_id:string;tab:string}[])=>Promise.resolve({recap:null,cards:candidates.map(c=>({candidate_id:c.candidate_id,tab:tabFor(c.tab),title:c.tab==='goals'?'让 Nova 成为每天在用的助手':'Finish the digest layer',body:'一周里大部分事情都交给它。',why:null,next:c.tab==='goals'?'先把待办页跑顺':null,refs}))})
 const context=new WorkbenchContext(join(dir,'cards.json'),generate,()=>undefined)
 try{
  await context.open();context.update(digests.flatMap(d=>d.refs.map(refFile)),{items:digests,pending:0});await context.refresh()
  const goal=context.snapshot().cards.find(card=>card.tab==='goals')
  assert.equal(goal?.title,'让 Nova 成为每天在用的助手');assert.equal(goal?.next,'先把待办页跑顺')
  assert.equal(context.snapshot().empty_reasons.goals,null)
  tabFor=()=>'goals';await context.clear();context.update(digests.flatMap(d=>d.refs.map(refFile)),{items:digests,pending:0});await context.refresh()
  assert.deepEqual(context.snapshot().cards.map(card=>card.tab),['goals'],'a todo candidate relabelled as a goal is dropped')
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('project cards survive a digest rewrite until regenerated, but never once a source they drew on is withdrawn',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-roots-'))
 const a={entry_id:'source:a',version:'v1'},b={entry_id:'source:b',version:'v1'},c={entry_id:'source:c',version:'v1'}
 const file=(ref:typeof a):ContextInput=>({kind:'file',id:ref.entry_id,version:ref.version,content:'Project notes.',source_id:'s',file_id:ref.entry_id,root:'/nova',rel_path:ref.entry_id.slice(7)+'.md',role:'document',mtime_ms:1,priority:1})
 // The digest cites only A but also read B and C.
 const digest=(refs:typeof a[],inputs:string[],focus:string|null)=>[{project_key:'k',name:'nova',role:'own' as const,summary:'Voice agent',focus,next_step:null,refs,inputs}]
 const doc:ContextInput={kind:'file',id:'source:m',version:'v1',content:'An idea for a simpler setup.',source_id:'s',file_id:'m',root:'/project',rel_path:'notes.md',role:'document',mtime_ms:1,priority:2}
 const generate=(candidates:readonly {candidate_id:string;tab:string;refs:readonly {entry_id:string;version:string|number}[]}[])=>Promise.resolve({recap:null,cards:candidates.map(c=>({candidate_id:c.candidate_id,tab:c.tab as 'todos'|'ideas'|'goals',title:'Keep going on '+c.tab,body:'Still in progress.',why:null,next:c.tab==='ideas'?null:'Take the next step',refs:c.refs.map(ref=>({...ref}))}))})
 const context=new WorkbenchContext(join(dir,'cards.json'),generate,()=>undefined)
 try{
  await context.open();context.update([doc,file(a),file(b),file(c)],{items:digest([a],['source:a','source:b','source:c'],'A with B'),pending:0});await context.refresh()
  const before=context.snapshot().cards
  assert.deepEqual(before.map(card=>card.tab).sort(),['goals','ideas','todos'])
  const a2={...a,version:'v2'}
  const rewritten=digest([a2],['source:a','source:b','source:c'],'A with B, reworded')
  context.update([{...doc,version:'v2'},file(a2),file(b),file(c)],{items:rewritten,pending:0})
  const after=context.snapshot().cards
  assert.deepEqual(after.map(card=>card.tab).sort(),['goals','todos'],'project cards stay; the document card needs an exact match')
  assert.deepEqual(after.map(card=>card.id).sort(),before.filter(card=>card.tab!=='ideas').map(card=>card.id).sort(),'the card keeps its identity for dismissal')
  for(const card of after)assert.deepEqual(card.refs.map(({entry_id,version})=>({entry_id,version})),[a2],'a kept card cites the current versions')
  context.update([file(a2),file(b),file(c)],{items:rewritten.map(d=>({...d,focus:null})),pending:0})
  assert.deepEqual(context.snapshot().cards.map(card=>card.tab),['goals'],'a todo card needs a todo successor, not the project goal')
  context.update([file(a2),file(b),file(c)],{items:rewritten,pending:0})
  await context.dismiss(after.find(card=>card.tab==='goals')!.id)
  assert.deepEqual(context.snapshot().cards.map(card=>card.tab),['todos'])
  context.update([file(a2),file(c)],{items:digest([a2],['source:a','source:c'],'A only'),pending:0})
  assert.equal(context.snapshot().cards.length,0,'B was read uncited; a card written from it must not outlive it even behind a safe successor')
  context.update([file(a2),file(c)],{items:digest([a2],['source:a','source:c'],'A only'),pending:0})
  context.update([file(a2),file(b),file(c)],{items:[],pending:0});assert.equal(context.snapshot().cards.length,0,'no successor, no card')
  // An exact match is no exemption: the unchanged digest must not keep showing once an uncited input goes.
  await context.clear();context.update([file(a),file(b),file(c)],{items:digest([a],['source:a','source:b','source:c'],'A with B'),pending:0});await context.refresh()
  assert.equal(context.snapshot().cards.length,2)
  context.update([file(a),file(c)],{items:digest([a],['source:a','source:b','source:c'],'A with B'),pending:0})
  assert.equal(context.snapshot().cards.length,0,'B left the eligible inputs, so cards derived from it go even when their candidate is unchanged')
  // Present is not eligible: a priority-0 file stays among the inputs but no longer feeds a digest.
  const idleB:ContextInput={kind:'file',id:b.entry_id,version:b.version,content:'Project notes.',source_id:'s',file_id:b.entry_id,root:'/nova',rel_path:'b.md',role:'document',mtime_ms:1,priority:0}
  await context.clear();context.update([file(a),file(b)],{items:digest([a],['source:a','source:b'],'A with B'),pending:0});await context.refresh()
  assert.equal(context.snapshot().cards.length,2)
  context.update([file(a),idleB],{items:digest([a],['source:a'],'A only'),pending:0})
  assert.equal(context.snapshot().cards.length,0,'B dropped to priority 0; the A-only successor must not revive cards written from it')
  context.update([file(a),idleB],{items:digest([a],['source:a','source:b'],'A with B'),pending:0})
  assert.equal(context.snapshot().cards.length,0,'nor may the unchanged candidate keep them')
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('refs-only provenance written by an earlier build is dropped, so it cannot revive a card',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-legacy-')),path=join(dir,'cards.json')
 const a={entry_id:'source:a',version:'v1'}
 const file=(ref:typeof a):ContextInput=>({kind:'file',id:ref.entry_id,version:ref.version,content:'Project notes.',source_id:'s',file_id:ref.entry_id,root:'/nova',rel_path:'notes.md',role:'document',mtime_ms:1,priority:1})
 const card={candidate_id:'old-card',tab:'goals',title:'Old goal',body:'Written from A and B.',why:null,next:'Keep going',refs:[a]}
 await writeFile(path,JSON.stringify({version:2,recap:null,recap_basis:[],card_basis:{'old-card':{root:'project:k',entries:['source:a']}},cards:[card],key:'',automatic_call_times:[],retry_key:'',retry_not_before:0,dismissed:['kept'],legacyDismissed:[]}),{mode:0o600})
 const context=new WorkbenchContext(path,undefined,()=>undefined)
 try{
  await context.open()
  context.update([file(a)],{items:[{project_key:'k',name:'nova',role:'own' as const,summary:'Voice agent',focus:null,next_step:null,refs:[a],inputs:['source:a']}],pending:0})
  assert.equal(context.snapshot().cards.length,0,'a same-project successor does not revive a card with untrusted provenance')
  await context.dismiss('old-card');assert.ok((JSON.parse(await readFile(path,'utf8')) as {dismissed:string[]}).dismissed.includes('kept'),'the rest of the state survives the upgrade')
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('automatic cards are grounded, persistent, dismissible, and disappear after source invalidation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-'));const path=join(dir,'cards.json')
 const entry:ContextInput={kind:'file',id:'source:m',version:'v1',content:'Next step: review the design.',source_id:'s',file_id:'m',root:'/project',rel_path:'notes.md',role:'document',mtime_ms:1,priority:2}
 const candidate_id=candidateId('todos','m','v1')
 let calls=0
 const generate=()=>{calls++;return Promise.resolve({cards:[{candidate_id,tab:'todos' as const,title:'Review documented next step',body:'Suggested from project notes, not a commitment.',refs:[{entry_id:'source:m',version:'v1'}]}]})}
 const context=new WorkbenchContext(path,generate,()=>undefined)
 try{
  await context.open();context.update([entry]);await context.refresh();assert.equal(context.snapshot().cards.length,1)
  await context.refresh();assert.equal(calls,1)
  const id=context.snapshot().cards[0]!.id;await context.dismiss(id);assert.equal(context.snapshot().cards.length,0)
  await context.close();const reopened=new WorkbenchContext(path,generate,()=>undefined);await reopened.open();reopened.update([entry]);assert.equal(reopened.snapshot().cards.length,0);await reopened.close()
  await context.open();context.update([entry]);await context.clear();assert.equal(context.snapshot().cards.length,0);context.update([entry]);await context.refresh();assert.equal(context.snapshot().cards.length,1,'clearing private drafts does not disable future generation');
  const invalid=new WorkbenchContext(join(dir,'invalid.json'),()=>Promise.resolve({cards:[{candidate_id:'invented',tab:'ideas',title:'Invalid',body:'Missing source',refs:[{entry_id:'invented',version:1}]}]}),()=>undefined)
  await invalid.open();invalid.update([entry]);await invalid.refresh();assert.equal(invalid.snapshot().cards.length,0);assert.equal(invalid.snapshot().status,'ready');await invalid.close()
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('dismissal follows evidence identity across model paraphrases and old cache is discarded',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-id-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v1',content:'Next step: compare voice flows.',source_id:'s',file_id:'doc',root:'/project',rel_path:'notes.md',role:'document',mtime_ms:1,priority:2}
 const id=candidateId('todos','doc','v1')
 let wording='Compare voice flows'
 const generator=()=>Promise.resolve({cards:[{candidate_id:id,tab:'todos' as const,title:wording,body:'Suggested by project notes.',refs:[{entry_id:'source:doc',version:'v1'}]}]})
 try{
  await writeFile(path,JSON.stringify({key:'legacy',dismissed:[],cards:[{tab:'profile',title:'Old profile',body:'Config guess',refs:[{entry_id:'source:doc',version:'v1'}]}]}),{mode:0o600})
  const context=new WorkbenchContext(path,generator,()=>undefined);await context.open();context.update([input])
  assert.equal(context.snapshot().cards.length,0)
  await context.refresh();assert.equal(context.snapshot().cards.length,1)
  await context.dismiss(id);wording='A different title';context.update([{...input,mtime_ms:2}]);await context.refresh()
  assert.equal(context.snapshot().cards.length,0)
  await context.close()
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('invalid or raw-field cards are omitted without hiding a valid suggestion',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-filter-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v1',content:'An idea for a simpler setup.',source_id:'s',file_id:'doc',root:'/project',rel_path:'notes.md',role:'document',mtime_ms:1,priority:2}
 const id=candidateId('ideas','doc','v1')
 const context=new WorkbenchContext(path,()=>Promise.resolve({cards:[
  {candidate_id:id,tab:'ideas',title:'Simplify setup',body:'The notes describe a simpler setup.',refs:[{entry_id:'source:doc',version:'v1'}]},
  {candidate_id:'invented',tab:'ideas',title:'Unrelated',body:'No evidence',refs:[{entry_id:'source:doc',version:'v1'}]},
  {candidate_id:id,tab:'ideas',title:'Leaked',body:'api_key: secret',refs:[{entry_id:'source:doc',version:'v1'}]},
 ]}),()=>undefined)
 try{await context.open();context.update([input]);await context.refresh();assert.deepEqual(context.snapshot().cards.map(card=>card.title),['Simplify setup'])}finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('automatic generation waits for eligible candidate changes and persists its quota',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']})
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-clock-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v1',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0
 const context=new WorkbenchContext(path,()=>{calls++;return Promise.resolve({cards:[]})},()=>undefined)
 try{
  await context.open()
  for(let n=0;n<100;n++)context.update([])
  t.mock.timers.tick(600_000);assert.equal(calls,0)
  context.update([input]);t.mock.timers.tick(2_999);assert.equal(calls,0)
  t.mock.timers.tick(1);await context.refresh();assert.equal(calls,1)
  await context.refresh()
  context.update([{...input,version:'v2',mtime_ms:2}]);t.mock.timers.tick(119_999);assert.equal(calls,1)
  t.mock.timers.tick(1);await context.refresh();assert.equal(calls,2)
  await context.close()
  const reopened=new WorkbenchContext(path,()=>{calls++;return Promise.resolve({cards:[]})},()=>undefined)
  await reopened.open();reopened.update([{...input,version:'v3',mtime_ms:3}]);t.mock.timers.tick(119_999);assert.equal(calls,2)
  t.mock.timers.tick(1);await reopened.refresh();assert.equal(calls,3)
  await reopened.close()
 }finally{t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
test('continuous candidate churn has a maximum wait and pause cancels pending work',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']})
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-churn-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v0',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0
 const context=new WorkbenchContext(path,()=>{calls++;return Promise.resolve({cards:[]})},()=>undefined)
 try{
  await context.open();context.update([input])
  for(let n=1;n<10;n++){t.mock.timers.tick(1000);context.update([{...input,version:'v'+n}])}
  assert.equal(calls,0);t.mock.timers.tick(1000);await context.refresh();assert.equal(calls,1)
  context.update([{...input,version:'later0'}])
  for(let n=1;n<12;n++){t.mock.timers.tick(10_000);context.update([{...input,version:'later'+n}])}
  assert.equal(calls,1);t.mock.timers.tick(10_000);await context.refresh();assert.equal(calls,2)
  context.update([{...input,version:'paused'}]);context.update([]);t.mock.timers.tick(120_000);assert.equal(calls,2)
 }finally{t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
test('automatic calls stop at six per hour and a capped candidate runs when eligible',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']})
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-limit-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v0',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0;const context=new WorkbenchContext(path,()=>{calls++;return Promise.resolve({cards:[]})},()=>undefined)
 try{
  await context.open();context.update([input]);t.mock.timers.tick(3000);await context.refresh();assert.equal(calls,1)
  for(let n=1;n<=5;n++){context.update([{...input,version:'v'+n}]);t.mock.timers.tick(120_000);await context.refresh();assert.equal(calls,n+1)}
  context.update([{...input,version:'v6'}]);await context.refresh();assert.equal(calls,7,'manual refresh bypasses the automatic quota')
  context.update([{...input,version:'v7'}]);t.mock.timers.tick(120_000);assert.equal(calls,7)
  t.mock.timers.tick(3_600_000-6*120_000);await context.refresh();assert.equal(calls,8,'manual refresh did not consume a quota slot')
 }finally{t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
test('candidate changes during generation queue one trailing automatic call',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']})
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-flight-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v0',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0,release:()=>void=()=>undefined
 const blocked=new Promise<void>(resolve=>{release=resolve})
 const context=new WorkbenchContext(path,async()=>{calls++;if(calls===1)await blocked;return {cards:[]}},()=>undefined)
 const until=async(check:()=>boolean)=>{const deadline=performance.now()+5000;while(!check()&&performance.now()<deadline)await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(check(),`calls=${calls}`)}
 try{
  await context.open();context.update([input]);t.mock.timers.tick(3000);await until(()=>calls===1)
  context.update([{...input,version:'v1'}]);context.update([{...input,version:'v2'}]);t.mock.timers.tick(120_000);assert.equal(calls,1)
  release();await until(()=>context.snapshot().status==='ready');t.mock.timers.tick(0);await context.refresh();assert.equal(calls,2)
 }finally{release();t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
test('automatic failures retry with backoff and retain the hourly cap after reopen',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});t.mock.method(console,'error',()=>undefined)
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-retry-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v0',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0;const generate=()=>{calls++;return Promise.reject(Error('offline'))}
 const until=async(check:()=>boolean)=>{const deadline=performance.now()+5000;while(!check()&&performance.now()<deadline)await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(check(),`calls=${calls}`)}
 const context=new WorkbenchContext(path,generate,()=>undefined)
 try{
  await context.open();context.update([input]);t.mock.timers.tick(3000);await until(()=>calls===1&&context.snapshot().status==='failed')
  t.mock.timers.tick(299_999);assert.equal(calls,1);t.mock.timers.tick(1);await until(()=>calls===2&&context.snapshot().status==='failed')
  for(let n=3;n<=6;n++){t.mock.timers.tick(300_000);await until(()=>calls===n&&context.snapshot().status==='failed')}
  const persisted=JSON.parse(await readFile(path,'utf8')) as {automatic_call_times:number[];retry_not_before:number}
  assert.equal(persisted.automatic_call_times.length,6);assert.ok(persisted.retry_not_before>Date.now())
  t.mock.timers.tick(300_000);assert.equal(calls,6,'automatic failures still consume the hourly quota')
  await context.close();const reopened=new WorkbenchContext(path,generate,()=>undefined)
  await reopened.open();reopened.update([input]);t.mock.timers.tick(1_799_999);assert.equal(calls,6)
  t.mock.timers.tick(1);await until(()=>calls===7&&reopened.snapshot().status==='failed');await reopened.close()
 }finally{t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
test('the todo page gets a grounded recap, action cards with why and next, and one line per own project',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-'))
 const refs=[{entry_id:'source:nova',version:'v1'}]
 const digests=[{project_key:'k',name:'nova',role:'own' as const,summary:'Voice agent',focus:'Fixing workbench content',next_step:'Ship the digest layer',refs}]
 let recapRefs=refs
 const generate=(candidates:readonly {candidate_id:string}[])=>Promise.resolve({recap:{text:'Mostly on the voice agent workbench.',refs:recapRefs},cards:[{candidate_id:candidates[0]!.candidate_id,tab:'todos' as const,title:'Finish the digest layer',body:'Profile now reads project digests.',why:'The next step is written down',next:'Run the native acceptance',refs}]})
 const context=new WorkbenchContext(join(dir,'cards.json'),generate,()=>undefined)
 try{
  await context.open()
  context.update([],{items:[],pending:2});assert.equal(context.snapshot().empty_reason,'digests_pending','an empty page while projects are still read says so')
  context.update(digests.flatMap(d=>d.refs.map(refFile)),{items:digests,pending:0});await context.refresh()
  const snapshot=context.snapshot()
  assert.equal(snapshot.recap.text,'Mostly on the voice agent workbench.')
  assert.deepEqual(snapshot.recap.projects,[{name:'nova',line:'Fixing workbench content'}])
  assert.equal(snapshot.cards[0]!.why,'The next step is written down');assert.equal(snapshot.cards[0]!.next,'Run the native acceptance')
  context.update([],{items:[],pending:0});assert.equal(context.snapshot().recap.text,null,'the recap leaves with its evidence')
  recapRefs=[{entry_id:'source:invented',version:'v1'}];await context.clear();context.update(digests.flatMap(d=>d.refs.map(refFile)),{items:digests,pending:0});await context.refresh()
  assert.equal(context.snapshot().recap.text,null,'an ungrounded recap is dropped');assert.equal(context.snapshot().cards.length,1)
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('short-key goal recap uses same-project todo grounding and retires when its source is withdrawn',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-keys-'))
 const refs=[{entry_id:'source:nova',version:'v1'}]
 const digests=[{project_key:'k',name:'nova',role:'own' as const,summary:'Voice agent',focus:'Fixing workbench content',next_step:'Ship the digest layer',refs}]
 const gateway={complete:(request:{prompt:string})=>{const {candidates}=JSON.parse(request.prompt) as {candidates:{key:string;tab:string}[]}
  return Promise.resolve({text:JSON.stringify({recap:{text:'这周主要在做工作台。',keys:candidates.filter(c=>c.tab==='goals').map(c=>c.key)},cards:candidates.map(c=>({key:c.key,title:c.tab==='goals'?'让 Nova 成为每天在用的助手':'把摘要层收尾',body:'工作台已经在读项目摘要了。',why:null,next:'跑一次原生验收'}))})})}} as unknown as ModelGateway
 const context=new WorkbenchContext(join(dir,'cards.json'),new GatewayPersonalWriter({gateway,model:'m'}).generateContext,()=>undefined)
 try{
  await context.open();context.update(digests.flatMap(d=>d.refs.map(refFile)),{items:digests,pending:0});await context.refresh()
  const snapshot=context.snapshot()
  assert.equal(snapshot.recap.text,'这周主要在做工作台。')
  assert.deepEqual(snapshot.cards.map(card=>[card.tab,card.refs.map(ref=>ref.entry_id)]),[['todos',['source:nova']],['goals',['source:nova']]])
  context.update([],{items:[],pending:0})
  assert.equal(context.snapshot().recap.text,null,'source withdrawal retires even a recap citing the goal key')
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('a recap retires when a digest it drew on is replaced, even if its cited ref survives',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-basis-'))
 const a={entry_id:'source:a',version:'v1'},b={entry_id:'source:b',version:'v1'}
 const digest=(refs:typeof a[],focus:string)=>[{project_key:'k',name:'nova',role:'own' as const,summary:'Voice agent',focus,next_step:null,refs}]
 let recapText='Working on A and the private B plan.'
 const generate=(candidates:readonly {candidate_id:string}[])=>Promise.resolve({recap:{text:recapText,refs:[a]},cards:[{candidate_id:candidates[0]!.candidate_id,tab:'todos' as const,title:'Continue A',body:'A is in progress.',refs:[a]}]})
 const context=new WorkbenchContext(join(dir,'cards.json'),generate,()=>undefined)
 try{
  await context.open();context.update([refFile(a),refFile(b)],{items:digest([a,b],'A and B'),pending:0});await context.refresh()
  assert.equal(context.snapshot().recap.text,'Working on A and the private B plan.')
  context.update([refFile(a),refFile(b)],{items:digest([a],'A only'),pending:0})
  assert.equal(context.snapshot().recap.text,null,'B was withdrawn, so a recap written from it must not return')
  recapText='Working on A.';await context.refresh();assert.equal(context.snapshot().recap.text,'Working on A.')
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('recap and action text reject Windows, UNC, and general absolute paths',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-paths-'))
 const refs=[{entry_id:'source:nova',version:'v1'}]
 const digests=[{project_key:'k',name:'nova',role:'own' as const,summary:'Voice agent',focus:'Fixing content',next_step:'Ship',refs}]
 let text='',next:string|null=null,why:string|null=null
 const generate=(candidates:readonly {candidate_id:string}[])=>Promise.resolve({recap:{text,refs},cards:[{candidate_id:candidates[0]!.candidate_id,tab:'todos' as const,title:'Ship it',body:'Ready.',why,next,refs}]})
 const context=new WorkbenchContext(join(dir,'cards.json'),generate,()=>undefined)
 try{
  await context.open()
  for(const leak of ['C:\\Users\\someone\\private\\plan.md','\\\\server\\share\\plan.md','/private/tmp/private-plan.md','see /opt/app/config now']){
   text=`Recap ${leak}`;why=`Because ${leak}`;next=null
   await context.clear();context.update(digests.flatMap(d=>d.refs.map(refFile)),{items:digests,pending:0});await context.refresh()
   assert.equal(context.snapshot().recap.text,null,leak);assert.equal(context.snapshot().cards.length,0,leak)
   text='Plain recap.';why=null;next=`Open ${leak}`
   await context.clear();context.update(digests.flatMap(d=>d.refs.map(refFile)),{items:digests,pending:0});await context.refresh()
   assert.equal(context.snapshot().cards.length,0,leak)
  }
  text='前端/后端 都在推进。';why=null;next='比较 A/B 两种流程'
  await context.clear();context.update(digests.flatMap(d=>d.refs.map(refFile)),{items:digests,pending:0});await context.refresh()
  assert.equal(context.snapshot().recap.text,'前端/后端 都在推进。');assert.equal(context.snapshot().cards.length,1,'relative slashes are ordinary prose')
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('an idea candidate does not mask pending project digests on the Todo page',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-tabs-'))
 const context=new WorkbenchContext(join(dir,'cards.json'),()=>Promise.resolve({cards:[]}),()=>undefined)
 try{
  await context.open()
  context.update([{id:'m',version:1,content:'一个想法：用更简单的引导流程替代现在的设置页。',origin:'stated'}],{items:[],pending:3});await context.refresh()
  const snapshot=context.snapshot()
  assert.equal(snapshot.candidate_count,1,'the idea is a real candidate')
  assert.equal(snapshot.empty_reasons.todos,'digests_pending');assert.equal(snapshot.empty_reasons.ideas,'model_abstained')
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
