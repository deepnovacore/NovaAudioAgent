import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,rename,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost,announcedGoal} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {TaskRecord} from '../src/personal-agent/tasks.js'

async function fixture(){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-task-control-'))
 const make=()=>new PersonalAgentHost({path:join(dir,'host.json'),userScope:'local',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const host=make();await host.open()
 const command=(method:string,params:object={},request_id:string=crypto.randomUUID(),client_id='A')=>(host.command as (raw:unknown,context:unknown)=>Promise<{ok:boolean;error?:string;data:TaskRecord}> )({type:'personal.command',method,params,request_id},{client_id})
 const delegate=async(id:string)=>{const result=await command('tasks.delegate',{conversation_id:'chat:main',goal:'Deliver '+id,acceptance:['Checked'],origin_ref:'conversation:test'},id);assert.equal(result.ok,true);return result.data}
 const fence=(task:TaskRecord)=>({task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision})
 const take=async(task:TaskRecord,client='A')=>{const result=await command('tasks.control',{...fence(task),action:'takeover'},crypto.randomUUID(),client);assert.equal(result.ok,true);return result.data}
 return {host,make,command,delegate,fence,take,close:async()=>{await host.close();await rm(dir,{recursive:true,force:true})}}
}
test('authenticated task control fences input, deduplicates canonical retries and isolates actors',async()=>{
 const f=await fixture();try{
  const task=await f.delegate('one'),owned=await f.take(task)
  const params={...f.fence(owned),session_id:'session',text:'hello'}
  assert.equal((await f.command('tasks.input',params,'input','B')).error,'not_controller')
  assert.equal((await f.command('tasks.input',{...params,control_revision:0})).error,'stale_task')
  assert.equal((await f.command('tasks.input',params)).error,'session_not_found')
  await f.host.tasks.bindWork(f.fence(owned),'work','session')
  assert.equal((await f.command('tasks.input',params)).error,'task_input_unavailable')
  const control={...f.fence(owned),action:'return'}
  const accepted=await f.command('tasks.control',control,'return')
  assert.deepEqual(await f.command('tasks.control',{action:'return',goal_revision:0,control_revision:1,task_id:owned.id},'return'),accepted)
  assert.equal((await f.command('tasks.control',{...control,action:'takeover'},'return')).error,'request_conflict')
  assert.equal((await f.command('tasks.control',control,'return','B')).error,'stale_task')
  assert.equal((await f.command('tasks.control',{...f.fence(accepted.data),action:'takeover',client_id:'B'})).ok,false)
 }finally{await f.close()}
})
test('explicit mode exit returns only this client tasks with durable retry receipts and preserves approvals',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'})
  const a=await f.take(await f.delegate('a')),b=await f.take(await f.delegate('b')),other=await f.take(await f.delegate('other'),'B')
  const approval={pending_approval:true,pending_approval_id:'approval',operation_summary:'Pending',queued:1}
  f.host.setApprovalView(()=>approval as never)
  const before=f.host.snapshot().pending_approvals
  const reply=await f.command('presentation.set',{mode:'orb'},'exit')
  assert.equal(reply.ok,true)
  assert.deepEqual(reply.data,{mode:'orb',returned_task_ids:[a.id,b.id],task_control_revisions:{[a.id]:2,[b.id]:2}})
  for(const task of [a,b]){assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'});assert.equal(f.host.tasks.get(task.id).control_revision,2)}
  assert.deepEqual(f.host.tasks.get(other.id),other)
  assert.deepEqual(f.host.snapshot().pending_approvals,before)
  assert.deepEqual(await f.command('presentation.set',{mode:'orb'},'exit'),reply)
  await f.host.close();const reopened=f.make();await reopened.open()
  try{assert.deepEqual(await (reopened.command as (v:unknown,c:unknown)=>Promise<unknown>)({type:'personal.command',method:'presentation.set',request_id:'exit',params:{mode:'orb'}},{client_id:'A'}),reply);assert.equal(reopened.tasks.get(a.id).control_revision,2)}finally{await reopened.close()}
 }finally{await f.close()}
})
test('handback failure suppresses background capture but stays pending and same request retries',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'});const task=await f.take(await f.delegate('a'))
  const path=f.host.tasks.path
  await rename(path,path+'.saved');await mkdir(path)
  const modes:string[]=[];f.host.subscribePresentation(mode=>{modes.push(mode)})
  const failed=await f.command('presentation.set',{mode:'background'},'exit')
  assert.equal(failed.ok,false);assert.equal(failed.error,'handback_pending');assert.equal(f.host.presentationMode,'background')
  assert.deepEqual(modes,['background']);assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'user',client_id:'A'})
  await rm(path,{recursive:true});await rename(path+'.saved',path)
  assert.equal((await f.command('presentation.set',{mode:'background'},'exit')).ok,true)
  assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'})
 }finally{await f.close()}
})
test('disconnect and browsing retain ownership; another authenticated surface may explicitly return',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'});const task=await f.take(await f.delegate('a'))
  assert.equal((await f.command('tasks.control',{...f.fence(task),action:'takeover'},'steal','B')).error,'not_controller')
  await f.command('tasks.get',{task_id:task.id});await f.command('tasks.list')
  assert.equal((await f.command('presentation.set',{mode:'orb',action:'collapse'})).ok,false)
  assert.equal((await f.command('presentation.set',{mode:'orb',action:'blur'})).ok,false)
  await f.host.disconnectPresentation()
  assert.equal(f.host.presentationMode,'background');assert.deepEqual(f.host.tasks.get(task.id),task)
  assert.equal((await f.host.command({type:'personal.command',method:'tasks.list',request_id:'anonymous',params:{}}) as {error:string}).error,'unauthenticated')
  assert.equal((await f.command('tasks.control',{...f.fence(task),action:'return'},'recover','B')).ok,true)
  await f.command('presentation.set',{mode:'workbench'})
  assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'})
  assert.equal(f.host.snapshot().capabilities.tasks.input,false)
 }finally{await f.close()}
})
test('durable service transition receipt survives missing host receipt and later controller changes',async()=>{
 const f=await fixture();try{
  const task=await f.delegate('a'),fence=f.fence(task)
  const delegated=await f.host.tasks.delegate('service-delegate',{conversation_id:'chat:main',goal:'snapshot',acceptance:[],origin_ref:'user'})
  await f.host.tasks.controlClient('service-take',f.fence(delegated),'A','takeover')
  assert.deepEqual(await f.host.tasks.delegate('service-delegate',{conversation_id:'chat:main',goal:'snapshot',acceptance:[],origin_ref:'user'}),delegated)
  const accepted=await f.host.tasks.controlClient('service-retry',fence,'A','takeover')
  await f.host.tasks.returnClientTasks('handback','A')
  assert.deepEqual(await f.host.tasks.controlClient('service-retry',fence,'A','takeover'),accepted)
  assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'})
  assert.equal((await f.host.tasks.returnClientTasks('handback','A')).find(item=>item.id===task.id)?.control_revision,2)
  assert.equal(f.host.tasks.get(task.id).control_revision,2)
 }finally{await f.close()}
})
test('shared remote master can explicitly recover control but cannot acquire it',async()=>{
 const f=await fixture();try{
  const task=await f.take(await f.delegate('master'))
  const master=(action:string,record:TaskRecord)=>f.host.command({type:'personal.command',method:'tasks.control',request_id:crypto.randomUUID(),params:{...f.fence(record),action}},{client_id:'remote:master',can_takeover:false}) as Promise<{ok:boolean;error?:string;data:TaskRecord}>
  assert.equal((await master('takeover',task)).error,'task_control_unavailable')
  const returned=await master('return',task);assert.equal(returned.ok,true)
  assert.equal((await master('takeover',returned.data)).error,'task_control_unavailable')
  assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'})
 }finally{await f.close()}
})
test('disconnect background safety runs after an in-flight explicit mode transition',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'})
  let release!:()=>void,entered!:()=>void
  const hold=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
  const original=f.host.tasks.returnClientTasks.bind(f.host.tasks)
  f.host.tasks.returnClientTasks=async(...args)=>{entered();await hold;return original(...args)}
  const exit=f.command('presentation.set',{mode:'orb'});await started
  const disconnect=f.host.disconnectPresentation();release();await exit;await disconnect
  assert.equal(f.host.presentationMode,'background')
 }finally{await f.close()}
})
test('failed presentation synchronization retains canonical request identity through retry, eviction and restart',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'})
  const task=await f.take(await f.delegate('identity'))
  let fail=true
  f.host.subscribePresentation(()=>{if(fail)throw Error('listener unavailable')})
  assert.equal((await f.command('presentation.set',{mode:'orb'},'exit-identity')).error,'presentation_sync_failed')
  assert.equal(f.host.tasks.get(task.id).control_revision,2)
  fail=false
  for(const mode of ['background','workbench'])assert.equal((await f.command('presentation.set',{mode},'exit-identity')).error,'request_conflict')
  assert.equal((await f.command('presentation.set',{mode:'orb'},'exit-identity')).ok,true)
  assert.equal(f.host.tasks.get(task.id).control_revision,2)
  for(let i=0;i<256;i++)await f.command('tasks.list',{},'evict:'+i)
  await f.host.close();const restored=f.make();await restored.open()
  try{
   const retry=(mode:string)=>restored.command({type:'personal.command',method:'presentation.set',request_id:'exit-identity',params:{mode}},{client_id:'A'}) as Promise<{ok:boolean;error?:string}>
   for(const mode of ['workbench','background'])assert.equal((await retry(mode)).error,'request_conflict')
   assert.equal((await retry('orb')).ok,true)
   assert.equal(restored.tasks.get(task.id).control_revision,2)
  }finally{await restored.close()}
 }finally{await f.close()}
})
test('workbench synchronization failures also reserve their request before retry',async()=>{
 const f=await fixture();try{
  let fail=true
  f.host.subscribePresentation(()=>{if(fail)throw Error('listener unavailable')})
  assert.equal((await f.command('presentation.set',{mode:'workbench'},'enter-identity')).error,'presentation_sync_failed')
  fail=false
  assert.equal((await f.command('presentation.set',{mode:'orb'},'enter-identity')).error,'request_conflict')
  assert.equal((await f.command('presentation.set',{mode:'workbench'},'enter-identity')).ok,true)
 }finally{await f.close()}
})

