import {t} from './locale.mjs'
export const TASK_PHASE_LABEL={queued:'已排队',running:'进行中',verifying:'验证中',waiting:'等待处理',started:'已开始',working:'进行中',completed:'已完成',cancelled:'已停止',failed:'失败',refused:'已拒绝',unknown:'待确认'}
const WAITING_LABEL={task_check_unavailable:'暂时无法验证任务结果，请稍后重试',correction_limit:'自动修正次数已用完，请决定是否继续',task_effect_unknown:'操作结果待确认，请核对后继续',uncertain_recovery:'恢复结果待确认，请核对已有操作',task_delivery_uncertain:'上次交付状态待确认',delivery_interrupted:'交付已中断，请决定是否继续',task_executor_unavailable:'执行器暂不可用',task_runtime_unavailable:'任务执行服务暂不可用',task_runtime_recovery_unavailable:'任务执行服务尚未恢复',task_session_recovery_unavailable:'执行器会话尚未恢复',task_work_recovery_unavailable:'执行状态尚未恢复',task_recovery_blocked:'任务恢复待处理',task_execution_rejected:'本次执行未获接收，请核对任务状态',task_execution_unconfirmed:'执行是否开始仍待确认',task_initial_pending:'正在确认任务启动',executor_admission_pending:'正在等待执行器接收',execution_route_required:'请选择任务的执行方式',user_reconciled:'已核对执行结果，可以继续任务'}
export const taskWaitingLabel=reason=>reason?t(Object.hasOwn(WAITING_LABEL,reason)?WAITING_LABEL[reason]:'任务需要你处理'):''
/** Who acts next on a delegated task, in one short phrase for cards. */
export const taskNextStep=task=>task.phase==='waiting'?t('需要你：{0}',taskWaitingLabel(task.waiting_reason)||t('任务需要你处理')):task.controller?.kind==='user'?t('你在控制'):['completed','cancelled'].includes(task.phase)?t('无需操作'):t('Nova 在推进')
const DURABLE_ACTIVE=['queued','running','verifying','waiting'],WORK_ACTIVE=['started','working']
/** Counts delegated tasks plus executor work that no delegated task owns. */
export const activeTaskCount=(durable,work)=>{
 const records=durable?.tasks??[],owned=new Set(records.flatMap(task=>task.work_ids??[]))
 return records.filter(task=>DURABLE_ACTIVE.includes(task.phase)).length+(work?.tasks??[]).filter(item=>!owned.has(item.work_id)&&WORK_ACTIVE.includes(item.phase)).length
}
/**
 * Two levels: a delegated task is the user's intent; each executor work under it is one run.
 * Work without a delegated task is listed on its own so executor-only runs stay controllable.
 */
export function renderTasksPage(panel,{tasks,durableTasks,openTask,taskAction,results,card,chips,button,askProgress,local,rerender}){
 const state=tasks(),works=state?.tasks??[],records=durableTasks?.().tasks??[],retained=new Set(works.map(work=>work.work_id))
 for(const id of local.keys())if(!retained.has(id))local.delete(id)
 if(state?.error){const notice=card('任务列表暂时不可用',state.error);notice.classList.add('warn');notice.setAttribute('role','alert')}
 const owned=new Set(records.flatMap(task=>task.work_ids??[]))
 const unowned=works.filter(work=>!owned.has(work.work_id))
 if(!records.length&&!unowned.length){const empty=document.createElement('section');empty.className='empty-state';for(const [tag,text]of [['h3','暂无任务'],['p','开始对话后可在这里查看任务进展。']]){const node=document.createElement(tag);node.textContent=text;empty.append(node)}panel.append(empty)}
 for(const task of records){
  const a=card(task.goal,task.waiting_reason?taskWaitingLabel(task.waiting_reason):task.summary);a.dataset.phase=task.phase;a.dataset.taskId=task.id
  chips(a,[TASK_PHASE_LABEL[task.phase]||task.phase,task.phase==='waiting'?t('需要你处理'):task.controller?.kind==='user'?t('你在控制'):t('Nova 在推进')])
  button(t('查看任务与结果'),()=>openTask(task.id),a)
  const runs=works.filter(work=>(task.work_ids??[]).includes(work.work_id))
  if(runs.length){const list=document.createElement('div');list.className='task-runs';list.setAttribute('aria-label',t('本任务的执行记录'));a.append(list);runs.forEach((work,index)=>renderWork(list,work,{index,state,taskAction,results,chips,button,askProgress:null,local,rerender}))}
 }
 for(const work of unowned){
  const a=card(work.title,work.summary);a.dataset.phase=work.phase
  renderWork(a,work,{state,taskAction,results,chips,button,askProgress,local,rerender,standalone:true})
 }
}
function renderWork(parent,work,{index,state,taskAction,results,chips,button,askProgress,local,rerender,standalone}){
 if(!local.has(work.work_id))local.set(work.work_id,{expanded:false,error:'',asking:false})
 const view=local.get(work.work_id)
 const row=standalone?parent:document.createElement('section')
 if(!standalone){row.className='task-run';row.dataset.phase=work.phase;const title=document.createElement('h4');title.textContent=t('第 {0} 次执行',index+1);row.append(title);parent.append(row)}
 chips(row,[work.project,TASK_PHASE_LABEL[work.phase]||work.phase,work.executor])
 const actions=document.createElement('div');actions.className='card-actions';row.append(actions)
 if(askProgress){
  const ask=button(view.asking?t('正在打开对话…'):'询问任务进展',async()=>{
   if(view.asking)return
   view.asking=true;view.error='';rerender()
   try{await askProgress(work)}catch(error){view.error=error.message==='conversation_not_found'?t('原任务对话已不存在，无法询问进展。'):error.message}
   finally{view.asking=false;rerender()}
  },actions);ask.disabled=!state.connected||view.asking
 }
 const open=button(work.opening?'正在打开…':'打开项目',()=>taskAction(work.work_id,'open'),actions);open.disabled=!state.connected||work.opening
 if(WORK_ACTIVE.includes(work.phase)){const cancel=button(work.cancelling?'正在停止…':standalone?'停止任务':t('停止本次执行'),()=>taskAction(work.work_id,'cancel'),actions);cancel.disabled=!state.connected||work.cancelling}
 if(view.error||work.error){const notice=document.createElement('p');notice.textContent=view.error||work.error;notice.setAttribute('role','alert');row.append(notice)}
 const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=t('查看结果');summary.setAttribute('data-task-result',work.work_id);details.append(summary);details.dataset.workId=work.work_id;details.open=view.expanded
 details.addEventListener('toggle',()=>{if(details.isConnected!==false)view.expanded=details.open})
 const result=results().find(result=>result.delegateId===work.work_id)
 const lines=result?[
  t(TASK_PHASE_LABEL[result.outcome==='ok'?'completed':result.outcome]),result.summary,
  t('变更文件：{0}',result.changedFiles??t('未知')),
  t('耗时：{0} 秒',(result.endedAt-result.startedAt).toFixed(1)),
  ...(result.diagnostic?[`${result.executor} ${result.diagnostic.method} (${result.diagnostic.server_code})`,result.diagnostic.message]:[]),
 ]:[t('暂无结果')]
 for(const text of lines){const p=document.createElement('p');p.textContent=text;details.append(p)}
 row.append(details)
}
