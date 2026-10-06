import {t} from './locale.mjs'

const same=(a,b)=>a?.workspace_id===b?.workspace_id&&(a?.session_id??null)===(b?.session_id??null)

/** Workspaces (level 1) and the sessions of each (level 2), from the loaded catalog plus the conversation's current target. */
export function targetLevels(catalog,current){
 const options=[...(catalog??[])]
 if(current&&!options.some(item=>same(item,current))){
  const related=options.find(item=>item.workspace_id===current.workspace_id)
  if(catalog==null||related)options.unshift({...related,...current})
 }
 const workspaces=new Map()
 for(const item of options){
  const group=item.group_workspace_id??item.workspace_id
  let entry=workspaces.get(group)
  if(!entry){entry={workspace_id:group,project:item.group_project??item.project,directory:item.group_directory??item.directory??'',sessions:[]};workspaces.set(group,entry)}
  if(!entry.directory&&item.directory)entry.directory=item.directory
  if(item.session_id&&!entry.sessions.some(session=>session.session_id===item.session_id))entry.sessions.push({session_id:item.session_id,title:item.title,...(item.group_workspace_id?{workspace_id:item.workspace_id}:{})})
 }
 return [...workspaces.values()]
}

export const targetLabel=current=>current?`${current.project} / ${current.session_id?current.title:t('新会话')}`:t('选择工作区')

/**
 * The composer's workspace/session chooser: one chip, one popover, two levels.
 * It exists only while a coding executor does (the runtime sends `executor.state` only then).
 */
