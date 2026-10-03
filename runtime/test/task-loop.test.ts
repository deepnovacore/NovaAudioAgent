/* eslint-disable @typescript-eslint/require-await -- deterministic injected loop ports preserve asynchronous contracts */
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {TaskService,type TaskRecord} from '../src/personal-agent/tasks.js'
const fence=(t:TaskRecord)=>({task_id:t.id,control_revision:t.control_revision,goal_revision:t.goal_revision})
test('completion requires resolved task evidence, not public refs, and preserves original goal',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-loop-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{await tasks.open();const task=await tasks.delegate('d',{conversation_id:'c',goal:'original',acceptance:['checked'],origin_ref:'conversation:1'})
 await tasks.appendEvent({task_id:task.id,kind:'tool',text:'ok',refs:['fake']},'display')
 const service=tasks as TaskService & {applyDecision?:(f:ReturnType<typeof fence>,d:unknown)=>Promise<TaskRecord>}
 assert.equal(typeof service.applyDecision,'function')
 await assert.rejects(service.applyDecision(fence(task),{kind:'complete',evidence_refs:['fake']}),/evidence/)
 await assert.rejects(service.applyDecision(fence(task),{kind:'complete',evidence_refs:[]}),/evidence/)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

import {TaskLoop} from '../src/personal-agent/task-loop.js'
import {LifeService} from '../src/personal-agent/life.js'
async function setup(){const dir=await mkdtemp(join(await realpath(tmpdir()),'task-loop-')),tasks=new TaskService(join(dir,'tasks.json'));await tasks.open();const task=await tasks.delegate('d',{conversation_id:'c',goal:'original',acceptance:['checked'],origin_ref:'conversation:1'});return {tasks,task,close:async()=>{await tasks.close();await rm(dir,{recursive:true,force:true})}}}
test('real outcomes complete; active work and stale goal/control cannot complete',async()=>{
 const f=await setup();try{await f.tasks.bindWork(fence(f.task),'w');await assert.rejects(f.tasks.applyDecision(fence(f.task),{kind:'complete',evidence_refs:[]}),/active/)
 const ref=await f.tasks.recordWorkOutcome('w','ok',{checks:['passed']});assert.ok(ref)
 await f.tasks.reviseGoal('r',fence(f.task),{kind:'nova'},'new goal',['more']);assert.equal(f.tasks.get(f.task.id).original_goal,'original')
 await assert.rejects(f.tasks.applyDecision(fence(f.task),{kind:'complete',evidence_refs:[ref]}),/stale/)
 await assert.rejects(f.tasks.applyDecision(fence(f.tasks.get(f.task.id)),{kind:'complete',evidence_refs:[ref]}),/evidence/)
 await f.tasks.recordDelivery(fence(f.tasks.get(f.task.id)),'reply','actual deliverable')
 await f.tasks.applyDecision(fence(f.tasks.get(f.task.id)),{kind:'complete',evidence_refs:['task-delivery:reply']});assert.equal(f.tasks.get(f.task.id).phase,'completed')
 }finally{await f.close()}
})
test('three corrections then wait; explicit continue resets; dispatch error cannot spin',async()=>{
 const f=await setup();let executions=0;try{await f.tasks.recordDelivery(fence(f.task),'reply','incomplete');const loop=new TaskLoop(f.tasks,{evaluate:async()=>({kind:'correct',instruction:'fix',evidence_refs:['task-delivery:reply']}),execute:async()=>{executions++},syncTodo:async()=> 'synced'})
 for(let i=0;i<4;i++)await loop.wake(f.task.id)
 assert.equal(executions,3);assert.equal(f.tasks.get(f.task.id).waiting_reason,'correction_limit')
 await f.tasks.continue('continue',fence(f.tasks.get(f.task.id)),{kind:'nova'});await loop.wake(f.task.id);assert.equal(executions,4);await loop.close()
 const failing=new TaskLoop(f.tasks,{evaluate:async()=>({kind:'correct',instruction:'fix',evidence_refs:[]}),execute:async()=>{executions++;throw Error('lost')},syncTodo:async()=> 'synced'});await failing.wake(f.task.id);await failing.wake(f.task.id);assert.equal(executions,5);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_effect_unknown');await failing.close()
 }finally{await f.close()}
})
test('cancellation during verification and concurrent new work invalidate final acceptance',async()=>{
 for(const mutate of ['cancel','work','control'] as const){const f=await setup();try{await f.tasks.recordDelivery(fence(f.task),'reply','answer');let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(done=>{started=done});const barrier=new Promise<void>(done=>{release=done});const loop=new TaskLoop(f.tasks,{evaluate:async()=>{started();await barrier;return {kind:'complete',evidence_refs:['task-delivery:reply']}},execute:async()=>{/* no corrective work in this race */},syncTodo:async()=> 'synced'});const run=loop.wake(f.task.id);await ready;if(mutate==='cancel')await f.tasks.cancel('c',fence(f.task),{kind:'nova'});else if(mutate==='work')await f.tasks.bindWork(fence(f.task),'new');else await f.tasks.control('c',fence(f.task),{kind:'nova'},{kind:'user',client_id:'u'});release();await run;assert.notEqual(f.tasks.get(f.task.id).phase,'completed');await loop.close()}finally{await f.close()}}
})
test('Todo completion uses deterministic receipt and preserves manual changes',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-todo-')),life=new LifeService(join(dir,'life.json'));try{await life.open();const todo=await life.mutate({op:'create',kind:'todo',title:'Keep title',note:'Keep note'},'create');const task={id:'t',goal_revision:0,todo_ref:todo} as TaskRecord
 assert.equal(await life.completeTaskTodo(task),'synced');assert.equal(await life.completeTaskTodo(task),'synced');assert.equal(life.snapshot().todos[0]!.version,2);assert.equal(life.snapshot().todos[0]!.note,'Keep note')
 const second=await life.mutate({op:'create',kind:'todo',title:'manual'},'second');await life.mutate({op:'update',kind:'todo',id:second.id,expected_version:1,status:'cancelled'},'cancel');assert.equal(await life.completeTaskTodo({...task,id:'t2',todo_ref:second}),'conflict');assert.equal(life.snapshot().todos[1]!.status,'cancelled')
 }finally{await life.close();await rm(dir,{recursive:true,force:true})}
})

