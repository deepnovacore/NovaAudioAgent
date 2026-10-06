/* eslint-disable @typescript-eslint/require-await -- deterministic fake host ports use Promise contracts */
/* eslint-disable @typescript-eslint/no-empty-function -- inert fake callbacks and disabled providers */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {stat,mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {RealtimeService} from '../src/realtime/service.js'
import {TaskService} from '../src/personal-agent/tasks.js'
import {compileToolSchema} from '../src/core/tool-schema.js'

/** A verifier reply that maps every acceptance criterion to the given evidence. */
const completeWith=(prompt:string,refs:string[])=>({kind:'complete',evidence_refs:refs,criteria:((JSON.parse(prompt) as {task:{acceptance:string[]}}).task.acceptance).map((_,index)=>({index,evidence_refs:refs}))})

test('Nova-only task tools are advertised independently of executor agents',()=>{
 const tools=compileToolSchema([], {includeTasks:true})
 assert.equal(tools.bindings.get('task')?.kind,'host')
})
test('task mutations notify their host and terminal lifecycle fences writes',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-dispatch-'))
 try{
  let changes=0
  const tasks=new (TaskService as unknown as new(path:string,changed:()=>void)=>TaskService)(join(dir,'tasks.json'),()=>changes++)
  await tasks.open()
  await tasks.delegate('declare',{conversation_id:'chat:main',goal:'deliver',acceptance:['content'],origin_ref:'user:original'})
  assert.equal(changes,1)
 }finally{await rm(dir,{recursive:true,force:true})}
})

import {CodexAgentController} from '../src/executors/codex/controller.js'
import type {IntakeOptions,IntakeSession} from '../src/executors/coding/intake.js'
test('deferred task planning survives foreground clear but takeover fences every session',async()=>{
 for(const action of ['takeover','foreground_clear']){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-race-'))
 try{
  const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
  const task=await tasks.delegate('declare',{conversation_id:'chat:main',goal:'Fix login',acceptance:['Shows validation'],origin_ref:'conversation:original'})
  const fence={task_id:task.id,goal_revision:0,control_revision:0}
  await tasks.bindWork(fence,'work1','session1');await tasks.bindWork(fence,'work2','session2')
  const context=tasks.continuationContext(fence)
  let release!:()=>void,entered!:()=>void,writes=0,foregroundCurrent=true
  const planned=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const intake:IntakeOptions={idFactory:()=> 'intake',settings:{clarification_depth:'balanced',plan_readback:'silent'},models:{
   assess:async input=>({intake_id:input.intake_id,revision:input.revision,slots:{goal:{state:'stated',note:'Fix login'},scope:{state:'stated',note:'Login'},acceptance:{state:'stated',note:'Shows validation'},constraints:{state:'missing',note:''}},readiness:1,kind:'work',project:null,project_evidence:null,session:{mode:'latest'},intent_to_proceed:true,candidate_question:null,discovery:[],early_exit:false,abandon:false}),
   plan:async input=>{entered();await gate;return {intake_id:input.intake_id,revision:input.revision,work_order:{objective:'Fix login',scope_in:['Login'],acceptance:['Shows validation']}}},targets: {resolveIntake: () => Promise.reject(new Error('unexpected target call')), resolveWork: async()=>null}},
   roster:()=>[],running:()=>[],activeProject:()=> 'Project',resolveTarget:async()=>({workspace:'/project',action:'reuse',workspace_display_name:'Project',workspace_id:'project',session_title:null,session_id:null}),prepare:()=>{throw Error('unexpected')},dispatch:()=>{writes++;return {accepted:true,delegate_id:'write'}},steer:()=>{writes++;return {accepted:true}},invalidateProposal:()=>{},fact:()=>{},record:()=>{},diagnostic:()=>{}}
  const controller=new CodexAgentController({intake,resolveCancelTarget:async()=>null})
  await controller.dispatch({taskContext:context,instruction:'Fix login',originalUserText:'Fix login',origin_ref:context.origin_ref,sessionEpoch:1,acceptedUserInputRevision:1,stillWanted:()=>foregroundCurrent})
  await planned
  const answer={taskContext:context,instruction:'Fix login with email',originalUserText:'Email login',origin_ref:context.origin_ref,input_origin_ref:'conversation:answer',sessionEpoch:1,acceptedUserInputRevision:2,stillWanted:()=>foregroundCurrent}
  await controller.dispatch(answer)
  assert.equal(controller.inspectIntakeForTest()?.revision,2)
  assert.equal(controller.inspectIntakeForTest()?.origin_ref,context.origin_ref)
  await controller.dispatch(answer)
  assert.equal(controller.inspectIntakeForTest()?.revision,2,'same current answer is deduplicated')
  if(action==='takeover')await tasks.controlClient('takeover',fence,'client','takeover');else foregroundCurrent=false
  release();await controller.settleIntakeForTest()
  assert.equal(writes,action==='takeover'?0:1)
  assert.equal(context.stillWanted(),action!=='takeover')
  assert.equal(controller.inspectIntakeForTest()?.origin_ref,'conversation:original')
  assert.deepEqual(tasks.get(task.id).session_ids,['session1','session2'])
 }finally{await rm(dir,{recursive:true,force:true})}
 }
})

