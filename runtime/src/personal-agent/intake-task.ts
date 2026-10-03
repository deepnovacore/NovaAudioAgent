import type {TaskDispatchContext} from '../core/task-tools.js'
import type {TaskFence,TaskService} from './tasks.js'

export interface IntakeTaskInput {
 readonly intake_id:string
 readonly task_fence?:TaskFence|undefined
 readonly conversation_id:string
 readonly conversation_generation?:number|undefined
 readonly goal:string
 readonly acceptance:readonly string[]
 readonly origin_ref:string
 readonly route:string
}

/**
 * Binds an intake dispatch to a task and admits it. A task created here is cancelled when the dispatch is
 * superseded or the runtime does not admit it; otherwise recovery would later run work the user was told
 * did not start. An existing task (task_fence) is never cancelled here.
 */
export async function admitIntakeTask<T extends {readonly accepted:boolean}>(
 tasks:TaskService,input:IntakeTaskInput,wanted:()=>boolean,
 admit:(grant:TaskDispatchContext)=>Promise<T>,
):Promise<T|'superseded'>{
 let created:string|undefined
 const abandon=async()=>{
  if(!created)return
  const task=tasks.get(created)
  await tasks.cancel('intake-abandon:'+input.intake_id,{task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision},{kind:'nova'}).catch(()=>undefined)
 }
 try{
  const task=input.task_fence?tasks.get(input.task_fence.task_id):await tasks.delegate('intake:'+input.intake_id,{
   conversation_id:input.conversation_id,...(input.conversation_generation===undefined?{}:{conversation_generation:input.conversation_generation}),
   goal:input.goal,acceptance:[...input.acceptance],origin_ref:input.origin_ref,
  })
  if(!input.task_fence)created=task.id
  const grant=tasks.continuationContext(input.task_fence??{task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision})
  await tasks.setRoute(grant.fence,input.route)
  if(!wanted()){await abandon();return 'superseded'}
  const admission=await admit(grant)
  if(!admission.accepted)await abandon()
  return admission
 }catch(error){await abandon();throw error}
}