import {hostResponseIntentSchema} from '../src/realtime/protocol.js'
test('Nova continuation is an explicit drafting intent, not a narrated host fact',()=>{
 assert.equal(hostResponseIntentSchema.safeParse({kind:'task_continuation',item:{kind:'recovery',host_item_id:'h',event_id:'h',call_id:null,content:'authorized task'},task_summary:null,origin_spoken:false}).success,true)
})

test('projection failure retries only the Todo and model failure waits without execution',async()=>{
 const f=await setup();let evaluated=0,synced=0;try{await f.tasks.recordDelivery(fence(f.task),'reply','answer');const loop=new TaskLoop(f.tasks,{evaluate:async()=>{evaluated++;return {kind:'complete',evidence_refs:['task-delivery:reply']}},execute:async()=>assert.fail('execution'),syncTodo:async()=>{synced++;throw Error('lost acknowledgement')}})
 // Linked Todo is captured at declaration, not reconstructed from the completion text.
 const linked=await f.tasks.delegate('linked',{conversation_id:'c',goal:'linked',acceptance:[],origin_ref:'conversation:1',todo_ref:{id:'todo',version:1}});await f.tasks.recordDelivery(fence(linked),'linked','answer')
 const projection=new TaskLoop(f.tasks,{evaluate:async()=>{evaluated++;return {kind:'complete',evidence_refs:['task-delivery:linked']}},execute:async()=>assert.fail('execution'),syncTodo:async()=>{synced++;if(synced===1)throw Error('lost');return 'synced'}});await projection.wake(linked.id);assert.equal(f.tasks.get(linked.id).todo_sync,'pending');await projection.wake(linked.id);assert.equal(f.tasks.get(linked.id).todo_sync,'synced');assert.equal(evaluated,1);await projection.close();await loop.close()
 const failed=new TaskLoop(f.tasks,{evaluate:async()=>{throw Error('model unavailable')},execute:async()=>assert.fail('execution'),syncTodo:async()=> 'synced'});await failed.wake(f.task.id);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_check_unavailable');assert.equal(f.tasks.get(f.task.id).corrections,0);await failed.close()
 }finally{await f.close()}
})