import {dispatchTurn,realtimeServiceHarness} from './support/realtime-service-harness.js'
test('production task tool declares Nova-only work from final user input and validates selected sources',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-model-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 const {service}=realtimeServiceHarness('pipeline',{taskHost:{tasks,conversation_id:'chat:main',conversation_generation:4}})
 try{
  await service.connect()
  const accepted=await dispatchTurn(service,'task',{operation:'declare',goal:'Write a plan',acceptance:['Three steps'],source_refs:[],origin_ref:'conversation:1'})
  assert.equal(accepted.accepted,true)
  assert.equal(tasks.list().length,1)
  assert.equal(tasks.list()[0]?.origin_ref,'conversation:1')
  assert.equal(tasks.list()[0]?.conversation_generation,4)
  assert.deepEqual(tasks.list()[0]?.session_ids,[])
  const other=realtimeServiceHarness('pipeline',{taskHost:{tasks,conversation_id:'chat:main'}}).service;await other.connect()
  const refused=await dispatchTurn(other,'task',{operation:'declare',goal:'Another plan',acceptance:[],source_refs:['fake:1'],origin_ref:'conversation:2'},'invalid')
  assert.equal(refused.accepted,false);await other.close()
  assert.equal(tasks.list().length,1)
 }finally{await service.close();await tasks.close();await rm(dir,{recursive:true,force:true})}
})
test('uncertain targeted input is durable and never blindly resent; delayed input loses authority on return',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-input-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 try{
  const task=await tasks.delegate('delegate',{conversation_id:'c',goal:'Goal',acceptance:[],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:0,goal_revision:0},actor={kind:'user' as const,client_id:'client'}
  await tasks.bindWork(fence,'work','session');await tasks.controlClient('take',fence,'client','takeover');fence.control_revision=1
  let sends=0
  const send=async()=>{sends++;return 'unknown' as const}
  assert.equal(await tasks.input('message',fence,actor,'session','hello',send),'unknown')
  assert.equal(await tasks.input('message',fence,actor,'session','hello',send),'unknown')
  assert.equal(sends,1)
  await assert.rejects(tasks.input('forged',fence,actor,'other-session','hello',send),/session_not_found/)
  let release!:()=>void,entered!:()=>void,writes=0
  const waiting=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const pending=tasks.input('delayed',fence,actor,'session','later',async grant=>{entered();await gate;if(!grant.stillWanted())return 'failed';writes++;return 'accepted'})
  await waiting;await tasks.returnClientTasks('mode-exit','client');release()
  assert.equal(await pending,'failed');assert.equal(writes,0)
  await tasks.close();const restored=new TaskService(tasks.path);await restored.open()
  assert.equal(await restored.input('message',fence,actor,'session','hello',send),'unknown');assert.equal(sends,1)
  const current=restored.get(task.id);await restored.cancel('cancel',{...fence,control_revision:current.control_revision},{kind:'nova'})
  assert.throws(()=>restored.continuationContext({...fence,control_revision:current.control_revision}),/task_terminal/)
  await restored.close()
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {settingsSchema} from '../src/config/config.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {codingAgentControllerFactory,CODEX_AGENT_DESCRIPTOR} from '../src/executors/codex/controller.js'
import {hostCodexHomeValue} from '../src/executors/codex/process-owner.js'
import {fixture,COMPLETE,settleWithin,context,run} from './fixtures/codex/project-adapter-fixture.js'
import type {TransportOutcome} from '../src/executors/codex/app-server-transport.js'
import {setTimeout as delay} from 'node:timers/promises'
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await delay(10)}assert.fail('condition did not settle')}

test('conversation task verification reconciles accepted takeover input before checking the revised goal',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-handback-verifier-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const prompts:{task:{goal:string;goal_revision:number};accepted_user_inputs:{request_id:string;text:string}[];unreconciled_input_refs:string[];evidence:unknown[]}[]=[]
 try{
  await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>undefined,
   settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),
   searchTransport:{search:async()=>{throw Error('unexpected search')}},
   gateway:{complete:async request=>{
    const prompt=JSON.parse(request.prompt) as typeof prompts[number];prompts.push(prompt)
    assert.deepEqual(prompt.accepted_user_inputs,[{request_id:'blue',text:'Change the goal to blue'}])
    if(prompt.unreconciled_input_refs.length){assert.deepEqual(prompt.unreconciled_input_refs,['blue']);return {text:JSON.stringify({kind:'reconcile',input_refs:['blue'],goal_change:{goal:'Make blue',acceptance:['blue observed']}})}}
    assert.equal(prompt.task.goal,'Make blue');assert.equal(prompt.task.goal_revision,1);assert.deepEqual(prompt.evidence,[])
    return {text:JSON.stringify({kind:'wait',reason:'Need observations for the revised blue goal',evidence_refs:[]})}
   },async *stream(){throw Error('unexpected stream')}},
   createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({
    async *stream(){yield {kind:'response_started',response_id:'ready'};yield {kind:'text_delta',text:'ready'};yield {kind:'response_completed',response_id:'ready'}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{},
   })})}}),
  }),()=>{})
  await host.submitConversationText('chat:main','Prepare the task runtime')
  await until(()=>host.conversationSnapshot().messages.some(message=>message.role==='assistant'))
  let task=await host.tasks.delegate('declare',{conversation_id:'chat:main',conversation_generation:0,goal:'Make red',acceptance:['red observed'],origin_ref:'conversation:1'})
  const fence=()=>({task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision})
  await host.tasks.bindWork(fence(),'work','session');task=await host.tasks.controlClient('take',fence(),'client','takeover')
  await host.tasks.input('blue',fence(),task.controller,'session','Change the goal to blue',async()=> 'accepted')
  await host.tasks.input('failed',fence(),task.controller,'session','Change the goal to green',async()=> 'failed')
  await host.tasks.recordWorkOutcome('work','ok',{final_message:'blue'})
  task=await host.tasks.controlClient('return',fence(),'client','return');await host.wakeTask(task.id)
  const current=host.tasks.get(task.id)
  assert.equal(prompts.length,2);assert.equal(prompts[0]!.task.goal,'Make red');assert.equal(current.goal,'Make blue');assert.equal(current.goal_revision,1)
  assert.deepEqual(current.reconciled_inputs,['blue']);assert.equal(current.corrections,0);assert.equal(current.waiting_reason,'Need observations for the revised blue goal')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('real scoped task executor survives conversation clear, targeted input and cancel retain its original session',async()=>{
 const value=await fixture({preexistingSession:true})
 const host=new PersonalAgentHost({path:join(await realpath(value.root),'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let release!:(outcome:TransportOutcome)=>void
 let providerResponse=0
 let captured:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined,intakePort:IntakeOptions|undefined
 try{
  await host.open();await value.adapter.initialize()
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,
   settings:settingsSchema.parse({executors:['codex'],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),
   codexResource:{mode:'project',adapter:value.adapter,agentDescriptor:CODEX_AGENT_DESCRIPTOR,agentControllerFactory:{create:context=>{intakePort=context.intake;return codingAgentControllerFactory.create(context)}},projectView:null,approvalController:null,start:async()=>{},close:async()=>{}},
   searchTransport:{search:async()=>{throw Error('unexpected search')}},
   gateway:{complete:async()=>{throw Error('unexpected model')},async *stream(){throw Error('unexpected stream')}},
   onDiagnostic:()=>{},
   createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({
    async *stream(){const responseId='response:'+ ++providerResponse;yield {kind:'response_started',response_id:responseId};yield {kind:'text_delta',text:'ready'};yield {kind:'response_completed',response_id:responseId}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{},
   })})}}),
  })
  host.setConversationRuntime(async(...args)=>{captured=await factory(...args);return captured},()=>{})
  await host.submitConversationText('chat:main','Work on the existing task')
  await until(()=>host.conversationSnapshot().messages.some(message=>message.role==='assistant'))
  const task=await host.tasks.delegate('declared',{conversation_id:'chat:main',conversation_generation:0,goal:'Complete the task',acceptance:['Verified result'],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:0,goal_revision:0},workspace=await value.store.resolveWorkspace('alpha')
  const session=(await value.store.listSessions(workspace))[0]!
  await host.tasks.bindWork(fence,'prior-work',session.session_id)
  value.factory.runGate=new Promise(resolve=>{release=resolve})
  const admission=await host.continueTask(host.tasks.continuationContext(fence),'Execute task',session.session_id) as {accepted:boolean}
  assert.equal(admission.accepted,true)
  await until(()=>value.factory.transports[0]?.workOrders.length===1)
  assert.equal(value.factory.bindings[0]?.resumeThreadId,'thread-existing')
  const originalHome=hostCodexHomeValue(value.factory.bindings[0].codexHome).path
  assert.ok(intakePort)
  const legacy={origin_ref:task.origin_ref} as IntakeSession
  assert.equal((await intakePort.steer(legacy,'alpha','Nova addition'))?.accepted,true)
  await host.tasks.controlClient('take',fence,'client','takeover')
  assert.throws(()=>intakePort!.steer(legacy,'alpha','must not overwrite user'),/not_controller/)
  const resolveSession=value.adapter.taskPort.resolveSession
  value.adapter.taskPort.resolveSession=async()=>{throw Error('session_active')}
  const missing=await host.command({type:'personal.command',request_id:'unavailable',method:'tasks.input',params:{...fence,control_revision:1,session_id:session.session_id,text:'not deliverable'}},{client_id:'client'}) as {ok:boolean;error:string}
  assert.equal(missing.error,'task_input_failed')
  assert.equal(host.tasks.inputReceipts(task.id).find(receipt=>receipt.text==='not deliverable')?.status,'failed')
  value.adapter.taskPort.resolveSession=resolveSession
  const service=captured!.bridgeService as RealtimeService
  let detached=0;const detach=service.detachTaskConversation.bind(service)
  service.detachTaskConversation=()=>{detached++;detach()}
  const timedOut=new AbortController(),pendingTurn=captured!.runTurn('timeout',timedOut.signal)
  timedOut.abort(new DOMException('turn expired','TimeoutError'))
  await assert.rejects(pendingTurn,/turn expired/)
  assert.equal(detached,0,'a response timeout does not detach the task conversation')
  await delay(30)
  assert.equal((await settleWithin('response after timeout',captured!.runTurn('after timeout',new AbortController().signal))).assistant,'ready')
  const input=await settleWithin('direct steer',host.command({type:'personal.command',request_id:'direct',method:'tasks.input',params:{...fence,control_revision:1,session_id:session.session_id,text:'Use the revised detail'}},{client_id:'client'})) as {ok:boolean;data:{status:string}}
  assert.equal(input.ok,true);assert.equal(input.data.status,'accepted')
  release(COMPLETE);await until(()=>value.adapter.running().length===0)
  value.factory.runGate=new Promise(resolve=>{release=resolve})
  const resumed=await settleWithin('idle task input resumes existing session',host.command({type:'personal.command',request_id:'resume-input',method:'tasks.input',params:{...fence,control_revision:1,session_id:session.session_id,text:'Continue with the same scope'}},{client_id:'client'})) as {ok:boolean}
  assert.equal(resumed.ok,true)
  assert.equal(value.factory.bindings[1]?.resumeThreadId,'thread-existing')
  assert.equal(hostCodexHomeValue(value.factory.bindings[1].codexHome).path,originalHome)
  const cleared=await host.command({type:'personal.command',request_id:'clear',method:'conversations.clear',params:{id:'chat:main',expected_generation:0}}) as {ok:boolean}
  assert.equal(cleared.ok,true)
  assert.equal(value.adapter.running().length,1,'clear must not abort the real project adapter')
  assert.equal(value.factory.transports[1]?.closeCalls,0)
  let notifications=0;const unsubscribe=host.subscribe(()=>notifications++)
  value.factory.transports[1].observers[0]!.onActivity?.({thread_id:'thread-existing',turn_id:'turn:2',item_id:'message:2',stage:'completed',kind:'message',sender:'executor',text:'Retained worker update',refs:[]})
  await until(()=>host.tasks.events(task.id,0).items.some(event=>event.text==='Retained worker update'))
  const page=await host.command({type:'personal.command',request_id:'activity-page',method:'tasks.get',params:{task_id:task.id,after:0}},{client_id:'client'}) as {ok:boolean;data:{events:{items:{text:string;work_id:string;session_id:string;thread_id:string}[]};capabilities:{detail:string}}}
  const publicItem=page.data.events.items.find(event=>event.text==='Retained worker update')!
  assert.equal(publicItem.session_id,session.session_id);assert.equal(publicItem.thread_id,'thread-existing')
  assert.ok(host.tasks.get(task.id).work_ids.includes(publicItem.work_id));assert.equal(page.data.capabilities.detail,'public-events');assert.ok(notifications>0);unsubscribe()

  assert.equal(hostCodexHomeValue(value.factory.bindings[1].codexHome).path,originalHome)
  const cancelled=await host.command({type:'personal.command',request_id:'stop',method:'tasks.cancel',params:{...fence,control_revision:1}},{client_id:'client'}) as {ok:boolean}
  assert.equal(cancelled.ok,true)
  await until(()=>value.adapter.running().length===0)
  await delay(30)
  assert.equal(host.tasks.get(task.id).phase,'cancelled')
  assert.deepEqual(host.conversationSnapshot().messages,[],'late task results cannot restore a cleared transcript')
 }finally{release?.(COMPLETE);await host.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

test('taken-over task input reaches its exact live first-run session while unmatched starting sessions stay fenced',async()=>{
 const value=await fixture()
 const host=new PersonalAgentHost({path:join(await realpath(value.root),'personal-new-session.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let release!:(outcome:TransportOutcome)=>void
 try{
  await host.open();await value.adapter.initialize()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>undefined,
   settings:settingsSchema.parse({executors:['codex'],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),
   codexResource:{mode:'project',adapter:value.adapter,agentDescriptor:CODEX_AGENT_DESCRIPTOR,agentControllerFactory:codingAgentControllerFactory,projectView:null,approvalController:null,start:async()=>{},close:async()=>{}},
   searchTransport:{search:async()=>{throw Error('unexpected search')}},
   gateway:{complete:async()=>{throw Error('unexpected model')},async *stream(){throw Error('unexpected stream')}},
   createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({
    async *stream(){yield {kind:'response_started',response_id:'ready'};yield {kind:'text_delta',text:'ready'};yield {kind:'response_completed',response_id:'ready'}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{},
   })})}}),
  }),()=>{})
  await host.submitConversationText('chat:main','Prepare task input routing')
  await until(()=>host.conversationSnapshot().messages.some(message=>message.role==='assistant'))
  value.factory.runGate=new Promise(resolve=>{release=resolve})
  const running=run(value,'first run',{session:'new',delegateId:'first-work'})
  await until(()=>value.factory.transports[0]?.workOrders.length===1)
  const workspace=await value.store.resolveWorkspace('alpha')
  const session=(await value.store.listSessions(workspace)).find(item=>item.display_title==='first run')!
  assert.equal(session.state,'starting')
  const unmatched=await value.store.beginSessionForRun(workspace.workspace_id,'unmatched starting')
  await assert.rejects(value.adapter.taskPort.resolveSession(unmatched.session.session_id),/session_not_found/)
  await value.store.rollbackSessionStartForRun(unmatched.rollback,{wait:true})
  assert.deepEqual(await value.adapter.taskPort.resolveSession(session.session_id),{project:'alpha',session_id:session.session_id,active:true,work_id:'first-work'})
  const task=await host.tasks.delegate('declare-new-session',{conversation_id:'chat:main',conversation_generation:0,goal:'Complete first run',acceptance:[],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:0,goal_revision:0}
  await host.tasks.bindWork(fence,'first-work',session.session_id)
  await host.tasks.controlClient('take-new-session',fence,'client','takeover')
  const input=await settleWithin('first-run direct steer',host.command({type:'personal.command',request_id:'new-session-input',method:'tasks.input',params:{...fence,control_revision:1,session_id:session.session_id,text:'Apply the revised constraint'}},{client_id:'client'})) as {ok:boolean;data:{status:string}}
  assert.equal(input.ok,true);assert.equal(input.data.status,'accepted')
  assert.equal((await value.store.listSessions(workspace)).find(item=>item.session_id===session.session_id)?.state,'starting')
  release(COMPLETE);await running
 }finally{release?.(COMPLETE);await host.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

import {CausalRuntime,type ExecutorDispatchContext} from '../src/core/causal-runtime.js'
import {RealClock} from '../src/core/clock.js'
import {MonotonicIdFactory} from '../src/core/ids.js'
import {fixtureSlowSimManifest} from '../eval/sim.js'
test('host grant admits aged original origin while forged grants fail closed',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-aged-origin-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 const runtime=new CausalRuntime({clock:new RealClock(),ids:new MonotonicIdFactory(),models:{},executors:[{manifest:fixtureSlowSimManifest,dispatch:async()=>({outcome:'ok',trust:'trusted_system',content:{}})}]})
 try{
  const item=runtime.memory.append('conversation',{ts:0,trust:'trusted_user',priority:100,content:{text:'Original delegation'}})
  const origin=item.channel+':'+item.seq
  for(let i=0;i<100;i++)runtime.memory.append('conversation',{ts:i+1,trust:'trusted_user',priority:100,content:{text:'Later conversation '+i}})
  const task=await tasks.delegate('declare',{conversation_id:'chat:main',conversation_generation:0,goal:'Original delegation',acceptance:[],origin_ref:origin})
  const grant=tasks.continuationContext({task_id:task.id,control_revision:0,goal_revision:0})
  const request={executor:'slow_sim',op:'set_light',request:{level:1},origin_ref:origin},reason={kind:'realtime_tool',priority:100,routing_class:'user_awaited' as const,origin:null,selected_suggestion:null}
  assert.equal((await runtime.dispatchExternal(request,reason)).accepted,false)
  await assert.rejects(runtime.dispatchTaskExternal(request,reason,{...grant}),/invalid_continuation/)
  assert.equal((await runtime.dispatchTaskExternal(request,reason,grant)).accepted,true)
  assert.equal(tasks.get(task.id).work_ids.length,1)
  await assert.rejects(runtime.dispatchTaskExternal({...request,origin_ref:'conversation:2'},reason,grant),/invalid_origin_ref/)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('Nova-only cancellation is durable and mode exit invalidates pending host input without waiting for transport',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-host-control-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open()
  const task=await host.tasks.delegate('declare',{conversation_id:'chat:main',goal:'Nova deliverable',acceptance:[],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:0,goal_revision:0}
  await host.tasks.controlClient('take',fence,'client','takeover')
  const cancelled=await host.command({type:'personal.command',request_id:'cancel',method:'tasks.cancel',params:{...fence,control_revision:1}},{client_id:'client'}) as {ok:boolean}
  assert.equal(cancelled.ok,true);assert.equal(host.tasks.get(task.id).phase,'cancelled')
  const second=await host.tasks.delegate('second',{conversation_id:'chat:main',goal:'Executor task',acceptance:[],origin_ref:'conversation:2'})
  const secondFence={task_id:second.id,control_revision:0,goal_revision:0}
  await host.tasks.bindWork(secondFence,'work','session');await host.tasks.controlClient('take-second',secondFence,'client','takeover')
  let entered!:()=>void,release!:()=>void,writes=0
  const waiting=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  host.attachTaskRuntime('chat:main',0,{input:async grant=>{entered();await gate;if(!grant.stillWanted())return 'failed';writes++;return 'accepted'},cancel:()=>{},dispatch:async()=>{}})
  const pending=host.command({type:'personal.command',request_id:'input',method:'tasks.input',params:{...secondFence,control_revision:1,session_id:'session',text:'draft'}},{client_id:'client'}) as Promise<{ok:boolean;error?:string}>
  await waiting
  const exit=await settleWithin('mode exit while transport pending',host.command({type:'personal.command',request_id:'exit',method:'presentation.set',params:{mode:'orb'}},{client_id:'client'})) as {ok:boolean}
  assert.equal(exit.ok,true);release()
  assert.deepEqual((await pending).error,'task_input_failed');assert.equal(writes,0)
  assert.equal(host.tasks.inputReceipts(second.id)[0]?.session_id,'session')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})


test('task input steer carries exact session and original work identity across a replaced slot',async()=>{
 const value=await fixture({preexistingSession:true});let release!:(outcome:TransportOutcome)=>void
 try{
  await value.adapter.initialize()
  value.factory.runGate=new Promise(resolve=>{release=resolve})
  const first=run(value,'first',{delegateId:'first'})
  await until(()=>value.factory.transports[0]?.workOrders.length===1)
  const session=(await value.store.listSessions(await value.store.resolveWorkspace('alpha')))[0]!
  const request={instruction:'exact steer',project:'alpha',session_id:session.session_id,work_id:'first'}
  const accepted=await value.adapter.dispatch('steer',request,context('steer',request,value.clock))
  assert.equal(accepted.outcome,'ok')
  release(COMPLETE);await first
  value.factory.runGate=new Promise(resolve=>{release=resolve})
  const second=run(value,'second',{session:'new',delegateId:'second'})
  await until(()=>value.factory.transports[1]?.workOrders.length===1)
  const refused=await value.adapter.dispatch('steer',request,context('steer',request,value.clock))
  assert.notEqual(refused.outcome,'ok')
  release(COMPLETE);await second
 }finally{release?.(COMPLETE);await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

test('failed durable session binding rolls back preparation and closes the transport',async()=>{
 const value=await fixture()
 try{
  await value.adapter.initialize()
  const before=await value.store.listSessions(await value.store.resolveWorkspace('alpha'))
  const request={work_order:'new work',project:'alpha',session:'new'}
  await assert.rejects(value.adapter.dispatch('run',request,{...context('run',request,value.clock),bindSession:async()=>{throw Error('takeover')}}),/takeover/)
  assert.equal(value.factory.transports[0]?.closeCalls,1)
  assert.deepEqual(await value.store.listSessions(await value.store.resolveWorkspace('alpha')),before)
  assert.equal(value.adapter.running().length,0)
 }finally{await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

test('task launch keeps intake cancellation predicate and adapter exceptions settle receipts',async()=>{
 for(const variant of ['cancel','throw']){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-launch-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 let writes=0,current=true
 const runtime=new CausalRuntime({clock:new RealClock(),ids:new MonotonicIdFactory(),executors:[{manifest:fixtureSlowSimManifest,dispatch:async()=>{writes++;throw Error('adapter failed')}}]})
 const stop=new AbortController();let serving:Promise<void>|undefined
 try{
  const origin=runtime.memory.append('conversation',{ts:0,trust:'trusted_user',priority:100,content:{text:'task'}})
  const task=await tasks.delegate('task',{conversation_id:'c',goal:'task',acceptance:[],origin_ref:origin.channel+':'+origin.seq})
  const grant=tasks.continuationContext({task_id:task.id,goal_revision:0,control_revision:0})
  let receipt:string|undefined
  let release!:()=>void,entered!:()=>void
  const enteredBinding=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const bind=tasks.bindWork.bind(tasks)
  tasks.bindWork=async(...args)=>{entered();await gate;return bind(...args)}
  const dispatch=runtime.dispatchTaskExternal.bind(runtime)
  const admission=dispatch({executor:'slow_sim',op:'set_light',request:{level:1},origin_ref:grant.origin_ref},{kind:'realtime_tool',priority:100,routing_class:'user_awaited',origin:null,selected_suggestion:null},grant,status=>{receipt=status},()=>current)
  await enteredBinding
  if(variant==='cancel')current=false
  release();assert.equal((await admission).accepted,true)
  serving=runtime.serve(stop.signal)
  await until(()=>receipt!==undefined)
  assert.equal(receipt,variant==='cancel'?'failed':'unknown')
  assert.equal(writes,variant==='cancel'?0:1)
 }finally{stop.abort();await serving;await tasks.close();await rm(dir,{recursive:true,force:true})}
 }
})


test('Nova-mediated return uses current user authority inside durable serialization',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-handback-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 try{
  const task=await tasks.delegate('task',{conversation_id:'chat:main',goal:'task',acceptance:[],origin_ref:'conversation:1'})
  const fence={task_id:task.id,goal_revision:0,control_revision:0}
  await tasks.controlClient('take',fence,'client','takeover');fence.control_revision=1
  let current=true
  const stale=tasks.returnFromUserOrigin('stale',fence,{conversation_id:'chat:main',conversation_generation:0,origin_ref:'conversation:2'},()=>current)
  current=false
  await assert.rejects(stale,/superseded/)
  assert.equal(tasks.get(task.id).controller.kind,'user')
  const {service}=realtimeServiceHarness('pipeline',{taskHost:{tasks,conversation_id:'chat:main'}})
  try{
   await service.connect()
   const returned=await dispatchTurn(service,'task',{operation:'return',task_id:task.id,source_refs:[],origin_ref:'conversation:1'})
   assert.equal(returned.accepted,true)
   assert.deepEqual(tasks.get(task.id).controller,{kind:'nova'})
   assert.equal(tasks.get(task.id).control_revision,2)
  }finally{await service.close()}
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('failed activity persistence diagnoses an incomplete replay while later activity and execution succeed',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-replay-failure-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let executor:ExecutorDispatchContext|undefined,finish!:()=>void
 const complete=new Promise<void>(resolve=>{finish=resolve})
 const runtime=new CausalRuntime({clock:new RealClock(),ids:new MonotonicIdFactory(),executors:[{manifest:fixtureSlowSimManifest,dispatch:async(_op,_request,context)=>{await context.bindSession?.('session');executor=context;await complete;return {outcome:'ok',trust:'trusted_system',content:{}}}}]})
 const stop=new AbortController();let serving:Promise<void>|undefined
 try{await host.open();const origin=runtime.memory.append('conversation',{ts:0,trust:'trusted_user',priority:100,content:{text:'task'}})
  const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'task',acceptance:[],origin_ref:origin.channel+':'+origin.seq}),grant=host.tasks.continuationContext({task_id:task.id,control_revision:0,goal_revision:0})
  let completed:string|undefined,notifications=0;host.subscribe(()=>notifications++)
  const append=host.tasks.appendEvent.bind(host.tasks)
  host.tasks.appendEvent=(event,key)=>{if(event.item_id==='lost-sync')throw Error('private sync-error-content');return event.item_id==='lost'?Promise.reject(Error('private disk-error-content')):append(event,key)}
  assert.equal((await runtime.dispatchTaskExternal({executor:'slow_sim',op:'set_light',request:{level:1},origin_ref:grant.origin_ref},{kind:'realtime_tool',priority:100,routing_class:'user_awaited',origin:null,selected_suggestion:null},grant,status=>{completed=status})).accepted,true)
  serving=runtime.serve(stop.signal);await until(()=>executor!==undefined)
  const before=notifications,event={thread_id:'thread',turn_id:'turn',stage:'completed' as const,kind:'message' as const,sender:'executor' as const,refs:[]}
  executor!.activity?.({...event,item_id:'lost',text:'Missing message'})
  await until(()=>runtime.core.diagnostics.some(item=>item.code==='task_event_persistence_failed'))
  assert.ok(notifications>before,'host is notified even though persistence failed')
  assert.equal(host.tasks.events(task.id,0).incomplete,true)
  assert.equal(JSON.stringify(runtime.core.diagnostics).includes('private disk-error-content'),false)
  assert.doesNotThrow(()=>executor!.activity?.({...event,item_id:'lost-sync',text:'Missing synchronous message'}))
  await until(()=>runtime.core.diagnostics.filter(item=>item.code==='task_event_persistence_failed').length===2)
  assert.equal(JSON.stringify(runtime.core.diagnostics).includes('private sync-error-content'),false)
  executor!.activity?.({...event,item_id:'saved',text:'Later message'})
  await until(()=>host.tasks.events(task.id,0).items.some(item=>item.text==='Later message'))
  const response=await host.command({type:'personal.command',request_id:'page',method:'tasks.get',params:{task_id:task.id}},{client_id:'client'}) as {data:{events:{incomplete:boolean;items:{text:string}[]}}}
  assert.equal(response.data.events.incomplete,true);assert.deepEqual(response.data.events.items.map(item=>item.text),['Later message'])
  const restored=new TaskService(host.tasks.path);await restored.open();assert.equal(restored.events(task.id,0).incomplete,true);await restored.close()
  finish();await until(()=>completed!==undefined);assert.equal(completed,'accepted')
 }finally{finish();stop.abort();await serving;await host.close();await rm(dir,{recursive:true,force:true})}
})

test('real Nova declaration and confirmed content drive correction and verified completion without Codex',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-content-')),host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const fullPlan='Step one BEGIN: '+ 'inspect the original behavior carefully. '.repeat(8)+'Step two MIDDLE: '+ 'make the smallest checked correction. '.repeat(8)+'Step three END: validate the result.';const captions:Record<string,unknown>[]=[]
 let responses=0,checks=0,continuationGuidance=''
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async request=>{const input=JSON.parse(request.prompt) as {task:{id:string};evidence:{ref:string}[]};checks++;return {text:JSON.stringify(checks===1?{kind:'correct',instruction:'Include all three steps',evidence_refs:[input.evidence[0]!.ref]}:completeWith(request.prompt,[input.evidence.at(-1)!.ref]))}},async *stream(){throw Error('unused')}},
 createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(input){const n=++responses,r='nova:'+n;yield {kind:'response_started',response_id:r};if(n===1)yield {kind:'tool_call',item_id:'declare',call_id:'declare',name:'task',arguments:{operation:'declare',goal:'Write three steps',acceptance:['Three steps'],source_refs:[],origin_ref:'conversation:1'}};else {if(n>=3)continuationGuidance=input.responseAdaptation??'';yield {kind:'text_delta',text:n===2?'Step one':fullPlan}}yield {kind:'response_completed',response_id:r}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}})})
 host.setConversationRuntime(factory,frame=>{if(frame.type==='caption')captions.push(frame)});await host.submitConversationText('chat:main','Write three steps');await until(()=>host.tasks.list()[0]?.phase==='completed')
 const task=host.tasks.list()[0]!;assert.equal(task.corrections,1);assert.equal(checks,2);assert.equal(task.work_ids.length,0);assert.match(continuationGuidance,/actual requested deliverable/);assert.equal(host.tasks.evidence(task.id).filter(item=>item.kind==='delivery').length,2)
 assert.equal(host.tasks.evidence(task.id).filter(item=>item.kind==='delivery').at(-1)?.content,fullPlan)
 assert.ok(host.conversationSnapshot().messages.some(message=>message.role==='assistant'&&message.text===fullPlan))
 const {PersonalStore}=await import('../src/personal-agent/store.js');assert.ok((await new PersonalStore(host.path).read()).conversations.items.find(item=>item.id==='chat:main')?.messages.some(message=>message.text===fullPlan))
 assert.ok(captions.some(frame=>frame.full_text===fullPlan&&typeof frame.text==='string'&&[...frame.text].length<=160))
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

async function recordSuccessfulCodingCheck(value:Awaited<ReturnType<typeof fixture>>,host:PersonalAgentHost):Promise<void>{
 await until(()=>value.factory.transports[0]?.observers[0]!==undefined)
 const transport=value.factory.transports[0]!,task=host.tasks.list()[0]!
 transport.observers[0]!.onActivity?.({thread_id:transport.threadId,turn_id:'turn-check',item_id:'check',kind:'tool',stage:'completed',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'1 passed',exit_code:0}),refs:[]})
 await until(()=>host.tasks.events(task.id,0).items.some(event=>event.item_id==='check'))
 const observation=host.tasks.events(task.id,0).items.find(event=>event.item_id==='check')!
 assert.equal(observation.task_id,task.id);assert.equal(observation.work_id,task.work_ids[0]);assert.equal(observation.session_id,task.session_ids[0])
}

test('host coding delegate starts through actual controller without a session, verifies terminal result and syncs Todo',async()=>{
 let releaseForeground!:()=>void;const foreground=new Promise<void>(resolve=>{releaseForeground=resolve})
 const value=await fixture(),host=new PersonalAgentHost({path:join(await realpath(value.root),'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let responses=0,checks=0,releaseCodex!:(outcome:TransportOutcome)=>void
 value.factory.runGate=new Promise(resolve=>{releaseCodex=resolve})
 try{await host.open();await value.adapter.initialize();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:['codex'],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),codexResource:{mode:'project',adapter:value.adapter,agentDescriptor:CODEX_AGENT_DESCRIPTOR,agentControllerFactory:{create:context=>new CodexAgentController({channel:context.channel,resolveCancelTarget:async()=>null,dispatchPort:{dispatch:request=>context.dispatchPort.dispatch({...request,request:{...request.request,project:'alpha'}})}})},projectView:null,approvalController:null,start:async()=>{},close:async()=>{}},searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async request=>{const input=JSON.parse(request.prompt) as {evidence:{ref:string;kind:string;content:string}[]};checks++;assert.ok(input.evidence.some(item=>item.kind==='work'&&item.content.includes('done')));return {text:JSON.stringify(completeWith(request.prompt,input.evidence.filter(item=>item.kind==='work').map(item=>item.ref)))}},async *stream(){throw Error('unused')}},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){const r='coding:'+ ++responses;yield {kind:'response_started',response_id:r};await foreground;yield {kind:'text_delta',text:'Ready'};yield {kind:'response_completed',response_id:r}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}})})
 host.setConversationRuntime(factory,()=>{});const submitted=host.submitConversationText('chat:main','Please implement the fix');await until(()=>responses===1)
 const todo=await host.life.mutate({op:'create',kind:'todo',title:'Fix',note:'unchanged'},'todo')
 const result=await host.command({type:'personal.command',request_id:'delegate',method:'tasks.delegate',params:{conversation_id:'chat:main',goal:'Implement the fix',acceptance:['done result'],origin_ref:'conversation:1',execution_route:'codex',todo_ref:todo}},{client_id:'client'}) as {ok:boolean;error?:string;data:{id:string}}
 assert.equal(result.ok,true,result.error);releaseForeground();await submitted;await recordSuccessfulCodingCheck(value,host);releaseCodex(COMPLETE);await until(()=>host.tasks.get(result.data.id).todo_sync==='synced')
 assert.equal(value.factory.transports.length,1);assert.equal(checks,1);assert.equal(host.tasks.get(result.data.id).corrections,0);assert.equal(host.life.snapshot().todos[0]!.status,'done');assert.equal(host.life.snapshot().todos[0]!.note,'unchanged')
 }finally{releaseForeground();releaseCodex(COMPLETE);await host.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

test('explicit model task stop cancels Nova-only and bound work and prevents restart',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-stop-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});try{await host.open();for(const bound of [false,true]){const task=await host.tasks.delegate('task:'+bound,{conversation_id:'chat:main',goal:'stop me',acceptance:[],origin_ref:'conversation:1'});if(bound){await host.tasks.bindWork({task_id:task.id,goal_revision:0,control_revision:0},'work');host.attachTaskRuntime('chat:main',0,{input:async()=> 'accepted',dispatch:async()=>assert.fail('restart'),cancel:work=>assert.equal(work,'work')})}
 const {service}=realtimeServiceHarness('pipeline',{taskHost:{tasks:host.tasks,conversation_id:'chat:main',cancel:(request,fence)=>host.cancelTask(request,fence,{kind:'nova'})}});await service.connect();const result=await dispatchTurn(service,'task',{operation:'cancel',task_id:task.id,source_refs:[],origin_ref:'conversation:1'},'cancel:'+bound);assert.equal(result.accepted,true);assert.equal(host.tasks.get(task.id).phase,'cancelled');await host.wakeTask(task.id);await service.close()}
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('explicit continue cannot silently choose Nova for a host task with no route',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-route-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let dispatches=0
 try{await host.open();host.attachTaskRuntime('chat:main',0,{routes:()=>['nova'],input:async()=> 'accepted',cancel:()=>{},dispatch:async()=>{dispatches++}})
 const result=await host.command({type:'personal.command',request_id:'unrouted',method:'tasks.delegate',params:{conversation_id:'chat:main',goal:'Do work',acceptance:[],origin_ref:'conversation:1'}},{client_id:'client'}) as {data:{id:string}}
 const task=host.tasks.get(result.data.id);await host.tasks.continue('continue',{task_id:task.id,control_revision:0,goal_revision:0},{kind:'nova'});await host.wakeTask(task.id)
 assert.equal(dispatches,0);assert.equal(host.tasks.get(task.id).waiting_reason,'execution_route_required')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('presentation and Nova-mediated handback wake verification after durable ownership return',async()=>{
 for(const action of ['presentation','model']){const dir=await mkdtemp(join(await realpath(tmpdir()),'task-return-wake-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'answer',acceptance:[],origin_ref:'conversation:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0};await host.tasks.recordDelivery(fence,'reply','answer');await host.tasks.controlClient('take',fence,'client','takeover')
 host.attachTaskRuntime('chat:main',0,{input:async()=> 'accepted',cancel:()=>{},dispatch:async()=>assert.fail('already delivered'),evaluate:async()=>({kind:'complete',evidence_refs:['task-delivery:reply']})})
 if(action==='presentation')await host.command({type:'personal.command',request_id:'orb',method:'presentation.set',params:{mode:'orb'}},{client_id:'client'})
 else{const {service}=realtimeServiceHarness('pipeline',{taskHost:{tasks:host.tasks,conversation_id:'chat:main',wake:id=>host.wakeTask(id)}});try{await service.connect();const result=await dispatchTurn(service,'task',{operation:'return',task_id:task.id,source_refs:[],origin_ref:'conversation:1'});assert.equal(result.accepted,true)}finally{await service.close()}}
 await until(()=>host.tasks.get(task.id).phase==='completed')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}}
})

test('unrelated host narration is not evidence for a task sharing the latest user origin',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-host-fact-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let responses=0,captured:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async()=>{throw Error('not task evidence')},async *stream(){throw Error('unused')}},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){const n=++responses;yield {kind:'response_started',response_id:'fact:'+n};yield {kind:'text_delta',text:n===1?'Ready':'Unrelated host notice'};yield {kind:'response_completed',response_id:'fact:'+n}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}})})
 host.setConversationRuntime(async(...args)=>{captured=await factory(...args);return captured},()=>{});await host.submitConversationText('chat:main','Write a plan');const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'Write a plan',acceptance:[],origin_ref:'conversation:1'})
 const bridge=captured!.bridgeService as RealtimeService;bridge.queueHostItem({kind:'host_fact',item:{kind:'recovery',host_item_id:'unrelated',event_id:'unrelated',call_id:null,content:'Unrelated host notice'},task_summary:null,origin_spoken:false});await (captured!.bridgeService as RealtimeService).flushHostItems();await until(()=>host.conversationSnapshot().messages.some(item=>item.text==='Unrelated host notice'));await host.tasks.close()
 assert.equal(host.tasks.evidence(task.id).length,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('parked voice executor results cannot publish task completion before verification',async()=>{
 const value=await fixture(),host=new PersonalAgentHost({path:join(await realpath(value.root),'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let native:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined,releaseCodex!:(outcome:TransportOutcome)=>void
 const emitted:Record<string,unknown>[]=[],qwen=scriptedTaskQwen(n=>qwen.reply('ready:'+n,'Ready'))
 value.factory.runGate=new Promise(resolve=>{releaseCodex=resolve})
 try{
  await host.open();await value.adapter.initialize()
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,
   settings:settingsSchema.parse({executors:['codex'],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),
   codexResource:{mode:'project',adapter:value.adapter,agentDescriptor:CODEX_AGENT_DESCRIPTOR,agentControllerFactory:{create:context=>new CodexAgentController({channel:context.channel,resolveCancelTarget:async()=>null,dispatchPort:{dispatch:request=>context.dispatchPort.dispatch({...request,request:{...request.request,project:'alpha'}})}})},projectView:null,approvalController:null,start:async()=>{},close:async()=>{}},
   searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async()=>({text:JSON.stringify({kind:'wait',reason:'completion evidence gate',evidence_refs:[]})}),async *stream(){throw Error('unused')}},
   onAudioTerminal:(id,epoch)=>{(native?.bridgeService as RealtimeService|undefined)?.playbackDone(id,epoch,20)},createVoiceProvider:()=>qwen.adapter,
  })
  native=await factory(createConversation('chat','Test',null,'chat:main'),event=>emitted.push(event),'voice')
  qwen.user('Please implement the fix');await until(()=>(native!.bridgeService as RealtimeService).taskTurnOrigin()!==undefined)
  const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'Implement the fix',acceptance:['verified observations'],origin_ref:'conversation:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await host.tasks.setRoute(fence,'codex');await host.continueTask(host.tasks.continuationContext(fence),'Implement the fix')
  await until(()=>value.factory.transports[0]?.workOrders.length===1);await native.parkVoice?.();releaseCodex(COMPLETE)
  await until(()=>host.tasks.get(task.id).waiting_reason==='completion evidence gate')
  assert.equal(host.tasks.get(task.id).phase,'waiting');assert.equal(emitted.some(event=>event.type==='conversation.completed'),false)
  assert.equal(host.conversationSnapshot().messages.some(message=>message.turn_id?.startsWith('task:verified:')),false)
 }finally{releaseCodex(COMPLETE);await native?.close();await host.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

test('model declare and dispatch in one foreground turn admit exactly one coding attempt',async()=>{
 for(const mode of ['text','voice'] as const){
 const value=await fixture(),host=new PersonalAgentHost({path:join(await realpath(value.root),'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let checks=0;let native:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined;let releaseCodex!:(outcome:TransportOutcome)=>void
 value.factory.runGate=new Promise(resolve=>{releaseCodex=resolve})
 const qwen=scriptedTaskQwen(n=>{if(n===1)setTimeout(()=>qwen.reply('dispatch','',{name:'dispatch',args:{executor:'codex',instruction:'Implement the fix',task_id:host.tasks.list()[0]!.id,source_refs:['conversation:1'],origin_ref:'conversation:1'}}),40);else qwen.reply('ready:'+n,'Ready')})
 try{await host.open();await value.adapter.initialize();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:['codex'],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),codexResource:{mode:'project',adapter:value.adapter,agentDescriptor:CODEX_AGENT_DESCRIPTOR,agentControllerFactory:{create:context=>new CodexAgentController({channel:context.channel,resolveCancelTarget:async()=>null,dispatchPort:{dispatch:request=>context.dispatchPort.dispatch({...request,request:{...request.request,project:'alpha'}})}})},projectView:null,approvalController:null,start:async()=>{},close:async()=>{}},searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async request=>{const input=JSON.parse(request.prompt) as {evidence:{ref:string;kind:string;content:string}[]};checks++;assert.ok(input.evidence.some(item=>item.kind==='work'&&item.content.includes('done')));return {text:JSON.stringify(completeWith(request.prompt,input.evidence.filter(item=>item.kind==='work').map(item=>item.ref)))}},async *stream(){throw Error('unused')}},onAudioTerminal:(id,epoch)=>{(native?.bridgeService as RealtimeService|undefined)?.playbackDone(id,epoch,20)},createTextProvider:()=>qwen.adapter,createVoiceProvider:()=>qwen.adapter})
 native=await factory(createConversation('chat','Test',null,'chat:main'),()=>{},mode);qwen.user('Please implement the fix');await until(()=>native!.bridgeService!==undefined&&(native!.bridgeService as RealtimeService).taskTurnOrigin()!==undefined);qwen.reply('declare','I will work on it',{name:'task',args:{operation:'declare',goal:'Implement the fix',acceptance:['done result'],source_refs:[],origin_ref:'conversation:1'}});await recordSuccessfulCodingCheck(value,host);releaseCodex(COMPLETE);await until(()=>host.tasks.list()[0]?.phase==='completed').catch(error=>{throw Error(JSON.stringify({checks,tasks:host.tasks.list(),transports:value.factory.transports.length})+String(error))})
 assert.equal(host.tasks.evidence(host.tasks.list()[0]!.id).filter(item=>item.kind==='delivery').length,0);assert.equal(value.factory.transports.length,1);assert.equal(host.tasks.list()[0]!.work_ids.length,1);assert.equal(checks,1);assert.equal(host.tasks.list()[0]!.corrections,0);assert.equal(host.tasks.events(host.tasks.list()[0]!.id,0).items.some(item=>item.text.includes('delivery_interrupted')),false)
 }finally{releaseCodex(COMPLETE);await native?.close();await host.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}}
})


import type {RealtimeProviderEvent} from '../src/realtime/protocol.js'
test('interrupted native Nova playback is not delivered evidence',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-voice-delivery-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let failure:unknown;let responses=0,checks=0,captured:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async()=>{checks++;throw Error('interrupted output must not be verified')},async *stream(){throw Error('unused')}},createVoiceProvider:options=>{
 const provider=buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){const n=++responses,r='voice:'+n;yield {kind:'response_started',response_id:r};if(n===1)yield {kind:'tool_call',item_id:'declare',call_id:'declare',name:'task',arguments:{operation:'declare',goal:'Say three steps',acceptance:['three spoken steps'],source_refs:[],origin_ref:'conversation:1'}};else yield {kind:'text_delta',text:'Step one. Step two. Step three.'};yield {kind:'response_completed',response_id:r}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}}),events=provider.events.bind(provider)
 provider.events=async function*(signal){for await(const raw of events(signal)){const event=raw as RealtimeProviderEvent;if(event.kind==='response_transcript_final')yield {kind:'response_audio_delta',session_epoch:event.session_epoch,response_id:event.response_id,pcm:new Uint8Array(640)};yield raw}};return provider
 }})
 host.setConversationRuntime(async(conversation,emit,_mode,lifetime)=>{try{captured=await factory(conversation,emit,'voice',lifetime);return captured}catch(error){failure=error;throw error}},()=>{});await host.submitConversationText('chat:main','Say three steps');await until(()=>captured!==undefined||failure!==undefined);assert.ok(captured,String(failure));const service=captured.bridgeService as RealtimeService;await until(()=>service.session.currentGeneration!==null)
 const generation=service.session.currentGeneration!;assert.equal(host.tasks.evidence(host.tasks.list()[0]!.id).length,0);await service.playbackStopped(generation.utterance_id,generation.generation_epoch,0);await until(()=>host.tasks.list()[0]!.waiting_reason==='delivery_interrupted');assert.equal(host.tasks.evidence(host.tasks.list()[0]!.id).length,0);assert.equal(checks,0);assert.notEqual(host.tasks.list()[0]!.phase,'completed')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('verified completion publication is idempotent and does not repopulate a cleared transcript',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-publish-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'Write a plan',acceptance:[],origin_ref:'conversation:1'});await host.tasks.recordDelivery({task_id:task.id,control_revision:0,goal_revision:0},'reply','The plan');host.attachTaskRuntime('chat:main',0,{input:async()=> 'accepted',cancel:()=>{},dispatch:async()=>assert.fail('already delivered'),evaluate:async()=>({kind:'complete',evidence_refs:['task-delivery:reply']})});await host.wakeTask(task.id)
 assert.equal(host.snapshot().feed.filter(item=>item.kind==='task_result').length,1);assert.equal(host.conversationSnapshot().messages.filter(item=>item.turn_id?.startsWith('task:verified:')).length,1);await host.wakeTask(task.id);assert.equal(host.snapshot().feed.filter(item=>item.kind==='task_result').length,1)
 await host.command({type:'personal.command',request_id:'clear',method:'conversations.clear',params:{id:'chat:main',expected_generation:0}});await host.wakeTask(task.id);assert.equal(host.conversationSnapshot().messages.length,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('host shutdown closes the owning runtime before joining a blocked task execution',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-shutdown-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let release!:()=>void,entered=false;const stopped=new Promise<void>(resolve=>{release=resolve})
 try{await host.open();host.setConversationRuntime(async()=>{host.attachTaskRuntime('chat:main',0,{input:async()=> 'accepted',cancel:()=>{},dispatch:async()=>{entered=true;await stopped}});return {runTurn:async()=>({assistant:'ready'}),close:async()=>{release()}}},()=>{});await host.submitConversationText('chat:main','Prepare');await until(()=>host.conversationSnapshot().messages.some(item=>item.role==='assistant'))
 const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'Work',acceptance:[],origin_ref:'conversation:1',execution_route:'nova'});const run=host.wakeTask(task.id);await until(()=>entered);await settleWithin('host task shutdown',host.close());await run
 }finally{release();await host.close();await rm(dir,{recursive:true,force:true})}
})