test('detail exposes authenticated viewer and reconciles only that client exact input receipt',async()=>{
 const f=await fixture();try{const task=await f.take(await f.delegate('detail'));await f.host.tasks.bindWork(f.fence(task),'work','session')
 const {createHash}=await import('node:crypto'),request_id='exact',key=createHash('sha256').update(JSON.stringify({client:'A',request:request_id})).digest('hex')
 await f.host.tasks.input(key,f.fence(task),{kind:'user',client_id:'A'},'session','hello',()=>Promise.resolve('accepted'))
 const read=async(client_id:string)=>f.host.command({type:'personal.command',request_id:crypto.randomUUID(),method:'tasks.get',params:{task_id:task.id,input_request_id:request_id}},{client_id,can_takeover:false}) as Promise<{ok:boolean;data:{viewer:{client_id:string;can_takeover:boolean};input_receipt?:{request_id:string;status:string}}}>
 const a=await read('A');assert.equal(a.ok,true);assert.deepEqual(a.data.viewer,{client_id:'A',can_takeover:false});assert.deepEqual(a.data.input_receipt,{request_id:'exact',status:'accepted'});assert.equal((await read('B')).data.input_receipt,undefined)
 }finally{await f.close()}
})

test('accepted input with failed status persistence remains unknown and cannot be submitted twice',async()=>{
 const f=await fixture();let writes=0,damaged=false
 const path=f.host.tasks.path,backup=path+'.before-status'
 try{const task=await f.take(await f.delegate('persist-failure'));await f.host.tasks.bindWork(f.fence(task),'work','session')
 f.host.attachTaskRuntime('chat:main',0,{input:async()=>{writes++;await rename(path,backup);await mkdir(path);damaged=true;return 'accepted'},cancel(){/* no active executor */},dispatch:()=>Promise.resolve()})
 const params={...f.fence(task),session_id:'session',text:'send once'},raw={type:'personal.command',request_id:'persist-failure-input',method:'tasks.input',params}
 const result=await f.host.command(raw,{client_id:'A'}) as {ok:boolean;input_status:string};assert.equal(result.ok,false);assert.equal(result.input_status,'unknown');assert.equal(writes,1)
 await rm(path,{recursive:true});await rename(backup,path);damaged=false
 const read=await f.host.command({type:'personal.command',request_id:'reconcile-persistence',method:'tasks.get',params:{task_id:task.id,input_request_id:raw.request_id}},{client_id:'A'}) as {data:{input_receipt:{request_id:string;status:string}}}
 assert.deepEqual(read.data.input_receipt,{request_id:raw.request_id,status:'unknown'});await f.host.command(raw,{client_id:'A'});assert.equal(writes,1)
 const stale={...raw,request_id:'stale-input',params:{...params,control_revision:0}},rejected=await f.host.command(stale,{client_id:'A'}) as {input_status:string};assert.equal(rejected.input_status,'failed')
 const failure=await f.host.command({type:'personal.command',request_id:'reconcile-stale',method:'tasks.get',params:{task_id:task.id,input_request_id:stale.request_id}},{client_id:'A'}) as {data:{input_receipt:{status:string}}};assert.equal(failure.data.input_receipt.status,'failed')
 }finally{if(damaged){await rm(path,{recursive:true});await rename(backup,path)}await f.close()}
})

