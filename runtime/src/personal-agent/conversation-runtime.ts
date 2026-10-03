import {quarantineTaskResources} from '../executors/task-resources.js'
import {access} from 'node:fs/promises'
import {parseMemoryRef} from '../core/memory.js'
import {GatewayTaskVerifier} from '../model/task-verifier.js'
import type {TaskFence} from './tasks.js'
import {TaskExecutionRejected} from './task-loop.js'
import type {TaskDispatchContext} from '../core/task-tools.js'
import {createTurnDeadline} from './turn-deadline.js'
import {CodingTargetController} from './coding-targets.js'
import {ProjectResolutionError, type ProjectExecutorAdapter} from '../executors/coding-executor.js'
import {projectExecutorEvent,type ExecutorProgress,type ExecutorResult} from '../desktop/desktop-progress.js'
import {captureConversationFrame} from '../core/camera-session.js'
import {supportsVision} from '../model/vision-capability.js'
import {requireSelectedCascadedLlmConfig} from '../config/cascaded-realtime-config.js'
import {prerecallContext} from '../memory/prerecall.js'
import {ProjectConfirmationController} from '../projects/project-confirmation.js'
import {buildConversationVoiceProvider} from '../conversation-voice-provider.js'
import {randomUUID} from 'node:crypto'
import {createHash} from 'node:crypto'
import {buildAssembly,type AssemblyOptions} from '../composition/assembly.js'
import {buildRealtimeAssembly,configuredMemoryConsumer,defaultIntake,type RealtimeAssemblyOptions} from '../composition/realtime-assembly.js'
import {buildCascadedTextProvider} from '../cascaded-text-provider.js'
import type {PersonalAgentHost} from './host.js'
import type {PersonalMemoryResource} from '../memory/personal-memory.js'
import type {ConversationRuntimeFactory} from './conversations.js'
import {scopeApprovalController} from './approval-scope.js'
import {deliveryToEvent,executorApprovalMessage,projectStateMessage} from '../desktop/desktop-wire.js'

const SOURCE_TODO_TURNS=4
/** Prepared topic text must retain evidence authorization for the actual model recipient. */

export async function maySendPreparedMemory(memory: PersonalMemoryResource|undefined, consumer: string|undefined, refs: readonly string[]): Promise<boolean> {
 if (!memory?.canReadConversationEvidence || !consumer || refs.length === 0) return false
 for (const ref of refs) if (!await memory.canReadConversationEvidence(ref, consumer)) return false
 return true
}