import {QwenAudioRealtimeAdapter,QwenSocketClosedError,type QwenSocket} from '../src/realtime/qwen.js'
import {createConversation} from '../src/personal-agent/conversations.js'
function scriptedTaskQwen(onResponse:(n:number)=>void){
 const inbound:(Record<string,unknown>|null)[]=[{type:'session.created',session:{id:'fixture'}}];let wake:(()=>void)|undefined,n=0,id=0
 const push=(event:Record<string,unknown>|null)=>{inbound.push(event);wake?.();wake=undefined}
 const socket:QwenSocket={send:async raw=>{const event=JSON.parse(raw) as {type:string;item?:{id:string};item_id?:string};if(event.type==='session.update')push({type:'session.updated',session:{id:'fixture'}});else if(event.type==='conversation.item.create')push({type:'conversation.item.created',item:{id:event.item!.id}});else if(event.type==='conversation.item.delete')push({type:'conversation.item.deleted',item_id:event.item_id});else if(event.type==='response.create')onResponse(++n)},receive:async()=>{while(!inbound.length)await new Promise<void>(resolve=>{wake=resolve});const event=inbound.shift();if(!event)throw new QwenSocketClosedError();return JSON.stringify(event)},close:async()=>{push(null)}}
 const adapter=new QwenAudioRealtimeAdapter({url:'wss://example.invalid/realtime',apiKey:'test',model:'qwen-audio-3.0-realtime-plus',voice:'longanqian',connector:async()=>socket,idFactory:()=> 'qwen:'+ ++id})
 return {adapter,user:(text:string)=>push({type:'conversation.item.input_audio_transcription.completed',item_id:'user:1',transcript:text}),reply:(responseId:string,text:string,tool?:{name:string;args:Record<string,unknown>})=>{push({type:'response.created',response:{id:responseId}});if(tool)push({type:'response.function_call_arguments.done',response_id:responseId,call_id:responseId,item_id:responseId+':tool',name:tool.name,arguments:JSON.stringify(tool.args)});if(text){push({type:'response.audio.delta',response_id:responseId,delta:Buffer.alloc(640).toString('base64')});push({type:'response.audio_transcript.done',response_id:responseId,transcript:text})};push({type:'response.done',response:{id:responseId,status:'completed'}})}}
}
test('native Qwen originless host responses bind only the exact pending task delivery',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-qwen-origin-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let checks=0,native:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined
 const qwen=scriptedTaskQwen(n=>qwen.reply('host:'+n,n===1?'Step one':n===2?'Step one. Step two. Step three.':'Unrelated notice'))
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async request=>{const input=JSON.parse(request.prompt) as {evidence:{ref:string}[]};checks++;return {text:JSON.stringify(checks===1?{kind:'correct',instruction:'Include three steps',evidence_refs:[input.evidence[0]!.ref]}:completeWith(request.prompt,[input.evidence.at(-1)!.ref]))}},async *stream(){throw Error('unused')}},onAudioTerminal:(id,epoch)=>{(native?.bridgeService as RealtimeService|undefined)?.playbackDone(id,epoch,20)},createTextProvider:()=>qwen.adapter});native=await factory(createConversation('chat','Test',null,'chat:main'),()=>{});qwen.user('Write three steps');const service=native.bridgeService as RealtimeService;await until(()=>service.taskTurnOrigin()!==undefined);qwen.reply('declare','',{name:'task',args:{operation:'declare',goal:'Write three steps',acceptance:['three steps'],source_refs:[],origin_ref:'conversation:1'}});await until(()=>host.tasks.list()[0]?.phase==='completed');assert.equal(checks,2);assert.equal(host.tasks.list()[0]!.corrections,1);assert.equal(host.tasks.evidence(host.tasks.list()[0]!.id).length,2)
 const other=await host.tasks.delegate('other',{conversation_id:'chat:main',goal:'Other task',acceptance:[],origin_ref:'conversation:1'});service.queueHostItem({kind:'host_fact',item:{kind:'recovery',host_item_id:'unrelated',event_id:'unrelated',call_id:null,content:'Unrelated notice'},task_summary:null,origin_spoken:false});await service.flushHostItems();await until(()=>service.session.providerIdle);await host.tasks.close();assert.equal(host.tasks.evidence(other.id).length,0)
 }finally{await native?.close();await host.close();await rm(dir,{recursive:true,force:true})}
})