test('input acknowledgement settling after handback wakes reconciliation even without another work outcome',async()=>{
 const f=await fixture();let accept!:(status:'accepted')=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve}),receipt=new Promise<'accepted'>(resolve=>{accept=resolve})
 try{const task=await f.delegate('late-input');await f.host.tasks.bindWork(f.fence(task),'finished','session');await f.host.tasks.recordWorkOutcome('finished','ok',{result:'done'});const owned=await f.take(task)
 f.host.attachTaskRuntime('chat:main',0,{input:()=>{entered();return receipt},cancel:()=>undefined,dispatch:()=>Promise.reject(Error('must not dispatch')),evaluate:current=>{const pending=f.host.tasks.pendingUserInputs(current.id);return Promise.resolve(pending.length?{kind:'reconcile',input_refs:pending.map(input=>input.request_id),goal_change:null}:{kind:'complete',evidence_refs:['task-work:finished']})}})
 const input=f.command('tasks.input',{...f.fence(owned),session_id:'session',text:'Keep keyboard support'},'late-ack');await started
 await f.command('tasks.control',{...f.fence(owned),action:'return'});await f.host.taskLoop.wake(task.id);assert.equal(f.host.tasks.get(task.id).waiting_reason,'task_effect_unknown')
 accept('accepted');assert.equal((await input).ok,true)
 for(let i=0;i<50&&f.host.tasks.get(task.id).phase!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,10))
 assert.equal(f.host.tasks.get(task.id).phase,'completed');assert.equal(f.host.tasks.get(task.id).goal_revision,0)
 }finally{accept?.('accepted');await f.close()}
})