test('an accepted steer receipt cannot serve as primary completion evidence',async()=>{
 const f=await setup();try{await f.tasks.bindWork(fence(f.task),'steer',undefined,false);const ref=await f.tasks.recordWorkOutcome('steer','ok',{accepted:true});await assert.rejects(f.tasks.applyDecision(fence(f.task),{kind:'complete',evidence_refs:[ref!]}),/evidence/)}finally{await f.close()}
})

test('unknown user input blocks correction after terminal work and handback, including serialized effect admission',async()=>{
 const f=await setup();let executions=0;try{await f.tasks.bindWork(fence(f.task),'work','session');await f.tasks.controlClient('take',fence(f.task),'client','takeover');const owned=f.tasks.get(f.task.id)
 assert.equal(await f.tasks.input('input',fence(owned),{kind:'user',client_id:'client'},'session','change it',async()=> 'unknown'),'unknown');await f.tasks.recordWorkOutcome('work','ok',{checks:['failed']});await f.tasks.controlClient('return',fence(owned),'client','return');const returned=f.tasks.get(f.task.id)
 const decision={kind:'correct' as const,instruction:'retry change',evidence_refs:['task-work:work']};const loop=new TaskLoop(f.tasks,{evaluate:async()=>decision,execute:async()=>{executions++},syncTodo:async()=> 'synced'})
 await loop.wake(f.task.id);assert.equal(executions,0);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_effect_unknown');assert.equal(f.tasks.get(f.task.id).corrections,0)
 await assert.rejects(f.tasks.applyDecision(fence(returned),decision),/task_effect_unknown/);await assert.rejects(f.tasks.reserveInitial(fence(returned)),/task_effect_unknown/);await loop.close()
 }finally{await f.close()}
})

test('input acknowledgement becoming unknown during evaluation fences the corrective decision',async()=>{
 const f=await setup();let release!:()=>void,entered!:()=>void,executions=0;const started=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 try{await f.tasks.bindWork(fence(f.task),'work','session');await f.tasks.recordWorkOutcome('work','ok',{checks:['failed']});const loop=new TaskLoop(f.tasks,{evaluate:async()=>{entered();await gate;return {kind:'correct',instruction:'fix',evidence_refs:['task-work:work']}},execute:async()=>{executions++},syncTodo:async()=> 'synced'});const run=loop.wake(f.task.id);await started;await f.tasks.input('input',fence(f.task),{kind:'nova'},'session','update',async()=> 'unknown');release();await run;assert.equal(executions,0);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_effect_unknown');await loop.close()}finally{release?.();await f.close()}
})

import {TaskExecutionRejected} from '../src/personal-agent/task-loop.js'
test('known refused initial attempts retry without verification or correction allowance',async()=>{
 const f=await setup();let attempts=0;const loop=new TaskLoop(f.tasks,{evaluate:async()=>assert.fail('initial admission is not verification'),execute:async()=>{attempts++;throw new TaskExecutionRejected('busy')},syncTodo:async()=> 'synced'})
 try{await loop.wake(f.task.id);await loop.wake(f.task.id);assert.equal(attempts,2);assert.equal(f.tasks.get(f.task.id).corrections,0);assert.equal(f.tasks.get(f.task.id).waiting_reason,'busy')}finally{await loop.close();await f.close()}
})
test('shutdown during evaluation does not write an unavailable check',async()=>{
 const f=await setup();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});await f.tasks.recordDelivery(fence(f.task),'reply','answer');const loop=new TaskLoop(f.tasks,{evaluate:async(_task,signal)=>{entered();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));signal.throwIfAborted();return {kind:'wait',reason:'unused',evidence_refs:[]}},execute:async()=>assert.fail('shutdown'),syncTodo:async()=> 'synced'})
 try{const run=loop.wake(f.task.id);await started;await loop.close();await run;assert.equal(f.tasks.get(f.task.id).waiting_reason,null)}finally{await f.close()}
})
test('takeover after effect reservation is a failed preflight rather than an unknown write',async()=>{
 const f=await setup(),reserve=f.tasks.reserveInitial.bind(f.tasks);f.tasks.reserveInitial=async bound=>{const id=await reserve(bound);await f.tasks.controlClient('take',bound,'client','takeover');return id};const loop=new TaskLoop(f.tasks,{evaluate:async()=>assert.fail('initial'),execute:async()=>assert.fail('preflight stopped it'),syncTodo:async()=> 'synced'})
 try{await loop.wake(f.task.id);assert.equal(f.tasks.pendingEffect(f.task.id),null)}finally{await loop.close();await f.close()}
})