test('tool-bearing failed and cancelled terminals promptly release the foreground turn',async()=>{
 for(const status of ['failed','cancelled'] as const){const dir=await mkdtemp(join(await realpath(tmpdir()),'task-tool-terminal-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let native:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async()=>{throw Error('no verification')},async *stream(){throw Error('unused')}},createTextProvider:options=>{const provider=buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){yield {kind:'response_started',response_id:'tool'};yield {kind:'tool_call',item_id:'declare',call_id:'declare',name:'task',arguments:{operation:'declare',goal:'Write a plan',acceptance:[],source_refs:[],origin_ref:'conversation:1'}};yield {kind:'response_completed',response_id:'tool'}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}}),events=provider.events.bind(provider);provider.events=async function*(signal){for await(const raw of events(signal)){const event=raw as RealtimeProviderEvent;yield event.kind==='response_terminal'?{...event,status}:raw}};return provider}})
 native=await factory(createConversation('chat','Test',null,'chat:main'),()=>{});await assert.rejects(settleWithin('failed tool foreground',native.runTurn('Write a plan',new AbortController().signal),400),new RegExp('response_'+status));assert.equal(host.tasks.evidence(host.tasks.list()[0]!.id).length,0)
 }finally{await native?.close();await host.close();await rm(dir,{recursive:true,force:true})}}
})

test('known unsent Nova queue rejection releases its exact delivery across takeover and goal revision',async()=>{
 for(const boundary of ['queued','injecting'] as const)for(const mutation of ['takeover','goal'] as const){const dir=await mkdtemp(join(await realpath(tmpdir()),'task-unsent-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let native:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined,release!:()=>void,entered=false,block=boundary==='injecting';const gate=new Promise<void>(resolve=>{release=resolve})
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async request=>{const data=JSON.parse(request.prompt) as {evidence:{ref:string}[]};return {text:JSON.stringify({kind:'complete',evidence_refs:data.evidence.map(item=>item.ref)})}},async *stream(){throw Error('unused')}},createTextProvider:options=>{const provider=buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){yield {kind:'response_started',response_id:'reply'};yield {kind:'text_delta',text:'Ready'};yield {kind:'response_completed',response_id:'reply'}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}}),inject=provider.injectHostItem.bind(provider);provider.injectHostItem=async(item,options)=>{if(block&&item.host_item_id.startsWith('task-response:')){entered=true;await gate;block=false}return inject(item,options)};return provider}})
 native=await factory(createConversation('chat','Test',null,'chat:main'),()=>{});await native.runTurn('Prepare',new AbortController().signal);const service=native.bridgeService as RealtimeService,task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'Deliver a plan',acceptance:[],origin_ref:'conversation:1',execution_route:'nova'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
 if(boundary==='queued')await service.handleEvent({kind:'user_speech_started',session_epoch:service.session.sessionEpoch,speech_id:'hold',provider_item_id:'hold'})
 const dispatch=host.continueTask(host.tasks.continuationContext(fence),'Deliver the plan');if(boundary==='queued')await dispatch;else await until(()=>entered);assert.ok(host.tasks.get(task.id).pending_delivery)
 if(mutation==='takeover')await host.tasks.controlClient('take',fence,'client','takeover');else await host.tasks.reviseGoal('revise',fence,{kind:'nova'},'Deliver the updated plan',[])
 release();if(boundary==='queued')await service.handleEvent({kind:'user_speech_ended',session_epoch:service.session.sessionEpoch,speech_id:'hold',provider_item_id:'hold'});await dispatch.catch(error=>{assert.match(String(error),/task_delivery_not_requested/)});await service.flushHostItems();await until(()=>host.tasks.get(task.id).pending_delivery===undefined);assert.equal(host.tasks.evidence(task.id).length,0)
 let current=host.tasks.get(task.id);if(mutation==='takeover')current=await host.tasks.controlClient('return',{task_id:task.id,control_revision:current.control_revision,goal_revision:current.goal_revision},'client','return');await host.tasks.continue('continue',{task_id:task.id,control_revision:current.control_revision,goal_revision:current.goal_revision},{kind:'nova'});await host.wakeTask(task.id);await until(()=>host.tasks.get(task.id).phase==='completed')
 }finally{release();await native?.close();await host.close();await rm(dir,{recursive:true,force:true})}}
})