test('a user unblocks a waiting task without taking over: reconcile unknown work, continue, or stop',async()=>{
 const f=await fixture();try{
  const task=await f.delegate('unknown-effect');assert.equal(task.phase,'waiting');assert.deepEqual(task.controller,{kind:'nova'})
  await f.host.tasks.bindWork(f.fence(f.host.tasks.get(task.id)),'lost','session');await f.host.tasks.recordWorkOutcome('lost','unknown',{result:'transport closed'})
  await f.host.tasks.wait(f.fence(f.host.tasks.get(task.id)),'task_effect_unknown')
  let current=f.host.tasks.get(task.id)
  const caps=await f.command('tasks.get',{task_id:task.id}) as unknown as {data:{capabilities:{reconcile:boolean}}};assert.equal(caps.data.capabilities.reconcile,true)
  assert.equal((await f.command('tasks.continue',f.fence(current))).error,'task_effect_unknown')
  const reconciled=await f.command('tasks.reconcile',{...f.fence(current),resolution:'not_run'},'reconcile')
  assert.equal(reconciled.ok,true);assert.equal(reconciled.data.waiting_reason,'user_reconciled');assert.deepEqual(reconciled.data.controller,{kind:'nova'})
  assert.equal(f.host.tasks.hasUnknownWork(task.id),false);assert.equal(f.host.tasks.needsReconcile(task.id),false)
  assert.equal((await f.command('tasks.reconcile',{...f.fence(reconciled.data),resolution:'done'})).error,'nothing_to_reconcile')
  current=f.host.tasks.get(task.id)
  const continued=await f.command('tasks.continue',f.fence(current))
  assert.equal(continued.ok,true);assert.deepEqual(continued.data.controller,{kind:'nova'});assert.notEqual(continued.data.phase,'waiting')
  const stopped=await f.command('tasks.cancel',f.fence(f.host.tasks.get(task.id)))
  assert.equal(stopped.ok,true);assert.equal(stopped.data.phase,'cancelled')
 }finally{await f.close()}
})

