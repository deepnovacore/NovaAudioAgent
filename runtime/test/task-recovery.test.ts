/* eslint-disable @typescript-eslint/require-await -- deterministic adapter and host fixture ports */
/* eslint-disable @typescript-eslint/no-empty-function -- intentionally inert fixture callbacks */
import {VirtualClock} from '../src/core/clock.js'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {TaskService} from '../src/personal-agent/tasks.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
const input={conversation_id:'chat:main',conversation_generation:0,goal:'Repair',acceptance:['Check passes'],origin_ref:'conversation:1',execution_route:'nova'}
const fence=(id:string)=>({task_id:id,control_revision:0,goal_revision:0})
test('restart retries only a known unstarted intent, preserves legacy uncertainty and disconnected control',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'task-recovery-')),path=join(root,'tasks.json'),tasks=new TaskService(path)
 try{await tasks.open();const first=await tasks.delegate('first',input);await tasks.reserveInitial(fence(first.id));const second=await tasks.delegate('second',input);await tasks.reserveInitial(fence(second.id));await tasks.control('take',fence(second.id),{kind:'nova'},{kind:'user',client_id:'offline'});await tasks.close()
  const state=JSON.parse(await readFile(path,'utf8')) as {pending_effects:Record<string,{task_id:string;write_started?:boolean}>};for(const effect of Object.values(state.pending_effects))if(effect.task_id===second.id)delete effect.write_started;await writeFile(path,JSON.stringify(state))
  const restored=new TaskService(path);await restored.open();assert.equal(restored.pendingEffect(first.id),null);assert.equal(restored.pendingEffect(second.id)?.status,'unknown');assert.deepEqual(restored.get(second.id).controller,{kind:'user',client_id:'offline'});await restored.close()
 }finally{await rm(root,{recursive:true,force:true})}
})
test('cancellation without original runtime persists and reports pending physical stop',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'task-recovery-')),host=new PersonalAgentHost({path:join(root,'host.json'),userScope:'test',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null})
 try{await host.open();const task=await host.tasks.delegate('first',input);await host.tasks.bindWork(fence(task.id),'work:1','session:1');const cancelled=await host.cancelTask('cancel',fence(task.id),{kind:'nova'});assert.equal(cancelled.phase,'cancelled');assert.equal(cancelled.waiting_reason,'cancellation_pending');await host.close();await host.open();assert.equal(host.tasks.get(task.id).waiting_reason,'cancellation_pending')}
 finally{await host.close();await rm(root,{recursive:true,force:true})}
})
test('a session transfers only after the original task has finished',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'task-recovery-')),tasks=new TaskService(join(root,'tasks.json'))
 try{await tasks.open();const first=await tasks.delegate('first',input),second=await tasks.delegate('second',input);await tasks.bindWork(fence(first.id),'work:1','session:1');await assert.rejects(tasks.bindWork(fence(second.id),'work:2','session:1'),/session_active/);await tasks.recordWorkOutcome('work:1','ok',{text:'done'});await assert.rejects(tasks.bindWork(fence(second.id),'work:2','session:1'),/session_active/,'an idle but unfinished task keeps its session');await tasks.cancel('stop-first',fence(first.id),{kind:'nova'});await tasks.bindWork(fence(second.id),'work:2','session:1');assert.deepEqual(tasks.get(first.id).session_ids,[]);assert.deepEqual(tasks.get(second.id).session_ids,['session:1'])}
 finally{await tasks.close();await rm(root,{recursive:true,force:true})}
})
test('startup reconstructs original task generation before admission and preserves cleared foreground',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'task-recovery-')),path=join(root,'host.json'),make=()=>new PersonalAgentHost({path,userScope:'test',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null}),first=make();let second:PersonalAgentHost|undefined
 try{await first.open();const task=await first.tasks.delegate('first',input);await first.tasks.bindWork(fence(task.id),'work:1');await first.tasks.recordWorkOutcome('work:1','ok',{text:'done'});await first.command({type:'personal.command',request_id:'clear',method:'conversations.clear',params:{id:'chat:main'}});await first.close()
  second=make();const generations:number[]=[];let evaluate=0
  second.setConversationRuntime(async conversation=>{generations.push(conversation.generation);const host=second!;const port={recover:async()=>null,input:async()=> 'failed' as const,cancel:()=>{},dispatch:async()=>{throw Error('must not execute')},evaluate:async()=>{evaluate++;return {kind:'complete' as const,evidence_refs:host.tasks.evidence(task.id).map(item=>item.ref)}}};host.attachTaskRuntime(conversation.id,conversation.generation,port);return {runTurn:async()=>{throw Error('no fabricated user turn')},close:async()=>{}}},()=>{})
  await second.open();await second.wakeTask(task.id);assert.deepEqual(generations,[0]);assert.equal(evaluate,1);assert.equal(second.tasks.get(task.id).phase,'completed');assert.equal(second.conversationSnapshot().items.find(item=>item.id==='chat:main')!.generation,1);assert.deepEqual(second.conversationSnapshot().messages,[])
 }finally{await first.close();await second?.close();await rm(root,{recursive:true,force:true})}
})
import {McpExecutorAdapter,mcpToolAlias} from '../src/executors/mcp.js'
import type {McpConnection} from '../src/executors/mcp-client.js'
import type {McpServerConfig} from '../src/config/capability-registry.js'
import {context as projectContext} from './fixtures/codex/project-adapter-fixture.js'
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
test('configured same-device MCP serializes while distinct device remains available',async()=>{
 let release!:()=>void,calls=0;const held=new Promise<void>(resolve=>{release=resolve})
 const config=(resource:string):McpServerConfig=>({...{computerUse:{resource}},enabled:true,transport:'stdio',command:'fixture',tools:{read:{enabled:true,timeoutMs:1000,maxResultBytes:4096,maxCallsPerTurn:4}},exposeTo:{frontbrain:true,codex:true}})
 const connection={call:async()=>{calls++;if(calls===1)await held;return {content:[]}}} as unknown as McpConnection
 const tool={name:'read',inputSchema:{type:'object' as const,properties:{}},annotations:{readOnlyHint:true}},first=new McpExecutorAdapter('first',config('host:desktop'),connection,[tool]),second=new McpExecutorAdapter('second',config('host:desktop'),connection,[tool]),other=new McpExecutorAdapter('other',config('host:other'),connection,[tool]);const ctx=projectContext('read',{},new VirtualClock())
 const a=first.dispatch(mcpToolAlias('first','read'),{},ctx);await tick();const b=second.dispatch(mcpToolAlias('second','read'),{},ctx);await tick()
 try{assert.equal(calls,1);await other.dispatch(mcpToolAlias('other','read'),{},ctx);assert.equal(calls,2)}finally{release();await Promise.all([a,b])}assert.equal(calls,3)
})
import {fixture,run,settleWithin} from './fixtures/codex/project-adapter-fixture.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import {prepareManagedCodexMcp} from '../src/executors/codex/managed-mcp.js'
test('managed Codex owns the same configured device as direct MCP for its whole run',async()=>{
 const config={computerUse:{resource:'test:managed-device'},enabled:true,transport:'stdio',command:'fixture',tools:{read:{enabled:true,timeoutMs:1000,maxResultBytes:4096,maxCallsPerTurn:4}},exposeTo:{frontbrain:true,codex:true}}
 const capabilities=parseCapabilityRegistry({version:1,mcpServers:{desktop:config}})
 assert.equal(capabilities.serverStatuses[0]?.status,'configured')
 const value=await fixture({managedMcp:prepareManagedCodexMcp(capabilities)});let release!:()=>void,started!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve}),begun=new Promise<void>(resolve=>{started=resolve});value.factory.onRun=()=>{started()};value.factory.gateFor=()=>gate.then(()=>({classification:'completed',code:'completed',turnStartWritten:true,completion:{status:'completed',final_text:'done',internal_activity:0}}))
 const coding=run(value,'work',{project:'alpha',delegateId:'device-work'});await settleWithin('run',begun)
 const direct=new McpExecutorAdapter('desktop',capabilities.mcpServers.desktop!,{call:async()=>{calls++;return {content:[]}}} as unknown as McpConnection,[{name:'read',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]);const call=direct.dispatch(mcpToolAlias('desktop','read'),{},projectContext('read',{},value.clock));await tick()
 try{assert.equal(calls,0)}finally{release();await coding;await call;await value.adapter.close();await rm(value.root,{recursive:true,force:true})}assert.equal(calls,1)
})
test('task-bound workspace wait retries on real slot release without a second active run',async()=>{
 const value=await fixture();let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),begun=new Promise<void>(resolve=>{started=resolve});value.factory.onRun=()=>{started()};value.factory.gateFor=()=>gate.then(()=>({classification:'completed',code:'completed',turnStartWritten:true,completion:{status:'completed',final_text:'done',internal_activity:0}}))
 const a=run(value,'first',{project:'alpha',delegateId:'work:first'});await settleWithin('run',begun);let waiting!:()=>void;const queued=new Promise<void>(resolve=>{waiting=resolve});const reasons:(string|null)[]=[];const ctx={...projectContext('run',{work_order:'second',project:'alpha',session:'new',title:'Second'},value.clock,{delegateId:'work:second'}),resourceWaiting:async(reason:string|null)=>{reasons.push(reason);if(reason)waiting()}};let settled=false;const b=value.adapter.dispatch('run',ctx.delegate.request,ctx).finally(()=>{settled=true});await settleWithin('queued task',queued)
 try{assert.equal(settled,false);assert.deepEqual(reasons,['busy_project']);assert.equal(value.factory.bindings.length,1)}finally{release();await a;await b;await value.adapter.close();await rm(value.root,{recursive:true,force:true})}assert.equal(value.factory.bindings.length,2)
})
import {CausalRuntime} from '../src/core/causal-runtime.js'
import {MonotonicIdFactory} from '../src/core/ids.js'
import {fixtureSlowSimManifest} from '../eval/sim.js'
test('restored origin authority admits only the exact original task conversation generation',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'task-recovery-')),tasks=new TaskService(join(root,'tasks.json'));await tasks.open()
 try{for(const generation of [0,1]){const runtime=new CausalRuntime({conversationId:'chat:main:'+generation,clock:new VirtualClock(),ids:new MonotonicIdFactory(),models:{},executors:[{manifest:fixtureSlowSimManifest,dispatch:async()=>({outcome:'ok',trust:'trusted_system',content:{}})}]});runtime.memory.restore([{name:'conversation',highWater:1,retentionRevision:0,summary:null,items:[{ordinal:1,recordedAtMs:0,item:{channel:'conversation',seq:1,ts:0,trust:'trusted_user',priority:100,content:{kind:'user_input',text:'Repair'},outcome:null,refs:[]}}]}]);const task=await tasks.delegate('original:'+generation,input),grant=tasks.continuationContext(fence(task.id)),request={executor:'slow_sim',op:'set_light',request:{level:1},origin_ref:input.origin_ref},reason={kind:'realtime_tool',priority:100,routing_class:'user_awaited' as const,origin:null,selected_suggestion:null};assert.equal((await runtime.dispatchTaskExternal(request,reason,grant)).accepted,generation===0);await assert.rejects(runtime.dispatchTaskExternal(request,reason,{...grant}),/invalid_continuation/)}}
 finally{await tasks.close();await rm(root,{recursive:true,force:true})}
})
test('possibly sent effect remains unknown across restart and legacy work has no fabricated fence',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'task-recovery-')),path=join(root,'tasks.json'),tasks=new TaskService(path)
 try{await tasks.open();const task=await tasks.delegate('first',input),effect=await tasks.reserveInitial(fence(task.id));await tasks.markEffectDispatching(effect);await tasks.bindWork(fence(task.id),'work:unknown');await tasks.close();const state=JSON.parse(await readFile(path,'utf8')) as {work_fences?:unknown};delete state.work_fences;await writeFile(path,JSON.stringify(state));const restored=new TaskService(path);await restored.open();assert.equal(restored.pendingEffect(task.id)?.status,'unknown');assert.equal(restored.get(task.id).waiting_reason,'work_fence_unavailable');await assert.rejects(restored.recordWorkOutcome('work:unknown','ok',{}),/work_fence_unavailable/);await restored.close()}
 finally{await rm(root,{recursive:true,force:true})}
})
test('completed pending Todo can be retried through authenticated host without execution or takeover',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'task-recovery-')),host=new PersonalAgentHost({path:join(root,'host.json'),userScope:'test',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null});let syncs=0
 try{await host.open();const task=await host.tasks.delegate('first',{...input,todo_ref:{id:'todo:1',version:1}});await host.tasks.recordDelivery(fence(task.id),'delivery','done');await host.tasks.applyDecision(fence(task.id),{kind:'complete',evidence_refs:['task-delivery:delivery']});host.life.completeTaskTodo=async()=>{syncs++;return 'synced'};const result=await host.command({type:'personal.command',request_id:'retry',method:'tasks.continue',params:fence(task.id)},{client_id:'owner'}) as {ok:boolean};assert.equal(result.ok,true);assert.equal(syncs,1);assert.equal(host.tasks.get(task.id).todo_sync,'synced');assert.equal(host.tasks.get(task.id).phase,'completed')}
 finally{await host.close();await rm(root,{recursive:true,force:true})}
})
import type {CoordinatorDecision} from '../src/executors/coding-executor.js'
test('task intake resolves busy exact workspace while ordinary admission still refuses',async()=>{
 const value=await fixture(),tasks=new TaskService(join(await realpath(value.root),'tasks.json'));await tasks.open();let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),begun=new Promise<void>(resolve=>{started=resolve});value.factory.onRun=()=>{started()};value.factory.gateFor=()=>gate.then(()=>({classification:'completed',code:'completed',turnStartWritten:true,completion:{status:'completed',final_text:'done',internal_activity:0}}));const running=run(value,'first',{project:'alpha',delegateId:'running'});await settleWithin('run',begun)
 try{const task=await tasks.delegate('second',input),grant=tasks.continuationContext(fence(task.id)),decision:CoordinatorDecision={kind:'work',project:'alpha',session:'new'};await assert.rejects(value.adapter.resolveIntakeTarget(decision),/busy_project/);const resolve=value.adapter.resolveIntakeTarget.bind(value.adapter);const target=await resolve(decision,undefined,grant);assert.equal(target.workspace_display_name,'alpha');await assert.rejects(resolve(decision,undefined,{...grant}),/invalid_continuation/)}
 finally{release();await running;await tasks.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})