test('possibly sent Nova response is never replayed by a later queue flush or task wake',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-send-unknown-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let native:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined,requests=0
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async()=>{throw Error('must not verify unknown delivery')},async *stream(){throw Error('unused')}},createTextProvider:options=>{const provider=buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){yield {kind:'response_started',response_id:'reply'};yield {kind:'text_delta',text:'Ready'};yield {kind:'response_completed',response_id:'reply'}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}}),create=provider.createResponse.bind(provider);provider.createResponse=async(...args)=>{const [intent]=args;if(intent.kind==='task_continuation'){requests++;throw Error('request sent; acknowledgement lost')}return create(...args)};return provider}})
 native=await factory(createConversation('chat','Test',null,'chat:main'),()=>{});await native.runTurn('Prepare',new AbortController().signal);const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'Deliver a plan',acceptance:[],origin_ref:'conversation:1',execution_route:'nova'});await host.wakeTask(task.id);const delivery=host.tasks.get(task.id).pending_delivery;assert.ok(delivery);assert.equal(host.tasks.pendingEffect(task.id)?.status,'unknown');assert.equal(host.tasks.get(task.id).phase,'waiting');assert.equal(requests,1)
 const service=native.bridgeService as RealtimeService;for(let i=0;i<3;i++){await service.flushHostItems().catch(()=>{});await host.wakeTask(task.id)}assert.equal(requests,1);assert.equal(host.tasks.get(task.id).pending_delivery,delivery);assert.equal(host.tasks.pendingEffect(task.id)?.status,'unknown');assert.equal(host.tasks.evidence(task.id).length,0)
 }finally{await native?.close();await host.close();await rm(dir,{recursive:true,force:true})}
})