test('another client that holds control still blocks stop, continue and reconcile',async()=>{
 const f=await fixture();try{
  const queued=await f.host.tasks.delegate('queued',{conversation_id:'chat:main',goal:'Queued',acceptance:['Checked'],origin_ref:'conversation:test'})
  assert.equal(queued.phase,'queued');assert.equal((await f.command('tasks.continue',f.fence(queued))).error,'not_controller','continue only unblocks a waiting task')
  const task=await f.delegate('held'),owned=await f.take(task,'B')
  for(const [method,params] of [['tasks.cancel',f.fence(owned)],['tasks.continue',f.fence(owned)],['tasks.reconcile',{...f.fence(owned),resolution:'done'}]] as const)
   assert.equal((await f.command(method,params,crypto.randomUUID(),'A')).error,'not_controller',method)
 }finally{await f.close()}
})

test('a user closes a Todo whose task scope changed; nothing else can complete it',async()=>{
 const f=await fixture();try{
  const todo=await f.host.life.mutate({op:'create',kind:'todo',title:'Ship login'},'todo')
  const task=await f.host.tasks.delegate('scoped',{conversation_id:'chat:main',goal:'Ship login',acceptance:['Checked'],origin_ref:'conversation:test',todo_ref:{id:todo.id,version:todo.version}})
  assert.equal((await f.command('tasks.complete_todo',{...f.fence(task),todo_version:todo.version})).error,'todo_not_in_conflict')
  await f.host.tasks.bindWork(f.fence(task),'w','session');await f.host.tasks.recordWorkOutcome('w','ok',{result:'done'})
  await f.host.tasks.applyDecision(f.fence(f.host.tasks.get(task.id)),{kind:'complete',evidence_refs:['task-work:w']})
  await f.host.life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,note:'edited elsewhere'},'edit')
  const done=f.host.tasks.get(task.id);await f.host.tasks.markTodoSync(task.id,done.goal_revision,'conflict')
  const caps=await f.command('tasks.get',{task_id:task.id}) as unknown as {data:{capabilities:{todo_conflict:boolean}}};assert.equal(caps.data.capabilities.todo_conflict,true)
  const reviewed=f.host.life.snapshot().todos.find(item=>item.id===todo.id)!
  await f.host.life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:reviewed.version,note:'expanded after review'},'expand')
  assert.equal((await f.command('tasks.complete_todo',{...f.fence(done),todo_version:reviewed.version})).error,'todo_changed','an unseen revision needs a fresh review')
  const current=f.host.life.snapshot().todos.find(item=>item.id===todo.id)!
  const resolved=await f.command('tasks.complete_todo',{...f.fence(done),todo_version:current.version})
  assert.equal(resolved.ok,true);assert.equal(resolved.data.todo_sync,'synced')
  assert.equal(f.host.life.snapshot().todos.find(item=>item.id===todo.id)?.status,'done')
 }finally{await f.close()}
})

