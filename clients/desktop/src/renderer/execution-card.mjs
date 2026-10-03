import {t} from './locale.mjs'

/**
 * The workspaces and sessions a pending proposal can run in, by display name. The proposal's own
 * place is always first and always selectable; a place another work holds is listed but disabled.
 */
export function executionChoices(proposal,targets){
 const workspaces=[],seen=new Map()
 const workspace=name=>{if(!seen.has(name)){const entry={project:name,running:undefined,sessions:[]};seen.set(name,entry);workspaces.push(entry)}return seen.get(name)}
 if(proposal.workspace)workspace(proposal.workspace)
 for(const target of targets??[]){
  const entry=workspace(target.project);if(target.running)entry.running??=target.running
  if(target.session_id)entry.sessions.push({title:target.title,last_active:target.last_active,running:target.running})
 }
 const proposed=seen.get(proposal.workspace)
 if(proposed&&proposal.session&&!proposed.sessions.some(session=>session.title===proposal.session))proposed.sessions.unshift({title:proposal.session})
 for(const entry of workspaces){
  entry.sessions.sort((a,b)=>(b.last_active??0)-(a.last_active??0))
  entry.disabled=entry.project!==proposal.workspace&&Boolean(entry.running)
  for(const session of entry.sessions)session.disabled=!(entry.project===proposal.workspace&&session.title===proposal.session)&&Boolean(session.running)
 }
 return workspaces
}

export function proposalText(proposal){
 if(proposal.action==='create_workspace')return t('新建工作区「{0}」',proposal.workspace)
 return proposal.session?t('工作区「{0}」· 延续会话「{1}」',proposal.workspace,proposal.session):t('工作区「{0}」· 新会话',proposal.workspace)
}

/** Nova's proposed execution place for this conversation, confirmed or changed inline. */
export function mountExecutionCard(parent,{el,command,submitText,run}){
 const card=el('section',undefined,'execution-card');card.setAttribute('aria-label',t('执行位置'));card.hidden=true;parent.append(card)
 const title=el('strong',t('Nova 建议的执行位置')),line=el('p'),busy=el('p',undefined,'hint'),error=el('p',undefined,'hint')
 const workspaceSelect=el('select'),sessionSelect=el('select');workspaceSelect.setAttribute('aria-label',t('工作区'));sessionSelect.setAttribute('aria-label',t('会话'))
 const actions=el('div',undefined,'execution-card-actions')
 const go=el('button',t('按此执行'));go.type='button';const cancel=el('button',t('取消'));cancel.type='button';actions.append(go,cancel)
 card.append(title,line,busy,workspaceSelect,sessionSelect,actions,error)
 let current=null,conversation=null,targets=null,loading=false,pending=false,choices=[]
 const changed=()=>workspaceSelect.value!==current.workspace||sessionSelect.value!==(current.session??'')
 const decide=async confirmed=>{
  const proposal=current,id=conversation;pending=true;render()
  try{await command('conversations.confirm',{id,proposal_id:proposal.proposal_id,confirmed})}
  catch(e){error.textContent=e.message==='confirmation_not_owned'?t('这个提议已在另一端处理'):t('操作失败，请重试');return false}
  finally{pending=false;render()}
  return true
 }
 go.addEventListener('click',()=>run(async()=>{
  if(!current)return
  if(!changed()){await decide(true);return}
  const project=workspaceSelect.value,session=sessionSelect.value,owner=conversation
  if(await decide(false))submitText(session?t('改为在工作区「{0}」的会话「{1}」中继续执行。',project,session):t('改为在工作区「{0}」新开会话执行。',project),owner)
 }))
 cancel.addEventListener('click',()=>run(()=>current&&decide(false)))
 workspaceSelect.addEventListener('change',()=>{fillSessions();render()})
 sessionSelect.addEventListener('change',render)
 function fillSessions(){
  const entry=choices.find(item=>item.project===workspaceSelect.value)
  const fresh=el('option',t('新会话'));fresh.value='';sessionSelect.replaceChildren(fresh)
  for(const session of entry?.sessions??[]){const option=el('option',session.running&&session.disabled?t('{0}（正在执行：{1}）',session.title,session.running):session.title);option.value=session.title;option.disabled=session.disabled;sessionSelect.append(option)}
  if(entry?.project===current.workspace)sessionSelect.value=current.session??''
 }
 function fill(){
  choices=executionChoices(current,targets);workspaceSelect.replaceChildren()
  for(const entry of choices){const option=el('option',entry.disabled?t('{0}（正在执行：{1}）',entry.project,entry.running):entry.project);option.value=entry.project;option.disabled=entry.disabled;workspaceSelect.append(option)}
  workspaceSelect.value=current.workspace;fillSessions()
 }
 function render(){
  if(!current)return
  go.textContent=changed()?t('改为此位置执行'):t('按此执行')
  go.disabled=cancel.disabled=pending;workspaceSelect.disabled=sessionSelect.disabled=pending||loading||current.action==='create_workspace'
 }
 return {update(proposal,conversationId){
  const key=proposal?proposal.proposal_id:null
  if(key!==current?.proposal_id||conversationId!==conversation){
   current=proposal??null;conversation=conversationId;error.textContent='';card.hidden=!current
   if(!current)return
   line.textContent=proposalText(current)
   if(!loading){targets=null;loading=true;void command('conversations.targets',{}).then(data=>{targets=data.targets??[]},()=>{targets=[]}).finally(()=>{loading=false;if(current)fill();render()})}
   fill()
  }
  if(current){busy.textContent=current.busy?t('该工作区正在执行其他任务，确认后将排队'):'';busy.hidden=!current.busy;render()}
 }}
}