test('known unsent Nova injection retries the same queue identity',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-send-unknown-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let native:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined,requests=0;const injected:string[]=[]
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async()=>{throw Error('must not verify unknown delivery')},async *stream(){throw Error('unused')}},createTextProvider:options=>{const provider=buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){yield {kind:'response_started',response_id:'reply'};yield {kind:'text_delta',text:'Ready'};yield {kind:'response_completed',response_id:'reply'}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}}),inject=provider.injectHostItem.bind(provider),create=provider.createResponse.bind(provider);provider.injectHostItem=async(...args)=>{if(args[0].host_item_id.startsWith('task-response:')){injected.push(args[0].host_item_id);if(injected.length===1)throw Error('not sent')}return inject(...args)};provider.createResponse=async(...args)=>{if(args[0].kind==='task_continuation')requests++;return create(...args)};return provider}})
 native=await factory(createConversation('chat','Test',null,'chat:main'),()=>{});await native.runTurn('Prepare',new AbortController().signal);const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'Deliver a plan',acceptance:[],origin_ref:'conversation:1',execution_route:'nova'});await host.wakeTask(task.id);const service=native.bridgeService as RealtimeService;await service.flushHostItems();await until(()=>requests===1&&host.tasks.get(task.id).pending_delivery===undefined);assert.equal(injected.length,2);assert.equal(injected[0],injected[1]);assert.equal(requests,1)
 }finally{await native?.close();await host.close();await rm(dir,{recursive:true,force:true})}
})