/** Reuses deployment resources while allocating a separate causal runtime, provider and session. */
export function conversationRuntimeFactory(options:AssemblyOptions & Pick<RealtimeAssemblyOptions,'codexResource'|'onDiagnostic'|'onAudioFrame'|'onAudioClear'|'onAudioAlert'|'onAudioTerminal'|'nextPlaybackGeneration'|'onUsage'> & {
 onExecutorProgress?:(progress:ExecutorProgress,result?:ExecutorResult)=>void;
 createTextProvider?:typeof buildCascadedTextProvider;
 createVoiceProvider?:typeof buildConversationVoiceProvider;
 host:PersonalAgentHost; memory:()=>PersonalMemoryResource|undefined
}):ConversationRuntimeFactory {
 return async(conversation,emit,mode='text',lifetime=new AbortController().signal,recovery=false)=>{
  const targetPort=options.codexResource?.mode==='project'?(options.codexResource.adapter as ProjectExecutorAdapter).targetPort:undefined
  const codingTarget=targetPort?new CodingTargetController(targetPort,(target,stillCurrent)=>options.host.rememberCodingTarget(conversation.id,conversation.generation,target,()=>!lifetime.aborted&&stillCurrent())):undefined
  if(codingTarget&&conversation.coding_target){
   try{await codingTarget.setTarget(conversation.coding_target)}
   catch(error){
    if(!(error instanceof ProjectResolutionError)||!['unknown_project','unknown_session'].includes(error.code))throw error
    await codingTarget.setTarget(null)
    await options.host.rememberCodingTarget(conversation.id,conversation.generation,null,()=>!lifetime.aborted)
    options.onDiagnostic?.('[runtime-diagnostic] coding_target_unavailable')
    emit({type:'conversation.notice',code:'coding_target_unavailable',message:'之前选择的编程项目或会话已不可用，已清除默认目标。你仍可继续聊天；需要编程时请重新选择目标。'})
   }
  }
  const ownsTask=()=>options.host.tasks.list().some(task=>task.conversation_id===conversation.id&&(task.conversation_generation??0)===conversation.generation&&task.phase!=='completed'&&task.phase!=='cancelled')
  const history:{user:string;assistant:string}[]=[]
  let user:string|undefined
  for(const message of conversation.messages){if(message.role==='user')user=message.text;else {if(message.delivery!==undefined&&message.delivery!=='completed'){user=undefined;continue;}const paired=message.reply_to?conversation.messages.find(item=>item.id===message.reply_to&&item.role==='user')?.text:user;if(paired!==undefined)history.push({user:paired,assistant:message.text});user=undefined}}
  const recentHistory=history.filter(pair=>pair.user.length<=4000&&pair.assistant.length<=4000).slice(-32)
  if(mode==='voice'&&options.settings.pipeline_mode==='integrated'){while(recentHistory.length&&JSON.stringify(recentHistory).length>3000)recentHistory.shift()}
  const selectedLlm=requireSelectedCascadedLlmConfig(options.settings)
  const captureFrame=options.settings.conversation_vision_enabled&&options.frameSource&&supportsVision(selectedLlm.provider,selectedLlm.config.model)?(signal:AbortSignal)=>captureConversationFrame(options.frameSource!,signal,core.mediaStore):undefined
  const suffix=createHash('sha256').update(conversation.id+':'+conversation.generation).digest('hex').slice(0,24)
  if(recovery&&options.host.tasks.list().some(task=>task.conversation_id===conversation.id&&task.conversation_generation===conversation.generation&&task.execution_route!=='nova'&&options.host.tasks.hasUnresolvedExecution(task.id))){
   if(options.codexResource?.mode==='project')(options.codexResource.adapter as ProjectExecutorAdapter).taskPort?.quarantineResources?.()
   quarantineTaskResources(options.externalMcp?.adapters.flatMap(adapter=>adapter.taskResource()?[adapter.taskResource()!]:[])??[])
  }
  if(recovery){if(!options.blackboard)throw Error('task_blackboard_unavailable');try{await access(options.blackboard.path+'.conversation-'+suffix)}catch{throw Error('task_blackboard_unavailable')}}
  const core=buildAssembly({...options,taskHost:true,sharedResources:true,cameraModuleEnabled:false,conversationId:conversation.id+':'+conversation.generation,
   ...(options.blackboard?{blackboard:{...options.blackboard,path:options.blackboard.path+'.conversation-'+suffix}}:{}),
   ids:{next:namespace=>namespace+'-'+randomUUID()},
   ...(options.codexResource?{executors:[options.codexResource.adapter],agentDescriptors:options.codexResource.agentDescriptor?[options.codexResource.agentDescriptor]:[]}:{}),
  })
  const refreshCodingTarget=()=>{if(!lifetime.aborted)void codingTarget?.refreshWork().catch(()=>options.onDiagnostic?.('[runtime-diagnostic] coding_target_update_failed'))}
  const unsubscribeTarget=targetPort?(options.codexResource!.adapter as ProjectExecutorAdapter).observeProjectView(refreshCodingTarget):undefined
  const waitingListeners=new Set<()=>void>()
  const notifyWaiting=()=>{for(const listener of waitingListeners)listener()}
  const broker=options.codexResource?.approvalController
  const approval=broker?scopeApprovalController(broker,view=>!!view.work&&core.runtime.inFlightDelegate(view.work.work_id)!==undefined):undefined
  const unsubscribeApproval=approval?.observe(view=>{options.host.recordTaskApproval(conversation.id,conversation.generation,view);notifyWaiting();if(view.work)void options.host.rememberWorkOwner(view.work.work_id,conversation.id,view.pending_approval_id).catch(()=>{ /* durable projection retried on work event */ });const manifest=options.codexResource!.adapter.manifest;emit(JSON.parse(executorApprovalMessage(view,core.runtime.clock.now(),{executor:manifest.name,display_name:manifest.display_name})) as Record<string,unknown>)})
  const memoryConsumerFingerprint=configuredMemoryConsumer(options.settings,mode)
  const provider=(mode==='voice'?(options.createVoiceProvider??buildConversationVoiceProvider):(options.createTextProvider??buildCascadedTextProvider))({settings:options.settings,clock:core.runtime.clock,idFactory:()=>randomUUID(),history:recentHistory,...(captureFrame?{captureFrame}:{}),executorApproval:approval!==undefined,...(options.onUsage?{onUsage:options.onUsage}:{}),...(options.telemetry?{telemetry:options.telemetry}:{}),...(mode==='text'&&options.settings.memory_prerecall_enabled?{prerecall:async(query:string,signal:AbortSignal)=>{const result=await graph.retrieval.recall(query,{scope:'any',limit:3,signal,consumer:memoryConsumerFingerprint??''});signal.throwIfAborted();return async(consumeSignal:AbortSignal)=>{const current=await graph.retrieval.revalidate(result,consumeSignal);consumeSignal.throwIfAborted();return prerecallContext(query,current)}}}:{})})
  let pending:{resolve:(result:{assistant:string;turn_id?:string})=>void;reject:(error:unknown)=>void}|undefined
  const textOnly=mode==='text'
  let voiceEnabled=!textOnly
  let assistant=''
  let assistantTurnId:string|undefined
  const captionIds=new Map<string,string>()
  const taskResponses=new Map<string,Map<string,TaskFence>>()
  const taskForegroundResponses=new Set<string>()
  const deferredTaskWakes=new Set<string>()
  const taskHostItems=new Map<string,TaskFence>()
  const taskResponseItems=new Map<string,string>()
  const taskToolResponses=new Set<string>()
  let taskTurnContinuing=false
  let currentResponse:string|undefined
  const captureTaskResponse=()=>{
   if(!currentResponse||!taskForegroundResponses.has(currentResponse))return
   const selected=taskResponses.get(currentResponse);if(!selected)return
   const origin=graph.service.taskTurnOrigin()
   for(const task of options.host.tasks.list())if(task.origin_ref===origin&&task.conversation_id===conversation.id&&(task.conversation_generation??0)===conversation.generation&&task.phase!=='completed'&&task.phase!=='cancelled'&&!selected.has(task.id))selected.set(task.id,{task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision})
  }
  const settleTaskResponse=async(responseId:string,text:string,delivered:boolean)=>{
   const selected=taskResponses.get(responseId);if(!selected)return
   const itemId=taskResponseItems.get(responseId);taskResponseItems.delete(responseId);if(itemId)taskHostItems.delete(itemId)
   taskResponses.delete(responseId);taskForegroundResponses.delete(responseId)
   for(const fence of selected.values())try{
    if(itemId)await options.host.tasks.finishDelivery(fence.task_id,itemId)
    const task=options.host.tasks.get(fence.task_id)
    if(delivered&&text.trim()&&(!task.execution_route||task.execution_route==='nova'))await options.host.tasks.recordDelivery(fence,responseId+':'+task.id,text)
    if(task.execution_route&&task.execution_route!=='nova'&&!task.work_ids.length){if(task.phase==='queued')await options.host.tasks.wait(fence,'executor_admission_pending');continue}
    if(!delivered&&(!task.execution_route||task.execution_route==='nova')){await options.host.tasks.wait(fence,'delivery_interrupted');continue}
    if(text.trim())await options.host.wakeTask(task.id)
   }catch{options.onDiagnostic?.('[runtime-diagnostic] task_delivery_or_check_failed')}
  }
  const projectConfirmation=options.codexResource?.mode==='project'?new ProjectConfirmationController({clock:core.runtime.clock,idFactory:()=>randomUUID(),onChange:view=>{notifyWaiting();options.host.recordConfirmation(conversation.id,view);emit(JSON.parse(projectStateMessage(view)) as Record<string,unknown>)}}):undefined
  // A selected Todo stays linked for a few follow-up turns so "confirm first, then run" still links it; history restores it after restart.
  let sourceTodo:{id:string;version:number}|undefined,sourceOrigin:string|undefined,sourceTodoTurns=0
  {const users=conversation.messages.filter(message=>message.role==='user').slice(-SOURCE_TODO_TURNS),index=users.findLastIndex(message=>message.source_todo);if(index>=0){sourceTodo={...users[index]!.source_todo!};sourceTodoTurns=SOURCE_TODO_TURNS-(users.length-index)}}
  const sourceTodoCurrent=()=>{if(!sourceTodo)return false;const todo=options.host.life.snapshot().todos.find(todo=>todo.id===sourceTodo!.id);return todo?.version===sourceTodo.version&&todo.status!=='done'&&todo.status!=='cancelled'&&!options.host.tasks.list().some(task=>task.todo_ref?.id===sourceTodo!.id)}
  const graph=buildRealtimeAssembly({core,provider,memoryReadMode:mode,taskSourceTodo:origin=>{if(!sourceTodo||origin!==sourceOrigin||graph.service.taskTurnOrigin()!==origin)return;const todo=options.host.life.snapshot().todos.find(todo=>todo.id===sourceTodo!.id);if(todo?.version!==sourceTodo.version)throw Error('source_todo_conflict');return {...sourceTodo}},taskConversationId:conversation.id,taskConversationGeneration:conversation.generation,taskFrontendCurrent:()=>!lifetime.aborted,
   ...(memoryConsumerFingerprint?{memoryConsumerFingerprint}:{}),
   ...(options.nextPlaybackGeneration?{nextPlaybackGeneration:options.nextPlaybackGeneration}:{}),
   ...(options.onAudioFrame?{onAudioFrame:frame=>{if(!lifetime.aborted&&voiceEnabled&&options.host.presentationMode!=='background'&&(conversation.id!=='chat:proactive'||options.host.conversationSnapshot().voice_id===conversation.id||options.host.presentationMode===null||options.host.presentationMode==='orb'))options.onAudioFrame?.(frame)}}:{}),...(options.onAudioClear?{onAudioClear:options.onAudioClear}:{}),...(options.onAudioAlert?{onAudioAlert:options.onAudioAlert}:{}),...(options.onAudioTerminal?{onAudioTerminal:options.onAudioTerminal}:{}),sharedPersonal:{host:options.host,memory:options.memory()},
   ...(projectConfirmation?{projectConfirmation}:{}),...(codingTarget?{codingTarget}:{}),
   ...(options.codexResource?{codexResource:options.codexResource,codingAgentControllerFactory:options.codexResource.agentControllerFactory}:{}),
   ...(approval?{executorApproval:approval}:{}),
   ...(defaultIntake(core,core.gateway,options.settings)?{intake:defaultIntake(core,core.gateway,options.settings)!}:{}),
   ...(options.onDiagnostic?{onDiagnostic:options.onDiagnostic}:{}),
   onDelivery:completion=>{if(mode==='voice'&&!taskToolResponses.has(completion.response_id))void settleTaskResponse(completion.response_id,completion.text,completion.disposition==='spoken').finally(()=>{const deferred=[...deferredTaskWakes];deferredTaskWakes.clear();for(const taskId of deferred)void options.host.wakeTask(taskId)});const payload=deliveryToEvent(completion);if(payload)core.runtime.post({kind:'assistant_spoken',payload});if(completion.disposition!=='suppressed'&&completion.text)emit({type:'conversation.delivered',role:'assistant',text:completion.text,turn_id:captionIds.get(completion.response_id)??completion.utterance_id,delivery:completion.disposition==='spoken'?'completed':'interrupted',final:true})},
   onCaption:frame=>{if(frame.role==='assistant'){assistant=frame.full_text??frame.text;assistantTurnId=frame.turn_id;if(frame.turn_id){const marker=frame.turn_id.indexOf(':assistant:');if(marker>=0)captionIds.set(frame.turn_id.slice(marker+11),frame.turn_id);if(captionIds.size>128)captionIds.delete(captionIds.keys().next().value!)}}emit({type:'caption',...frame})},
   onProviderEvent:event=>{
    if(event.kind==='user_transcript_final'&&event.input_kind==='text'&&sourceTodo&&sourceOrigin===undefined)sourceOrigin=graph.service.taskTurnOrigin()
    if(event.kind==='tool_call_ready'&&currentResponse){taskToolResponses.add(currentResponse);taskTurnContinuing=true}
    if(event.kind==='response_started'){
     assistant='';assistantTurnId=undefined;currentResponse=event.response_id
     const hostItems=graph.service.session.responseHostItemIds(event.response_id)
     const itemId=event.origin?.kind==='host_request'?event.origin.host_item_id:hostItems.find(id=>taskHostItems.has(id)),bound=itemId?taskHostItems.get(itemId):undefined
     if(bound&&itemId)taskResponseItems.set(event.response_id,itemId)
     taskResponses.set(event.response_id,bound?new Map([[bound.task_id,bound]]):new Map<string,TaskFence>())
     if(!bound&&((!event.origin&&hostItems.length===0)||event.origin?.kind==='user_item'||graph.service.session.responseIsToolContinuation(event.response_id))){taskForegroundResponses.add(event.response_id);captureTaskResponse()}
    }
    if(event.kind==='response_terminal'){
     const hasTools=taskToolResponses.delete(event.response_id)
     captureTaskResponse();if(currentResponse===event.response_id)currentResponse=undefined
     if(!hasTools||event.status!=='completed')taskTurnContinuing=false
     if(event.status==='completed'&&assistant.trim()&&(mode==='voice'||!pending))emit({type:mode==='voice'?'conversation.generated':'conversation.completed',role:'assistant',text:assistant,turn_id:assistantTurnId??event.response_id,delivery:mode==='voice'?'generated':'completed',final:true})
     if(hasTools&&event.status==='completed'){taskResponses.delete(event.response_id);taskForegroundResponses.delete(event.response_id)}
     else if(mode==='text'||event.status!=='completed')void settleTaskResponse(event.response_id,assistant,event.status==='completed').finally(()=>{const deferred=[...deferredTaskWakes];deferredTaskWakes.clear();for(const taskId of deferred)void options.host.wakeTask(taskId)})
     if(pending&&(event.status!=='completed'||(!hasTools&&assistant.trim()!==''))){const current=pending;pending=undefined;if(event.status==='completed')current.resolve({assistant,...(assistantTurnId?{turn_id:assistantTurnId}:{})});else current.reject(Error('response_'+event.status))}
    }
   },
  })
  const unsubscribeProgress=core.runtime.observe((event,current)=>{if(current===false)return;refreshCodingTarget();const projected=projectExecutorEvent(event,core.runtime,channel=>graph.service.agentNameForChannel(channel));if(!projected)return;void options.host.rememberWorkOwner(projected.progress.delegate_id,conversation.id).catch(()=>{ /* host projection failure */ });options.onExecutorProgress?.(projected.progress,projected.result);if(mode==='voice'&&!voiceEnabled&&projected.result&&!options.host.tasks.list().some(task=>task.work_ids.includes(projected.result!.delegate_id)))emit({type:'conversation.completed',role:'assistant',text:projected.result.summary,turn_id:'task:'+projected.result.delegate_id,delivery:'completed',final:true})})
  projectConfirmation?.setBackground(options.host.presentationMode==='background')
  let presentationPaused=false
  const unsubscribePresentation=options.host.subscribePresentation(async(mode,seen)=>{
   if(mode==='background')projectConfirmation?.setBackground(true)
   else if(!seen)projectConfirmation?.setBackground(false,{awaitPresentation:true})
   else if(seen?.proposal_id&&seen.conversation_id===conversation.id&&projectConfirmation?.view.pending_confirmation_id===seen.proposal_id)projectConfirmation.setBackground(false)
   if(!seen){const paused=!textOnly&&!voiceEnabled||mode==='background'||mode==='workbench'&&conversation.id==='chat:proactive'&&options.host.conversationSnapshot().voice_id!==conversation.id;if(paused||presentationPaused)await graph.service.playbackDisconnected({resumeDelivery:!paused});presentationPaused=paused}
  })
  try{await graph.start();if(conversation.prepared&&await maySendPreparedMemory(options.memory(),memoryConsumerFingerprint,conversation.prepared.evidence_refs))await provider.injectHostItem({kind:'dialogue_context',host_item_id:randomUUID(),event_id:randomUUID(),call_id:null,content:JSON.stringify({trust:'untrusted_external',purpose:'read_only_topic_background',text:conversation.prepared.text.slice(0,2000),evidence_refs:conversation.prepared.evidence_refs.slice(0,2)})},{confirmationTimeout:null,asUserActivation:false,signal:AbortSignal.timeout(10000)})}catch(error){unsubscribeTarget?.();unsubscribePresentation();unsubscribeProgress();unsubscribeApproval?.();await graph.stop();await core.stop();throw error}
  const detachForeground=()=>{if(ownsTask()){graph.service.detachTaskConversation();voiceEnabled=false;void graph.service.playbackDisconnected({resumeDelivery:false})}}
  lifetime.addEventListener('abort',detachForeground,{once:true})
  const adapter=options.codexResource?.mode==='project'?options.codexResource.adapter as ProjectExecutorAdapter:undefined
  const dispatchTarget=async(grant:TaskDispatchContext,sessionId:string,text:string,receipt?: (status:'accepted'|'failed'|'unknown')=>void)=>{
   let target
   try{
    const task=options.host.tasks.get(grant.fence.task_id)
    if(!task.session_ids.includes(sessionId))return {accepted:false,delegate_id:null}
    target=await adapter?.taskPort?.resolveSession?.(sessionId)
   }catch{return {accepted:false,delegate_id:null}}
   if(!target||!adapter)return {accepted:false,delegate_id:null}
   if(!grant.stillWanted())return {accepted:false,delegate_id:null}
   return core.runtime.dispatchTaskExternal({executor:adapter.manifest.name,op:target.active?'steer':'run',origin_ref:grant.origin_ref,request:target.active?{instruction:text,project:target.project,session_id:target.session_id,work_id:target.work_id!}:{work_order:text,project:target.project,session_id:target.session_id,session:'latest'}},{kind:'realtime_tool',priority:100,routing_class:'user_awaited',origin:null,selected_suggestion:null},grant,receipt)
  }
  const taskVerifier=core.personalAgentConfig?.taskVerifier??new GatewayTaskVerifier({gateway:core.gateway,model:options.settings.support_model})
  const detachTaskRuntime=options.host.attachTaskRuntime(conversation.id,conversation.generation,{
   recover:async task=>{
    const [channel,sequence]=parseMemoryRef(task.origin_ref);if(!core.runtime.memory.channels.get(channel)?.getBySeq(sequence))return 'task_origin_unavailable';
    for(const session of task.session_ids){if(!adapter?.taskPort?.inspectSession)return 'task_session_inspection_unavailable';const reason=await adapter.taskPort.inspectSession(session);if(reason)return reason}
    return null
   },
   routes:()=>['nova',...graph.service.taskRoutes()],
   ready:task=>{if(currentResponse||taskTurnContinuing)deferredTaskWakes.add(task.id);return currentResponse===undefined&&!taskTurnContinuing},
   detail:adapter?'public-events':'summary-only',
   evaluate:(task,signal)=>taskVerifier.evaluateTask(task,options.host.tasks.evidence(task.id),signal,options.host.tasks.inputReceipts(task.id)),
   input:async(grant,sessionId,text)=>{
    let resolve!:(status:'accepted'|'failed'|'unknown')=>void
    const acknowledged=new Promise<'accepted'|'failed'|'unknown'>(done=>{resolve=done})
    const admission=await dispatchTarget(grant,sessionId,text,resolve)
    if(!admission.accepted)return 'failed'
    return acknowledged
   },
   cancelTask:taskId=>{for(const [itemId,fence] of taskHostItems)if(fence.task_id===taskId)taskHostItems.delete(itemId);for(const [responseId,tasks] of taskResponses)if(tasks.has(taskId))void provider.cancelResponse(responseId,new AbortController().signal).catch(()=>options.onDiagnostic?.('[runtime-diagnostic] task_response_cancel_failed'))},
   cancel:workId=>{core.runtime.cancelPendingDispatch(workId);adapter?.taskPort?.cancelTask(workId)},
   dispatch:async(grant,instruction,sessionId)=>{
    try{options.host.tasks.validateContinuation(grant)}catch{throw new TaskExecutionRejected('task_continuation_stale')}
    const bound=options.host.tasks.get(grant.fence.task_id),sessions=bound.session_ids
    // Continue where the task already runs; switching sessions has to be explicit.
    const sameExecutor=(session:string)=>!bound.execution_route||(bound.works??[]).some(work=>work.session_id===session&&work.executor===bound.execution_route)
    const target=sessionId??(bound.primary_session_id&&sessions.includes(bound.primary_session_id)&&sameExecutor(bound.primary_session_id)?bound.primary_session_id:sessions.length===1&&sameExecutor(sessions[0]!)?sessions[0]:undefined)
    if(target){const result=await dispatchTarget(grant,target,instruction);if(!result.accepted)throw new TaskExecutionRejected('executor_admission_refused');return result}
    const task=options.host.tasks.get(grant.fence.task_id)
    if(task.execution_route&&task.execution_route!=='nova'){
     if(!graph.service.taskRoutes().includes(task.execution_route))throw new TaskExecutionRejected('task_executor_unavailable')
     const result=await graph.service.dispatchTask(grant,instruction)
     if(result.code!=='delegated'&&result.code!=='intake_opened'&&result.code!=='intake_in_progress')throw new TaskExecutionRejected(result.code)
     if(result.code!=='delegated')await options.host.tasks.wait(grant.fence,'executor_'+result.detail.state)
     return result
    }
    const itemId='task-response:'+randomUUID();try{await options.host.tasks.beginDelivery(grant.fence,itemId)}catch{throw new TaskExecutionRejected('task_delivery_admission_failed')}taskHostItems.set(itemId,grant.fence);let notDelivered=false
    graph.service.queueHostItem({kind:'task_continuation',item:{kind:'recovery',host_item_id:itemId,event_id:itemId,call_id:null,content:JSON.stringify({purpose:'continue_authorized_task',task_id:task.id,original_goal:task.original_goal,goal:task.goal,acceptance:task.acceptance,instruction,origin_ref:task.origin_ref})},task_summary:null,origin_spoken:false},{stillWanted:grant.stillWanted,onNotDelivered:async()=>{notDelivered=true;taskHostItems.delete(itemId);await options.host.tasks.finishDelivery(task.id,itemId)}})
    await graph.service.flushHostItems();if(notDelivered)throw new TaskExecutionRejected('task_delivery_not_requested')
    return {accepted:true}
   },
  })
  const unsubscribeTaskCapture=options.host.subscribe(captureTaskResponse)
  let closed=false
  const close=async()=>{if(closed)return;closed=true;lifetime.removeEventListener('abort',detachForeground);unsubscribeTasks();unsubscribeTaskCapture();detachTaskRuntime();unsubscribeTarget?.();options.host.recordConfirmation(conversation.id,{pending_confirmation:false,pending_confirmation_busy:false,workspace_display_name:null,session_title:null});unsubscribePresentation();approval?.invalidate('conversation_closed');unsubscribeProgress();unsubscribeApproval?.();pending?.reject(Error('conversation_closed'));pending=undefined;await graph.stop();await core.stop()}
  const unsubscribeTasks=options.host.subscribe(()=>{if(lifetime.aborted&&!ownsTask()&&core.runtime.core.activeDelegates().length===0)void close()})
  return {
   retainTasks:ownsTask,
   parkVoice:async()=>{voiceEnabled=false;await graph.service.playbackDisconnected({resumeDelivery:false})},
   canSwitch:()=>!pending&&!approval?.pending&&!projectConfirmation?.pending&&core.runtime.core.activeDelegates().length===0&&(voiceEnabled?graph.service.pendingHostItemCount===0:true)&&graph.playback.current===null,
   deliverSuggestion:(suggestion,reason)=>graph.service.onSuggestionSelected(suggestion,reason),
   ownsWork:id=>core.runtime.inFlightDelegate(id)!==undefined,bridgeService:graph.service,sendAudio:(pcm)=>graph.service.sendAudio(pcm),
   runTurn:async(text,callerSignal,context)=>{
    const deadline=createTurnDeadline({clock:core.runtime.clock,parent:callerSignal,isWaiting:()=>(approval?.pending===true||projectConfirmation?.pending===true),subscribe:listener=>{waitingListeners.add(listener);return()=>waitingListeners.delete(listener)}})
    const signal=deadline.signal;signal.throwIfAborted();if(context?.source_todo){sourceTodo={...context.source_todo};sourceTodoTurns=SOURCE_TODO_TURNS}else if(sourceTodoTurns>1)sourceTodoTurns--;else sourceTodo=undefined;if(sourceTodo&&!sourceTodoCurrent())sourceTodo=undefined;sourceOrigin=undefined;assistant='';assistantTurnId=undefined
    const done=new Promise<{assistant:string;turn_id?:string}>((resolve,reject)=>{pending={resolve,reject}}),current=pending
    const abort=()=>{
     pending?.reject(signal.reason??Error('conversation_cleared'));pending=undefined
     if(ownsTask()){
      if(lifetime.aborted)detachForeground()
      else void graph.service.playbackDisconnected({resumeDelivery:true}).catch(()=>{ /* response teardown is fenced by the service */ })
     }
     else void graph.service.clearConversation().catch(()=>{ /* clear installs its epoch fence before asynchronous teardown */ })
    }
    signal.addEventListener('abort',abort,{once:true})
    try{if(sourceTodo)await provider.injectHostItem({kind:'dialogue_context',host_item_id:randomUUID(),event_id:randomUUID(),call_id:null,content:JSON.stringify({purpose:'selected_todo_context',linked_todo_available:true,instruction:(context?.source_todo?'The upcoming user text has a selected Todo source.':'An earlier user turn in this conversation selected a Todo source and no task has handled it yet.')+' Only declarations explicitly handling that Todo should set link_source_todo=true. Independent tasks must omit it. This context does not authorize execution.'})},{confirmationTimeout:null,asUserActivation:false,signal});const [,result]=await Promise.all([graph.service.submitText(text),done]);return result}
    finally{sourceOrigin=undefined;deadline.close();if(pending===current)pending=undefined;signal.removeEventListener('abort',abort)}
   },
   close,
   confirmationDecision:(id,confirmed)=>projectConfirmation?.view.pending_confirmation_id===id?graph.service.projectConfirmationDecision(id,confirmed):Promise.reject(Error('confirmation_not_owned')),
   approvalDecision:(id,approved)=>approval?.acceptDecision({approvalId:id,decision:approved?'accept':'decline'})?Promise.resolve():Promise.reject(Error('approval_not_owned')),
  }
 }
}