import {CodexAgentController} from '../src/executors/codex/controller.js'
import type {ExecutorHandoff} from '../src/core/causal-runtime.js'
test('real controller and intake carry task authority to queued workspace execution',async()=>{
 const value=await fixture(),tasks=new TaskService(join(await realpath(value.root),'tasks.json'));await tasks.open();let release!:()=>void,started!:()=>void,waiting!:()=>void,queuedRun:Promise<ExecutorHandoff>|undefined;const gate=new Promise<void>(resolve=>{release=resolve}),begun=new Promise<void>(resolve=>{started=resolve}),queued=new Promise<void>(resolve=>{waiting=resolve});value.factory.onRun=()=>{started()};value.factory.gateFor=()=>gate.then(()=>({classification:'completed',code:'completed',turnStartWritten:true,completion:{status:'completed',final_text:'done',internal_activity:0}}));const running=run(value,'first',{project:'alpha',delegateId:'running'});await settleWithin('run',begun)
 try{const task=await tasks.delegate('second',input),grant=tasks.continuationContext(fence(task.id));const controller=new CodexAgentController({resolveCancelTarget:async()=>null,intake:{clock:value.clock,idFactory:()=> 'intake:queued',settings:{clarification_depth:'balanced',plan_readback:'silent'},models:{assess:async input=>({intake_id:input.intake_id,revision:input.revision,slots:{goal:{state:'stated',note:'Repair'},scope:{state:'stated',note:'alpha'},acceptance:{state:'stated',note:'Checked'},constraints:{state:'missing',note:''}},readiness:1,kind:'work',project:'alpha',project_evidence:'alpha',session:{mode:'new'},intent_to_proceed:true,candidate_question:null,discovery:[],early_exit:false,abandon:false}),plan:async input=>({intake_id:input.intake_id,revision:input.revision,work_order:{objective:'Repair',scope_in:['alpha'],acceptance:['Checked']}}),targets: {resolveIntake: () => Promise.reject(new Error('unexpected target call')), resolveWork: async()=>null}},roster:()=>value.adapter.roster(),running:()=>value.adapter.running(),activeProject:()=> 'alpha',resolveTarget:(decision,taskContext)=>value.adapter.resolveIntakeTarget(decision,undefined,taskContext),prepare:()=>{throw Error('unexpected confirmation')},dispatch:(session,stillWanted)=>{const request={work_order:session.work_order!,project:'alpha',session:'new',title:'Queued'},context={...projectContext('run',request,value.clock,{delegateId:'queued'}),beforeWrite:()=>{if(!stillWanted?.())throw Error('superseded')},resourceWaiting:async(reason:string|null)=>{if(reason)waiting()}};queuedRun=value.adapter.dispatch('run',request,context);return {accepted:true,delegate_id:'queued'}},steer:()=>{throw Error('must not steer another task')},invalidateProposal:()=>{},fact:()=>{},record:()=>{},diagnostic:()=>{}}});await controller.dispatch({continuationGrant:grant,taskContext:grant,instruction:'Repair alpha',originalUserText:'Repair alpha',origin_ref:grant.origin_ref,sessionEpoch:1,acceptedUserInputRevision:1,stillWanted:grant.stillWanted});await settleWithin('intake settles',controller.settleIntakeForTest());await settleWithin('waits for original workspace',queued);assert.equal(value.factory.bindings.length,1);release();await running;assert.equal((await queuedRun)!.outcome,'ok');assert.equal(value.factory.bindings.length,2)}
 finally{release();await running;await queuedRun;await tasks.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {settingsSchema} from '../src/config/config.js'
import {taskResourcesUncertain} from '../src/executors/task-resources.js'
test('restart quarantines cancelled task unknown work, effects and inputs through the production recovery factory',async()=>{
 for(const uncertainty of ['work','effect','input'] as const){
 const root=await mkdtemp(join(await realpath(tmpdir()),'task-review-')),path=join(root,'host.json'),make=()=>new PersonalAgentHost({path,userScope:'test',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null}),first=make(),second=make(),resource='review:'+root
 const capabilities=parseCapabilityRegistry({version:1,mcpServers:{desktop:{transport:'stdio',command:'fixture',computerUse:{resource},tools:{},exposeTo:{frontbrain:true,codex:true}}}}),adapter=new McpExecutorAdapter('desktop',capabilities.mcpServers.desktop!,{call:async()=>{throw Error('must not execute')}} as unknown as McpConnection,[])
 try{await first.open();const task=await first.tasks.delegate('task',{...input,execution_route:'codex'});if(uncertainty==='effect'){const effect=await first.tasks.reserveInitial(fence(task.id));await first.tasks.markEffectDispatching(effect)}else{await first.tasks.bindWork(fence(task.id),'work:unknown','session');await first.tasks.recordWorkOutcome('work:unknown',uncertainty==='work'?'unknown':'ok',{code:'lost_ack'});if(uncertainty==='input')await first.tasks.input('unknown',fence(task.id),{kind:'nova'},'session','possibly sent',async()=> 'unknown')}await first.cancelTask('cancel',fence(task.id),{kind:'nova'});await first.close();assert.equal(taskResourcesUncertain([resource]),false)
  second.setConversationRuntime(conversationRuntimeFactory({host:second,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),capabilities,externalMcp:{capabilities,adapters:[adapter],close:async()=>{}}}),()=>{});await second.open();assert.equal(second.tasks.get(task.id).phase,'cancelled');assert.equal(taskResourcesUncertain([resource]),true)
 }finally{await first.close();await second.close();await rm(root,{recursive:true,force:true})}
 }
})
test('recovery-blocked task rejects exact-session input and grants while control and receipts remain available',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'task-review-')),path=join(root,'host.json'),make=()=>new PersonalAgentHost({path,userScope:'test',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null}),first=make(),second=make();let sent=0
 try{await first.open();const task=await first.tasks.delegate('task',input);await first.tasks.bindWork(fence(task.id),'work:unknown','session');await first.tasks.input('prior',fence(task.id),{kind:'nova'},'session','accepted before restart',async()=> 'accepted');await first.tasks.recordWorkOutcome('work:unknown','unknown',{code:'lost_ack'});await first.close()
  second.setConversationRuntime(async conversation=>{second.attachTaskRuntime(conversation.id,conversation.generation,{recover:async()=>null,input:async()=>{sent++;return 'accepted'},cancel:()=>{},dispatch:async()=>{sent++}});return {runTurn:async()=>{throw Error('must not create turn')},close:async()=>{}}},()=>{});await second.open();const command=(method:string,params:unknown,request_id=method)=>second.command({type:'personal.command',request_id,method,params},{client_id:'client'}) as Promise<{ok:boolean;error?:string}>
  assert.equal((await command('tasks.control',{...fence(task.id),action:'takeover'})).ok,true);const current={...fence(task.id),control_revision:1};const request={...current,session_id:'session',text:'do it again'},result=await command('tasks.input',request);assert.equal(result.ok,false);assert.equal(result.error,'task_recovery_blocked');assert.equal(sent,0);assert.deepEqual(await command('tasks.input',request),result);assert.equal(second.tasks.inputReceipts(task.id).length,1)
  assert.throws(()=>second.tasks.instructionContext(current,{kind:'user',client_id:'client'}),/task_recovery_blocked/);assert.equal(await second.tasks.input('prior',fence(task.id),{kind:'nova'},'session','accepted before restart',async()=>{sent++;return 'accepted'}),'accepted');assert.equal(sent,0);assert.equal((await command('tasks.cancel',current)).ok,true)
 }finally{await first.close();await second.close();await rm(root,{recursive:true,force:true})}
})
test('session transfer refuses unknown work and unknown input independently of terminal phase',async()=>{
 for(const uncertainty of ['work','input'] as const){const root=await mkdtemp(join(await realpath(tmpdir()),'task-review-')),tasks=new TaskService(join(root,'tasks.json'))
 try{await tasks.open();const first=await tasks.delegate('first',input),second=await tasks.delegate('second',input);await tasks.bindWork(fence(first.id),'work','session');await tasks.recordWorkOutcome('work',uncertainty==='work'?'unknown':'ok',{});if(uncertainty==='input')await tasks.input('unknown',fence(first.id),{kind:'nova'},'session','possibly sent',async()=> 'unknown');await tasks.cancel('cancel',fence(first.id),{kind:'nova'});await assert.rejects(tasks.bindWork(fence(second.id),'second-work','session'),/session_active/);assert.deepEqual(tasks.get(first.id).session_ids,['session']);assert.deepEqual(tasks.get(second.id).session_ids,[])}finally{await tasks.close();await rm(root,{recursive:true,force:true})}}
})