export function mountCodingTargetMenu(parent,{c,el,run}){
 const root=el('div',undefined,'target-menu');root.hidden=true
 const chip=el('button',undefined,'target-chip');chip.type='button';chip.setAttribute('aria-haspopup','menu');chip.setAttribute('aria-expanded','false')
 const label=el('span',targetLabel(null),'target-chip-label');chip.append(label,el('span','⌄','target-chip-caret'))
 const panel=el('div',undefined,'target-panel');panel.hidden=true;panel.setAttribute('role','menu');panel.setAttribute('aria-label',t('执行位置'))
 const workspaceColumn=el('div',undefined,'target-column'),sessionColumn=el('div',undefined,'target-column')
 panel.append(workspaceColumn,sessionColumn);root.append(chip,panel);parent.append(root)
 let available=false,wasConnected=false,conversation=null,catalog=null,status='idle',browsing=null,pending=false,queued=null,opened=false,renderedKey='',nodes=new Map()
 const current=()=>c.snapshot?.conversations?.items?.find(item=>item.id===c.selectedId)?.coding_target??null

 async function load(){
  const id=c.selectedId;if(!id)return
  status='loading';render()
  try{const data=await c.command('conversations.targets',{});if(c.selectedId===id&&conversation===id){catalog=Array.isArray(data?.targets)?data.targets:[];status='idle'}}
  catch{if(c.selectedId===id&&conversation===id)status='error'}
  render()
 }
 function close(restore){
  if(!opened)return
  opened=false;panel.hidden=true;chip.setAttribute('aria-expanded','false')
  document.removeEventListener?.('pointerdown',onPointer,true)
  if(restore)chip.focus?.()
 }
 function onPointer(event){if(!root.contains(event.target))close(false)}
 function open(){
  if(opened||chip.disabled)return
  opened=true;panel.hidden=false;chip.setAttribute('aria-expanded','true')
  browsing=current()?.workspace_id??null
  document.addEventListener?.('pointerdown',onPointer,true)
  render();void load()
 }
 function choose(target,{keepOpen=false}={}){
  const id=conversation;if(!id||id!==c.selectedId)return
  if(pending){queued={id,target};if(!keepOpen)close(true);return}
  pending=true;render()
  void run(async()=>{
   try{await c.command('conversations.target',{id,target})}
   finally{
    pending=false
    const next=queued;queued=null
    if(next&&next.id===c.selectedId&&next.id===conversation)choose(next.target,{keepOpen:true})
    else render()
   }
  })
  if(!keepOpen)close(true)
 }
 chip.addEventListener('click',()=>opened?close(true):open())
 panel.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault?.();close(true);return}
  const move={ArrowDown:1,ArrowUp:-1}[event.key]
  const items=[...workspaceColumn.querySelectorAll('button'),...sessionColumn.querySelectorAll('button')].filter(node=>!node.disabled)
  if(move===undefined||!items.length)return
  event.preventDefault?.()
  const at=items.indexOf(document.activeElement);items[(at+move+items.length)%items.length].focus?.()
 })

 function item(column,key,text,{selected=false,title='',onClick}){
  const node=el('button',text,'target-item');node.type='button';node.setAttribute('role','menuitemradio');node.setAttribute('aria-checked',String(selected));nodes.set(key,node)
  if(title)node.title=title
  node.addEventListener('click',onClick);column.append(node);return node
 }
 function render(){
  const now=current(),levels=targetLevels(catalog,now)
  const selectedGroup=levels.find(entry=>entry.workspace_id===now?.workspace_id||entry.sessions.some(session=>session.session_id===now?.session_id))?.workspace_id
  const grouped=catalog?.find(item=>same(item,now))
  label.textContent=targetLabel(grouped?.group_project?{...now,project:grouped.group_project}:now);chip.title=grouped?.directory??now?.directory??levels.find(entry=>entry.workspace_id===selectedGroup)?.directory??''
  chip.disabled=!c.connected||!c.presentationReady||!conversation
  root.hidden=!available
  if(!opened)return
  const key=JSON.stringify([conversation,now,catalog,status,browsing,pending])
  if(key===renderedKey)return
  renderedKey=key
  const focused=[...nodes].find(([,node])=>node===document.activeElement)?.[0]
  nodes=new Map();workspaceColumn.replaceChildren();sessionColumn.replaceChildren()
  item(workspaceColumn,'w:none',t('不指定工作区'),{selected:!now,onClick:()=>{browsing=null;choose(null)}})
  for(const entry of levels)item(workspaceColumn,`w:${entry.workspace_id}`,entry.project,{selected:entry.workspace_id===selectedGroup,title:entry.directory,
   onClick:()=>{browsing=entry.workspace_id;if(!pending&&entry.workspace_id===selectedGroup)render();else choose({workspace_id:entry.workspace_id,session_id:null},{keepOpen:true})}})
  if(status==='loading')workspaceColumn.append(el('p',t('正在加载工作区…'),'hint target-note'))
  else if(status==='error'){const retry=el('button',t('加载失败，点击重试'),'target-item');retry.type='button';retry.addEventListener('click',()=>void load());workspaceColumn.append(retry)}
  else if(!levels.length)workspaceColumn.append(el('p',t('还没有工作区'),'hint target-note'))
  const entry=levels.find(level=>level.workspace_id===browsing)??levels.find(level=>level.workspace_id===selectedGroup)
  sessionColumn.hidden=!entry
  if(entry){
   item(sessionColumn,'s:new',t('新会话'),{selected:now?.workspace_id===entry.workspace_id&&!now.session_id,onClick:()=>choose({workspace_id:entry.workspace_id,session_id:null})})
   for(const session of entry.sessions)item(sessionColumn,`s:${session.session_id}`,session.title,{selected:now?.workspace_id===(session.workspace_id??entry.workspace_id)&&now.session_id===session.session_id,onClick:()=>choose({workspace_id:session.workspace_id??entry.workspace_id,session_id:session.session_id})})
  }
  if(focused)(nodes.get(focused)??nodes.get('s:new')??nodes.get('w:none'))?.focus?.()
 }
 return {
  element:root,
  get available(){return available},
  get open(){return opened},
  receive(frame){if(frame.type==='executor.state'&&!available){available=true;render()}},
  update(){
   if(wasConnected&&!c.connected){available=false;close(false)}
   wasConnected=c.connected
   if(conversation!==c.selectedId){conversation=c.selectedId;catalog=null;status='idle';browsing=null;close(false)}
   render()
  },
 }
}