test('a pending Nova delivery coalesces repeated wakes until its exact disposition',async()=>{
 const f=await setup();let executions=0;await f.tasks.recordDelivery(fence(f.task),'initial','incomplete');const loop=new TaskLoop(f.tasks,{evaluate:async()=>({kind:'correct',instruction:'finish',evidence_refs:['task-delivery:initial']}),execute:async(_task,_instruction,bound)=>{executions++;await f.tasks.beginDelivery(bound,'delivery:'+executions)},syncTodo:async()=> 'synced'})
 try{await loop.wake(f.task.id);for(let i=0;i<3;i++)await loop.wake(f.task.id);assert.equal(executions,1);assert.equal(f.tasks.get(f.task.id).corrections,1);await f.tasks.finishDelivery(f.task.id,'wrong');await loop.wake(f.task.id);assert.equal(executions,1);await f.tasks.finishDelivery(f.task.id,'delivery:1');await loop.wake(f.task.id);assert.equal(executions,2)}finally{await loop.close();await f.close()}
})

test('unknown primary outcomes fence evaluation, decisions, continue and direct input in the same process',async()=>{
 const f=await setup();let evaluated=0,executions=0,sent=0
 try{await f.tasks.bindWork(fence(f.task),'uncertain','session');await f.tasks.recordWorkOutcome('uncertain','unknown',{reason:'lost acknowledgement'})
 const loop=new TaskLoop(f.tasks,{evaluate:async()=>{evaluated++;return {kind:'correct',instruction:'retry',evidence_refs:[]}},execute:async()=>{executions++},syncTodo:async()=> 'synced'})
 await loop.wake(f.task.id);assert.equal(evaluated,0);assert.equal(executions,0);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_effect_unknown')
 for(const decision of [{kind:'complete' as const,evidence_refs:['task-work:uncertain']},{kind:'correct' as const,instruction:'retry',evidence_refs:[]}])await assert.rejects(f.tasks.applyDecision(fence(f.task),decision),/task_effect_unknown/)
 await assert.rejects(f.tasks.continue('continue',fence(f.task),{kind:'nova'}),/task_effect_unknown/)
 await assert.rejects(f.tasks.input('input',fence(f.task),{kind:'nova'},'session','retry',async()=>{sent++;return 'accepted'}),/task_effect_unknown/);assert.equal(sent,0)
 await assert.rejects(f.tasks.reserveInitial(fence(f.task)),/task_effect_unknown/);await loop.close()
 }finally{await f.close()}
})

test('changed goal completes the task but conflicts with the original delegated Todo scope',async()=>{
 const f=await setup(),life=new LifeService(f.tasks.path+'.life');await life.open()
 try{const todo=await life.mutate({op:'create',kind:'todo',title:'Implement login'},'todo');let task=await f.tasks.delegate('linked-scope',{conversation_id:'c',goal:'Implement login',acceptance:['login works'],origin_ref:'user:1',todo_ref:todo})
 task=await f.tasks.reviseGoal('plan-only',fence(task),{kind:'nova'},'Only write a plan; do not implement',['plan delivered']);await f.tasks.recordDelivery(fence(task),'plan','Implementation plan')
 const loop=new TaskLoop(f.tasks,{evaluate:async()=>({kind:'complete',evidence_refs:['task-delivery:plan']}),execute:async()=>assert.fail('no implementation'),syncTodo:t=>life.completeTaskTodo(t)})
 await loop.wake(task.id);assert.equal(f.tasks.get(task.id).phase,'completed');assert.equal(f.tasks.get(task.id).todo_sync,'conflict');assert.notEqual(life.snapshot().todos[0]!.status,'done');await loop.close()
 }finally{await life.close();await f.close()}
})