test('production conversation links only selected declarations and clears Todo source before next turn',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-source-runtime-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let responses=0
 try{await host.open();await host.command({type:'personal.command',request_id:'todo',method:'life.mutate',params:{op:'create',kind:'todo',title:'Source',note:''}});const todo=host.life.snapshot().todos[0]!,source={id:todo.id,version:todo.version}
 host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async()=>{throw Error('leave waiting')},async *stream(){throw Error('unused')}},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){const n=++responses,r='source:'+n;yield {kind:'response_started',response_id:r};if(n===1||n===2){const id=n===1?'linked':'independent',linked=n===1;yield {kind:'tool_call',item_id:id,call_id:id,name:'task',arguments:{operation:'declare',goal:id,acceptance:[],source_refs:[],link_source_todo:linked,origin_ref:'conversation:1'}}}else if(n===4)yield {kind:'tool_call',item_id:'later',call_id:'later',name:'task',arguments:{operation:'declare',goal:'Must not inherit',acceptance:[],source_refs:[],link_source_todo:true,origin_ref:'conversation:2'}};else yield {kind:'text_delta',text:'ack'};yield {kind:'response_completed',response_id:r}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}})}),()=>{})
 await host.submitConversationText('chat:main','Handle source and independently write a note','first',source);await host.waitConversation('chat:main');assert.equal(host.tasks.list().length,2);assert.deepEqual(host.tasks.list().find(t=>t.goal==='linked')!.todo_ref,source);assert.equal(host.tasks.list().find(t=>t.goal==='independent')!.todo_ref,undefined)
 await host.submitConversationText('chat:main','Handle source and independently write a note','first',source);assert.equal(host.tasks.list().length,2)
 await host.submitConversationText('chat:main','Unrelated next turn','next');await host.waitConversation('chat:main');assert.equal(host.tasks.list().length,2)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('a selected Todo stays linkable after a confirmation turn and expires after a few unrelated turns',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-source-followup-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let responses=0;const declareAt=new Set([2,8])
 try{await host.open()
  for(const title of ['Confirmed','Expired'])await host.command({type:'personal.command',request_id:title,method:'life.mutate',params:{op:'create',kind:'todo',title,note:''}})
  const ref=(title:string)=>{const todo=host.life.snapshot().todos.find(todo=>todo.title===title)!;return {id:todo.id,version:todo.version}},confirmed=ref('Confirmed'),expired=ref('Expired')
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async()=>{throw Error('leave waiting')},async *stream(){throw Error('unused')}},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){const n=++responses,r='followup:'+n;yield {kind:'response_started',response_id:r};if(declareAt.has(n))yield {kind:'tool_call',item_id:'d'+n,call_id:'d'+n,name:'task',arguments:{operation:'declare',goal:'goal '+n,acceptance:[],source_refs:[],link_source_todo:true,origin_ref:'conversation:'+n}};else yield {kind:'text_delta',text:'Shall I start?'};yield {kind:'response_completed',response_id:r}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}})}),()=>{})
  await host.submitConversationText('chat:main','Please help with this Todo','ask',confirmed);await host.waitConversation('chat:main');assert.equal(host.tasks.list().length,0)
  await host.submitConversationText('chat:main','Yes, go ahead','yes');await host.waitConversation('chat:main')
  assert.deepEqual(host.tasks.list().find(task=>task.goal==='goal 2')?.todo_ref,confirmed,'the confirmation turn links the Todo selected one turn earlier')
  await host.submitConversationText('chat:main','Another Todo','other',expired);await host.waitConversation('chat:main')
  for(const id of ['a','b','c','d']){await host.submitConversationText('chat:main','Unrelated '+id,id);await host.waitConversation('chat:main')}
  await host.submitConversationText('chat:main','Now do it','late');await host.waitConversation('chat:main')
  assert.equal(host.tasks.list().some(task=>task.todo_ref?.id===expired.id),false,'a stale selection is not linked after it expires')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('an input the executor accepted while control was handed back is labelled as sent before handback',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-input-late-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 try{
  const task=await tasks.delegate('delegate',{conversation_id:'c',goal:'Goal',acceptance:[],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:0,goal_revision:0},actor={kind:'user' as const,client_id:'client'}
  await tasks.bindWork(fence,'work','session');await tasks.controlClient('take',fence,'client','takeover');fence.control_revision=1
  let release!:()=>void,entered!:()=>void
  const waiting=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const pending=tasks.input('late',fence,actor,'session','written already',async()=>{entered();await gate;return 'accepted'})
  await waiting;await tasks.returnClientTasks('mode-exit','client');release()
  assert.equal(await pending,'accepted')
  const late=tasks.events(task.id,0).items.filter(event=>event.kind==='control'&&event.text.includes('input_before_handback'))
  assert.equal(late.length,1)
  await tasks.controlClient('retake',{...fence,control_revision:2},'client','takeover')
  assert.equal(await tasks.input('prompt',{...fence,control_revision:3},actor,'session','in fence',async()=>'accepted'),'accepted')
  assert.equal(tasks.events(task.id,0).items.filter(event=>event.text.includes('input_before_handback')).length,1,'in-fence sends are not labelled')
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})
test('finished tasks beyond the retention cap leave the store, their requests stay spent, and unresolved ones stay',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-retention-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 try{
  const fence=(taskId:string)=>({task_id:taskId,control_revision:0,goal_revision:0})
  const unresolved=await tasks.delegate('unresolved',{conversation_id:'c',goal:'Held',acceptance:[],origin_ref:'conversation:0'})
  await tasks.bindWork(fence(unresolved.id),'held-work','held-session');await tasks.controlClient('take',fence(unresolved.id),'client','takeover')
  assert.equal(await tasks.input('held-input',{...fence(unresolved.id),control_revision:1},{kind:'user',client_id:'client'},'held-session','hi',async()=>'unknown'),'unknown')
  await tasks.cancel('held-cancel',{...fence(unresolved.id),control_revision:1},{kind:'user',client_id:'client'})
  const ids:string[]=[]
  for(let index=0;index<203;index++){const task=await tasks.delegate('d'+index,{conversation_id:'c',goal:'Goal '+index,acceptance:[],origin_ref:'conversation:'+index});ids.push(task.id);await tasks.appendEvent({task_id:task.id,kind:'message',sender:'nova',text:'note',refs:[]},'note');await tasks.cancel('c'+index,fence(task.id),{kind:'nova'})}
  const kept=new Set(tasks.list().map(task=>task.id))
  assert.ok(!kept.has(ids[0]!)&&!kept.has(ids[2]!),'oldest finished tasks are retired');assert.ok(kept.has(ids[3]!)&&kept.has(ids[202]!))
  assert.ok(kept.has(unresolved.id),'a task with an unknown effect is never retired')
  await tasks.close();const restored=new TaskService(tasks.path);await restored.open()
  assert.equal(restored.list().length,201);assert.throws(()=>restored.get(ids[0]!),/task_not_found/)
  await assert.rejects(restored.delegate('d0',{conversation_id:'c',goal:'Goal 0',acceptance:[],origin_ref:'conversation:0'}),/task_retired/,'replaying a retired delegation never starts it again')
  await assert.rejects(restored.cancel('c0',fence(ids[0]!),{kind:'nova'}),/task_retired/)
  await assert.rejects(restored.delegate('d0',{conversation_id:'c',goal:'Other',acceptance:[],origin_ref:'conversation:0'}),/request_conflict/)
  assert.equal(restored.list().length,201)
  const retried=await restored.delegate('d203',{conversation_id:'c',goal:'Fresh',acceptance:[],origin_ref:'conversation:203'});assert.equal(restored.get(retried.id).goal,'Fresh')
  await restored.close()
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('the store retires old finished tasks by size before large results fill it',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-bytes-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 try{
  const ids:string[]=[]
  for(let index=0;index<60;index++){
   const task=await tasks.delegate('d'+index,{conversation_id:'c',goal:'Goal '+index,acceptance:[],origin_ref:'conversation:'+index,execution_route:'codex'}),fence={task_id:task.id,control_revision:0,goal_revision:0};ids.push(task.id)
   await tasks.bindWork(fence,'w'+index,'s'+index);const ref=await tasks.recordWorkOutcome('w'+index,'ok',{output:'结'.repeat(131072)})
   await tasks.applyDecision(fence,{kind:'complete',evidence_refs:[ref!]})
  }
  const kept=new Set(tasks.list().map(task=>task.id))
  assert.ok(kept.size<60&&kept.has(ids[59]!)&&!kept.has(ids[0]!),'the oldest large tasks were retired and the newest kept')
  assert.ok((await stat(tasks.path)).size<=12*1024*1024)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})
test('an unfinished task keeps its session between works; only a finished one gives it up',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-session-hold-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 try{
  const a=await tasks.delegate('a',{conversation_id:'c',goal:'A',acceptance:[],origin_ref:'conversation:1',execution_route:'codex'}),fa={task_id:a.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fa,'wa','session');await tasks.recordWorkOutcome('wa','ok',{});await tasks.wait(fa,'Needs user check')
  const b=await tasks.delegate('b',{conversation_id:'c',goal:'B',acceptance:[],origin_ref:'conversation:2',execution_route:'codex'}),fb={task_id:b.id,control_revision:0,goal_revision:0}
  await assert.rejects(tasks.bindWork(fb,'wb','session'),/session_active/)
  assert.deepEqual(tasks.get(a.id).session_ids,['session']);assert.equal(tasks.get(a.id).primary_session_id,'session')
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})
test('each work records its executor and one session; the first session becomes primary and follows the session when it moves',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-works-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 try{
  const task=await tasks.delegate('a',{conversation_id:'c',goal:'A',acceptance:[],origin_ref:'conversation:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.setRoute(fence,'codex');await tasks.bindWork(fence,'w1');await tasks.bindWork(fence,'w1','s1');await tasks.bindWork(fence,'w2','s2')
  await tasks.setRoute(fence,'midscene');await tasks.bindWork(fence,'w3','s3')
  const bound=tasks.get(task.id)
  assert.deepEqual(bound.works,[{work_id:'w1',executor:'codex',session_id:'s1'},{work_id:'w2',executor:'codex',session_id:'s2'},{work_id:'w3',executor:'midscene',session_id:'s3'}])
  assert.equal(bound.primary_session_id,'s1')
  await assert.rejects(tasks.bindWork(fence,'w1','s2'),/work_session_conflict/)
  for(const work of ['w1','w2','w3'])await tasks.recordWorkOutcome(work,'ok',{worker:'test',final_message:'Done'})
  await tasks.cancel('stop',fence,{kind:'nova'})
  const other=await tasks.delegate('b',{conversation_id:'c',goal:'B',acceptance:[],origin_ref:'conversation:2'})
  await tasks.bindWork({task_id:other.id,control_revision:0,goal_revision:0},'w4','s1')
  assert.equal(tasks.get(task.id).primary_session_id,undefined);assert.equal(tasks.get(other.id).primary_session_id,'s1')
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})