test('reconcile refuses execution still in flight and a late settle cannot overwrite the user',async()=>{
 const f=await fixture();try{
  const task=await f.host.tasks.delegate('live',{conversation_id:'chat:main',goal:'Live',acceptance:['Checked'],origin_ref:'conversation:test'})
  const effect=await f.host.tasks.reserveInitial(f.fence(task));await f.host.tasks.markEffectDispatching(effect);await f.host.tasks.resourceState(task.id,'waiting_for_resource')
  const waiting=f.host.tasks.get(task.id);assert.equal(waiting.phase,'waiting')
  assert.equal((await f.command('tasks.reconcile',{...f.fence(waiting),resolution:'not_run'})).error,'execution_in_flight')
  await f.host.tasks.settleEffect(effect,'unknown');await f.host.tasks.wait(f.fence(waiting),'task_execution_unconfirmed')
  const settled=await f.command('tasks.reconcile',{...f.fence(f.host.tasks.get(task.id)),resolution:'done'});assert.equal(settled.ok,true)
  await f.host.tasks.settleEffect(effect,'unknown');assert.equal(f.host.tasks.pendingEffect(task.id),null,'a late settle keeps the user resolution')
  assert.ok(f.host.tasks.evidence(task.id).some(item=>item.ref==='task-attested:'+effect&&item.outcome==='ok'),'a confirmed step is verified, not re-dispatched')
 }finally{await f.close()}
})

test('the spoken completion line keeps only a short form of a long goal',()=>{
 assert.equal(announcedGoal('修复登录页。然后补测试并更新文档'),'修复登录页')
 const long=announcedGoal('把'.repeat(80));assert.equal([...long].length,40);assert.ok(long.endsWith('…'))
 assert.equal(announcedGoal('Fix login'),'Fix login')
})

test('recovery leaves non-task commands open, and a reconciled uncertain task resumes after continue',async()=>{
 const f=await fixture();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});let hold=true,evaluated=0
 try{
  const task=await f.delegate('recover');await f.host.tasks.bindWork(f.fence(task),'lost','session');await f.host.tasks.recordWorkOutcome('lost','unknown',{result:'transport closed'})
  f.host.attachTaskRuntime('chat:main',0,{input:()=>Promise.resolve('accepted' as const),cancel:()=>undefined,dispatch:()=>Promise.reject(Error('must not dispatch')),recover:async()=>{if(hold)await held;return null},evaluate:()=>{evaluated++;return Promise.resolve({kind:'complete' as const,evidence_refs:['task-work:lost'],criteria:[{index:0,evidence_refs:['task-work:lost']}]})}})
  const recovering=f.host.recoverTasks()
  assert.equal((await f.command('state')).ok,true,'state stays available during recovery')
  assert.equal((await f.command('presentation.set',{mode:'orb'})).ok,true,'presentation stays available during recovery')
  assert.equal((await f.command('tasks.continue',f.fence(f.host.tasks.get(task.id)))).error,'task_recovery_in_progress')
  hold=false;release();await recovering
  let current=f.host.tasks.get(task.id);assert.equal(current.waiting_reason,'uncertain_recovery')
  current=(await f.command('tasks.reconcile',{...f.fence(current),resolution:'done'})).data
  const continued=await f.command('tasks.continue',f.fence(current));assert.equal(continued.error,undefined);assert.equal(continued.ok,true)
  for(let i=0;i<50&&f.host.tasks.get(task.id).phase!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(f.host.tasks.get(task.id).phase,'completed');assert.ok(evaluated>=1)
 }finally{release();await f.close()}
})