test('accepted direct steering must reconcile before verification and persists a fenced goal change',async()=>{
 const f=await setup();try{await f.tasks.bindWork(fence(f.task),'work','session');let task=await f.tasks.controlClient('take',fence(f.task),'client','takeover')
 await f.tasks.input('blue',fence(task),task.controller,'session','Change the goal to blue',async()=> 'accepted');await f.tasks.recordWorkOutcome('work','ok',{final:'blue'});task=await f.tasks.controlClient('return',fence(task),'client','return')
 await assert.rejects(f.tasks.applyDecision(fence(task),{kind:'complete',evidence_refs:['task-work:work']}),/task_input_reconciliation_required/)
 const reconciliation={kind:'reconcile',input_refs:['blue'],goal_change:{goal:'Make blue',acceptance:['blue observed']}}
 task=await f.tasks.applyDecision(fence(task),reconciliation as never);assert.equal(task.goal,'Make blue');assert.equal(task.goal_revision,1)
 const reopened=new TaskService(f.tasks.path);await reopened.open();assert.equal(reopened.get(task.id).goal,'Make blue');await assert.rejects(reopened.applyDecision(fence(task),reconciliation as never),/task_input_reconciliation_stale/);await reopened.close()
 await assert.rejects(f.tasks.applyDecision(fence(task),{kind:'complete',evidence_refs:['task-work:work']}),/invalid_evidence/)
 }finally{await f.close()}
})

test('identical reconciliation preserves evidence revision while an acceptance change fences old evidence',async()=>{
 const f=await setup();try{
  await f.tasks.bindWork(fence(f.task),'same-work','same-session');await f.tasks.recordWorkOutcome('same-work','ok',{checked:true})
  let same=await f.tasks.controlClient('take-same',fence(f.task),'client','takeover')
  await f.tasks.input('same-input',fence(same),same.controller,'same-session','Keep the goal unchanged',async()=> 'accepted')
  same=await f.tasks.controlClient('return-same',fence(same),'client','return')
  const priorControl=same.control_revision
  same=await f.tasks.applyDecision(fence(same),{kind:'reconcile',input_refs:['same-input'],goal_change:{goal:'original',acceptance:['checked']}})
  assert.equal(same.goal_revision,0);assert.equal(same.control_revision,priorControl+1);assert.deepEqual(same.reconciled_inputs,['same-input'])
  await f.tasks.applyDecision(fence(same),{kind:'complete',evidence_refs:['task-work:same-work']});assert.equal(f.tasks.get(same.id).phase,'completed')

  let changed=await f.tasks.delegate('changed',{conversation_id:'c',goal:'original',acceptance:['checked'],origin_ref:'conversation:2'})
  await f.tasks.bindWork(fence(changed),'changed-work','changed-session');await f.tasks.recordWorkOutcome('changed-work','ok',{checked:true})
  changed=await f.tasks.controlClient('take-changed',fence(changed),'client','takeover')
  await f.tasks.input('changed-input',fence(changed),changed.controller,'changed-session','Also verify audit output',async()=> 'accepted')
  changed=await f.tasks.controlClient('return-changed',fence(changed),'client','return')
  changed=await f.tasks.applyDecision(fence(changed),{kind:'reconcile',input_refs:['changed-input'],goal_change:{goal:'original',acceptance:['checked','audit output']}})
  assert.equal(changed.goal_revision,1)
  await assert.rejects(f.tasks.applyDecision(fence(changed),{kind:'complete',evidence_refs:['task-work:changed-work']}),/invalid_evidence/)
 }finally{await f.close()}
})

test('new accepted steering during reconciliation rejects the stale input cursor and ordinary steering remains context',async()=>{
 const f=await setup();try{await f.tasks.bindWork(fence(f.task),'work','session');await f.tasks.recordWorkOutcome('work','ok',{});let task=await f.tasks.controlClient('take',fence(f.task),'client','takeover')
 await f.tasks.input('one',fence(task),task.controller,'session','Use existing CSS',async()=> 'accepted');await f.tasks.input('two',fence(task),task.controller,'session','Keep keyboard support',async()=> 'accepted');task=await f.tasks.controlClient('return',fence(task),'client','return')
 await assert.rejects(f.tasks.applyDecision(fence(task),{kind:'reconcile',input_refs:['one'],goal_change:null} as never),/task_input_reconciliation_stale/)
 task=await f.tasks.applyDecision(fence(task),{kind:'reconcile',input_refs:['one','two'],goal_change:null} as never);assert.equal(task.goal_revision,0);assert.equal(f.tasks.inputReceipts(task.id).filter(x=>x.status==='accepted').length,2)
 await f.tasks.applyDecision(fence(task),{kind:'complete',evidence_refs:['task-work:work']});assert.equal(f.tasks.get(task.id).phase,'completed')
 }finally{await f.close()}
})

test('work evidence carries bounded actual check observations for the exact work and session, never prose-only proof',async()=>{
 const f=await setup();try{await f.tasks.bindWork(fence(f.task),'work','session');await f.tasks.bindWork(fence(f.task),'other','other-session')
 await f.tasks.appendEvent({task_id:f.task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',item_id:'check',stage:'completed',kind:'tool',text:'{"type":"commandExecution","command":"npm test","exit_code":0,"output":"2 passed"}',refs:[]},'check')
 await f.tasks.appendEvent({task_id:f.task.id,work_id:'other',session_id:'other-session',kind:'tool',stage:'completed',text:'unrelated check',refs:[]},'other')
 await f.tasks.recordWorkOutcome('work','ok',{final_message:'tests passed'});const evidence=f.tasks.evidence(f.task.id)[0] as unknown as {observations?:{work_id:string;session_id:string;text:string}[]}
 assert.equal(evidence.observations?.length,1);assert.equal(evidence.observations?.[0]?.work_id,'work');assert.equal(evidence.observations?.[0]?.session_id,'session');assert.match(evidence.observations?.[0]?.text??'',/2 passed/u)
 await f.tasks.recordWorkOutcome('other','ok',{final_message:'UI passed'});assert.doesNotMatch(JSON.stringify(evidence.observations),/UI passed|unrelated/u)
 }finally{await f.close()}
})

test('reconciling ordinary steering invalidates a verifier started before that reconciliation',async()=>{
 const f=await setup();try{await f.tasks.bindWork(fence(f.task),'work','session');await f.tasks.recordWorkOutcome('work','ok',{});let task=await f.tasks.controlClient('take',fence(f.task),'client','takeover');await f.tasks.input('css',fence(task),task.controller,'session','Use existing CSS',async()=> 'accepted');task=await f.tasks.controlClient('return',fence(task),'client','return');const before=fence(task)
 await f.tasks.applyDecision(before,{kind:'reconcile',input_refs:['css'],goal_change:null});await assert.rejects(f.tasks.applyDecision(before,{kind:'complete',evidence_refs:['task-work:work']}),/stale_task/)
 }finally{await f.close()}
})

test('unknown work arriving after effect admission fences the last dispatch boundary',async()=>{
 const f=await setup();let executed=0;const mark=f.tasks.markEffectDispatching.bind(f.tasks)
 try{await f.tasks.recordDelivery(fence(f.task),'partial','incomplete');f.tasks.markEffectDispatching=async effect=>{await mark(effect);await f.tasks.bindWork(fence(f.tasks.get(f.task.id)),'late');await f.tasks.recordWorkOutcome('late','unknown',{})}
 const loop=new TaskLoop(f.tasks,{evaluate:async()=>({kind:'correct',instruction:'finish',evidence_refs:['task-delivery:partial']}),execute:async()=>{executed++},syncTodo:async()=> 'synced'});await loop.wake(f.task.id);assert.equal(executed,0);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_effect_unknown');await loop.close()
 }finally{await f.close()}
})
