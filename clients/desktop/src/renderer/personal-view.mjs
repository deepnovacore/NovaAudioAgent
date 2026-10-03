import {summarizeTasks} from './task-banner.mjs'
import {createStartupNotice} from './startup-notice.mjs'
import {t} from './locale.mjs'
import {renderLife,renderProfile} from './life-view.mjs'
import {renderNews} from './news-view.mjs'
import {PersonalController} from './personal-controller.mjs'
import {mountRail,RAIL_ITEMS} from './workbench-rail.mjs'
import {mountWindowChrome} from './window-chrome.mjs'
import {mountChatPane} from './chat-pane.mjs'
import {renderMemorySection} from './memory-page.mjs'
import {mountTaskDetail} from './task-detail.mjs'
import {renderTasksPage,activeTaskCount} from './tasks-page.mjs'
import {renderSourceSuggestions} from './workbench-suggestions.mjs'
import {disposeSources} from './source-popover.mjs'
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node}
const PAGE_TITLE=Object.fromEntries(RAIL_ITEMS.map(item=>[item.id,`${item.label} · ${item.title}`]))
/** The workbench: icon rail, personal-object pages in the middle, Nova as a collapsible pane on the right. */
export function mountPersonalView({send,start,stop,tasks,taskAction,results,api,applyPresentation,speakingLevel}) {
 const lifeLocal={},newsLocal={},preferencesLocal={},taskLocal=new Map()
 let unreadProjection=null
 const root=el('main',undefined,'workbench personal-workspace');root.id='personal-workspace';document.body.prepend(root)
 const pendingActions=new Set()
 // Stable object keys keep in-flight controls locked when snapshots rebuild the page.
 const syncPending=()=>{
  for(const node of root.querySelectorAll('button,select,input,textarea')){
   if(!node.pendingKey)continue
   const busy=pendingActions.has(node.pendingKey)
   if(busy&&!node.pendingDisabled){node.idleDisabled=node.disabled;node.pendingDisabled=true}
   else if(!busy&&node.pendingDisabled){node.disabled=!c.connected||Boolean(node.idleDisabled);node.pendingDisabled=false}
   if(busy)node.disabled=true
   node.setAttribute('aria-busy',String(busy))
   if(node.pendingIndicator)node.pendingIndicator.hidden=!busy
  }
 }
 const bindPending=(node,key,action,event='click',indicator)=>{
  node.pendingKey=key;node.pendingIndicator=indicator
  node.addEventListener(event,()=>{
   if(pendingActions.has(key)||node.disabled)return
   pendingActions.add(key);syncPending()
   return run(action).finally(()=>{pendingActions.delete(key);syncPending();update()})
  })
  return node
 }
 const run=async(action)=>{try{c.error='';await action()}catch(e){c.error=e.message==='version_conflict'?'内容已在其他操作中更新，请核对最新状态后重试。':e.message;if(c.presentationMode==='background')void api.personal.showPresentationError?.(c.error);update();if(/conflict|version/i.test(e.message)&&c.connected)await c.command('state').catch(()=>{})}update()}
 const button=(label,action,parent,key=Symbol())=>{const b=el('button',label);b.type='button';bindPending(b,key,action);parent.append(b);return b}
 const chips=(parent,values)=>{const row=el('div',undefined,'chips');for(const value of values.filter(Boolean))row.append(el('span',value));parent.append(row)}
 const c=new PersonalController({send,start,stop,applyPresentation,changed:update})
 const openSettings=category=>api.orbMenu.openSettings?.(category)
 // Rail
 let selected='todos',inspector=null,inspectedId=null,returnFocus=null,openSequence=0
 // Viewed results survive restarts so an already-read result is not counted as new again.
 const VIEWED_KEY='nova:viewed-task-results',viewedStore=globalThis.localStorage
 const viewedCursors=new Map(),viewedResults=new Set((()=>{try{const saved=JSON.parse(viewedStore?.getItem(VIEWED_KEY)??'[]');return Array.isArray(saved)?saved.filter(id=>typeof id==='string').slice(-200):[]}catch{return []}})()),taskHistories=new Map()
 const saveViewed=()=>{try{viewedStore?.setItem(VIEWED_KEY,JSON.stringify([...viewedResults].slice(-200)))}catch{/* the count only resets on restart */}}
 const durableTasks=()=>({tasks:c.snapshot?.tasks??[]})
 function closeTask(){openSequence++;inspector?.dispose();inspector=null;const originId=inspectedId;inspectedId=null;root.dataset.taskDetail='false';renderPanel();if(returnFocus?.isConnected!==false)returnFocus?.focus();else panel.querySelector?.(`[data-task-id="${originId}"] button`)?.focus()}
 async function openTask(id,approval=false){const sequence=++openSequence,originFocus=document.activeElement;if(c.presentationMode!=='workbench')await c.setPresentation('workbench');if(!taskHistories.has(id))taskHistories.set(id,{items:new Map(),cursor:0,incomplete:false,truncated:false});const history=taskHistories.get(id);const next=await c.command('tasks.get',{task_id:id,after:history.cursor});if(sequence!==openSequence)return;if(inspectedId!==id){inspector?.dispose();returnFocus=originFocus;panel.replaceChildren();const holder=el('section');panel.append(holder);inspector=mountTaskDetail(holder,{command:(...args)=>c.command(...args),onClose:closeTask,history,after:viewedCursors.get(id)??0,onViewed:(taskId,cursor,phase)=>{if(c.presentationMode==='workbench'&&taskId&&Number.isSafeInteger(cursor)){viewedCursors.set(taskId,cursor);if(phase==='completed'&&!viewedResults.has(taskId)){viewedResults.add(taskId);saveViewed();update()}}}});inspectedId=id}root.dataset.taskDetail='true';pageTitle.textContent=t('任务详情');inspector.setVisible(c.presentationMode==='workbench');inspector.update(next);if(c.presentationMode==='workbench'){if(next.phase==='completed')viewedResults.add(id);saveViewed();if(approval)inspector.focusApproval();else inspector.focus()}}
 const rail=mountRail(root,{onSelect:id=>{selected=id;closeTask()},footer:[
  {label:'收起',title:'收起为悬浮球',icon:'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',onClick:()=>run(()=>collapse(true))},
  {label:'设置',title:'打开设置',icon:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',onClick:()=>openSettings()},
 ]})
 // Workspace
 const workspace=el('section',undefined,'workspace');workspace.setAttribute('aria-label','工作区');root.append(workspace)
 const pageHead=el('header',undefined,'page-head');const pageTitle=el('h2','','page-title');const status=el('span','正在连接','workbench-status');status.setAttribute('role','status')
 const chatToggle=el('button','收起对话栏','chat-toggle');chatToggle.type='button';chatToggle.setAttribute('aria-controls','chat-pane');chatToggle.addEventListener('click',()=>chat.setOpen(!chat.open))
 const presentation=el('select');presentation.setAttribute('aria-label','显示模式');for(const [value,label]of [['workbench','工作台'],['orb','悬浮球'],['background','隐藏']]){const option=el('option',label);option.value=value;presentation.append(option)}presentation.addEventListener('change',()=>run(()=>c.setPresentation(presentation.value)))
 const chrome=mountWindowChrome(root,{api,el})
 pageHead.append(pageTitle,chrome.grip,status,presentation,chatToggle);workspace.append(pageHead)
 // Startup progress reads as loading; only a failed start turns into an error with a way into settings.
 const startupNotice=el('p','','page-notice');startupNotice.id='startup-notice';startupNotice.setAttribute('role','status');startupNotice.hidden=true;workspace.append(startupNotice)
 const startupText=el('span');startupNotice.append(startupText);const startupSettings=button(t('打开设置'),()=>openSettings(),startupNotice);startupSettings.hidden=true
 const startup=createStartupNotice({render:text=>{startupText.textContent=text;startupNotice.hidden=!text}})
 const error=el('p','','page-error');error.setAttribute('role','alert');error.hidden=true;workspace.append(error)
 const taskNotice=el('p');taskNotice.setAttribute('role','status');taskNotice.setAttribute('aria-live','polite');workspace.append(taskNotice)
 const waiting=el('div',undefined,'presentation-waiting');workspace.append(waiting)
 const panel=el('div',undefined,'workbench-page');workspace.append(panel)
 // Chat pane
 const chat=mountChatPane(root,{c,el,button,run,api,chips,openTask,speakingLevel,onOpenChange:value=>{root.dataset.chatOpen=String(value);chatToggle.textContent=value?'收起对话栏':'展开对话栏';chatToggle.title=chatToggle.textContent;chatToggle.setAttribute('aria-expanded',String(value))}})
 chat.setOpen(true)
 // The orb carries no mode buttons: double-click expands, the context menu switches modes, and sleep is the only voice switch.
 const orbExtras=el('div',undefined,'personal-orb-extras');document.querySelector('#shell').append(orbExtras)
 const orbTask=button('',()=>openTask(orbTask.dataset.taskId),orbExtras);orbTask.className='personal-orb-task'
 const orbNotice=el('p');orbNotice.setAttribute('role','status');orbNotice.setAttribute('aria-live','polite');orbExtras.append(orbNotice)
 // An orb is a voice conversation; sleep only reroutes its audio to wake detection, so opening it must not wake the orb.
 // A failed attempt holds until the orb is re-entered or reconnects, so a refused microphone reports once;
 // an established session releases the guard, so a session the host ends is reopened.
 let orbVoiceTried=false
 const syncOrbVoice=()=>{
  if(c.presentationMode!=='orb'||!c.connected||c.mode==='voice'){orbVoiceTried=false;return}
  if(orbVoiceTried||!c.presentationReady||c.presentationPending||!c.selectedId||c.mode!=='text'||c.capturePending)return
  orbVoiceTried=true;void run(()=>c.voiceId?c.resumeVoice({wake:false}):c.voice({wake:false}))
 }
 const orbError=el('p','','personal-orb-error');orbError.setAttribute('role','alert');document.querySelector('#shell').append(orbError)
 panel.addEventListener('focusout',()=>setTimeout(()=>{if(!panel.contains?.(document.activeElement))update()},0))
 // A semantic button lets keyboard and screen-reader users expand long bodies.
 const expandedBodies=new Set()
 const bodyMeasures=new WeakMap(),bodyObserver=globalThis.ResizeObserver?new ResizeObserver(entries=>{for(const entry of entries)bodyMeasures.get(entry.target)?.()}):null
 const clampable=(node,id,title)=>{node.type='button';node.dataset.cardBodyId=id;const sync=()=>{const open=expandedBodies.has(id);node.dataset.expanded=String(open);node.setAttribute('aria-expanded',String(open));node.setAttribute('aria-label',`${open?'收起':'展开'}正文：${title}`)};const measure=()=>{if(node.isConnected===false||!node.clientHeight)return;node.disabled=!expandedBodies.has(id)&&node.scrollHeight<=node.clientHeight};sync();node.addEventListener('click',()=>{if(globalThis.getSelection?.()?.toString())return;expandedBodies.has(id)?expandedBodies.delete(id):expandedBodies.add(id);sync();measure()});bodyMeasures.set(node,measure);bodyObserver?.observe(node);globalThis.requestAnimationFrame?.(measure)}
 const card=(title,summary)=>{const a=el('article',undefined,'card');a.append(el('h3',title));if(summary)a.append(el('p',summary));panel.append(a);return a}
 const continueChat=text=>chat.focusDraft(`关于「${text}」：`)
 let renderedPageKey=null
 const pageKey=()=>{
  const s=c.snapshot,sourceStates=s?.sources?.map(source=>[source.id,source.state,source.health,source.processing_consent_required])
  if(['todos','ideas','goals'].includes(selected))return JSON.stringify([selected,s?.life,s?.understanding,s?.workbench_context,sourceStates,c.connected])
  if(selected==='feeds')return JSON.stringify([selected,s?.news,s?.profile_preparation,c.connected])
  if(selected==='tasks')return JSON.stringify([selected,durableTasks(),tasks(),results(),c.connected])
  return JSON.stringify([selected,s?.life,s?.memory,s?.profile_preparation,s?.news,s?.capabilities,c.connected])
 }
 function renderPanel(){
  if(inspector)return
  const focused=panel.contains?.(document.activeElement)?document.activeElement:null,focusLabel=focused?.getAttribute?.('aria-label'),focusBodyId=focused?.dataset?.cardBodyId,focusWorkId=focused?.getAttribute?.('data-task-result'),focusText=focused?.tagName==='BUTTON'?focused.textContent:null
  const fields=[...panel.querySelectorAll('input,textarea,select')],focusIndex=focused?fields.indexOf(focused):-1
  const edit=focusIndex>=0?{index:focusIndex,key:focused.getAttribute?.('data-editor-key'),tag:focused.tagName??focused.tag,label:focusLabel,value:focused.value,start:focused.selectionStart,end:focused.selectionEnd,scrollTop:focused.scrollTop}:null
  const panelScroll=panel.scrollTop
  for(const details of panel.querySelectorAll('details')){const local=taskLocal.get(details.dataset.workId);if(local)local.expanded=details.open}
  bodyObserver?.disconnect();disposeSources();panel.replaceChildren();rail.select(selected);pageTitle.textContent=PAGE_TITLE[selected]??selected
  const s=c.snapshot;const caps=s?.capabilities??{}
  const candidateKind=({todos:'todo',ideas:'idea',goals:'goal',profile:'profile'})[selected]
  const pending=el('section',undefined,'pending-group');pending.setAttribute('aria-label','待确认')
  if(s?.understanding?.error&&candidateKind)pending.append(el('p','这条发言暂时没能记下来，你仍可以手动添加。','hint'))
  if(selected==='todos')for(const item of s?.understanding?.recorded??[]){const a=el('article',undefined,'card pending');a.append(el('h3','已记下待办'),el('p',item.text));pending.append(a);const current=s.life?.todos?.find(t=>t.id===item.object_id);if(current?.version===item.version)button('撤销记录',()=>c.command('understanding.action',{id:item.id,action:'undo'}),a,`understanding:${item.id}`)}
  const pageLinks=()=>{const links=el('div',undefined,'page-links');panel.append(links);return links}
  for(const item of s?.understanding?.items??[]){if(item.kind!==candidateKind)continue;const a=el('article',undefined,'card pending');a.append(el('h3','可能想记下'),el('p',item.text),el('p',`依据：${item.quote}`,'hint'));if(item.kind==='profile')a.append(el('p','确认后将追加到个人介绍，不会替换已有内容。','hint'));const edit=el('textarea');edit.value=lifeLocal['candidate:'+item.id]??item.text;edit.maxLength=1000;edit.setAttribute('aria-label','候选内容');edit.setAttribute('data-editor-key',`candidate:${item.id}:content`);edit.addEventListener('input',()=>{lifeLocal['candidate:'+item.id]=edit.value});a.append(edit);button('记下来',()=>c.command('understanding.action',{id:item.id,action:'accept',text:edit.value,...(item.kind==='profile'?{expected_profile_version:s.life.profile.version}:{})}),a,`understanding:${item.id}`);button('略过',()=>c.command('understanding.action',{id:item.id,action:'dismiss'}),a,`understanding:${item.id}`);pending.append(a)}
  if(['todos','ideas','goals'].includes(selected)){
   const suggestions=()=>renderSourceSuggestions(panel,{clampable,tab:selected,context:s?.workbench_context,sources:s?.sources??[],button,command:(m,p)=>c.command(m,p),continueChat,delegate:text=>chat.focusDraft(text),openSettings,connected:c.connected,everConnected:c.everConnected,startupFailed:startupNotice.dataset.stage==='failed'})
   if(selected==='todos')suggestions()
   renderLife(panel,{kind:({todos:'todo',ideas:'idea',goals:'goal'})[selected],state:s?.life,clampable,suggested:(s?.workbench_context?.cards??[]).filter(card=>card.tab===selected).length,openArticle:url=>api.personal.openArticle(url),command:(m,p)=>c.command(m,p),button,run,bindPending,local:lifeLocal,rerender:renderPanel,delegate:(text,source)=>chat.focusDraft(text,source)})
   if(pending.children?.length||pending.childElementCount)panel.append(pending)
   if(selected!=='todos')suggestions()
   if(selected==='todos')button('查看 Agent 执行任务',()=>{selected='tasks';renderPanel()},pageLinks()).className='link-button'
  }else if(selected==='feeds'){
   renderNews(panel,{news:s?.news,warmup:s?.profile_preparation,preferencesLocal,delegate:text=>chat.focusDraft(text),command:(m,p)=>c.command(m,p),button,local:newsLocal,rerender:renderPanel,profile:()=>{selected='profile';renderPanel()},openArticle:url=>api.personal.openArticle(url),openSettings,connected:c.connected})
  }else if(selected==='tasks'){
   renderTasksPage(panel,{tasks,durableTasks,openTask,taskAction,results,card,chips,button,local:taskLocal,rerender:renderPanel,askProgress:async task=>{
    const result=await c.command('conversations.open_work',{work_id:task.work_id}),id=result?.selected_id
    if(typeof id!=='string'||!id||!Array.isArray(result?.items)||!result.items.some(item=>item?.id===id))throw Error(t('原任务对话未确认，请刷新后重试。'))
    const target=c.state(id),prompt=t('请告诉我「{0}」（任务 {1}）的最新进展。',task.title,task.work_id)
    const draft=target.draft.endsWith(prompt)?target.draft:[target.draft,prompt].filter(Boolean).join('\n')
    if(draft.length>4000)throw Error(t('追加后草稿超过 4000 字符，原有草稿已保留，请先缩短内容。'))
    target.draft=draft;chat.reveal()
   }})
  }else if(selected==='profile'){
   renderProfile(panel,{state:s?.life,news:s?.news,warmup:s?.profile_preparation,preferencesLocal,delegate:text=>chat.focusDraft(text),command:(m,p)=>c.command(m,p),button,local:lifeLocal,rerender:renderPanel})
   if(pending.children?.length||pending.childElementCount)panel.append(pending)
   renderMemorySection(panel,{snapshot:s,caps,el,button,chips,command:(m,p)=>c.command(m,p),continueChat,bindPending,connected:c.connected,local:lifeLocal})
  }
  for(const b of panel.querySelectorAll('button'))if(!c.connected)b.disabled=true
  syncPending()
  if(edit){const next=[...panel.querySelectorAll('input,textarea,select')],target=edit.key?next.find(node=>node.getAttribute?.('data-editor-key')===edit.key):next[edit.index];if(target&&(target.tagName??target.tag)===edit.tag&&target.getAttribute?.('aria-label')===edit.label&&!target.disabled){if(edit.tag!=='SELECT')target.value=edit.value;if(typeof edit.start==='number'&&typeof target.setSelectionRange==='function')target.setSelectionRange(edit.start,edit.end);else{target.selectionStart=edit.start;target.selectionEnd=edit.end}target.scrollTop=edit.scrollTop;target.focus?.({preventScroll:true})}}
  else if(focusBodyId||focusWorkId||focusLabel||focusText){const target=[...panel.querySelectorAll('button,input,textarea,select,summary')].find(node=>focusBodyId?node.dataset?.cardBodyId===focusBodyId:focusWorkId?node.getAttribute('data-task-result')===focusWorkId:focusLabel?node.getAttribute('aria-label')===focusLabel:node.textContent===focusText);if(target&&!target.disabled)target.focus?.({preventScroll:true})}
  panel.scrollTop=panelScroll;renderedPageKey=pageKey()
 }
 function update(){
  document.body.dataset.personalCollapsed=String(c.collapsed)
  document.body.dataset.presentationMode=c.presentationMode;presentation.value=c.presentationMode;presentation.disabled=c.presentationPending
  const startupFailed=startupNotice.dataset.stage==='failed',active=activeTaskCount(durableTasks(),tasks());status.textContent=startupFailed?t('启动失败'):c.connected?`运行中 · ${active} 个后台任务`:c.everConnected?'已断开 · 草稿保留':'正在连接';status.dataset.state=startupFailed?'disconnected':c.connected?'connected':c.everConnected?'disconnected':'connecting'
  rail.badge('tasks',active)
  inspector?.setVisible(c.presentationMode==='workbench')
  for(const node of [taskNotice,orbNotice]){const text=t(c.taskNotice);if(node.textContent!==text)node.textContent=text;node.hidden=!text}
  const aggregate=summarizeTasks(c.snapshot?.tasks??[],[...viewedResults]),decision=(c.snapshot?.pending_approvals??[]).find(item=>item.task_id);orbTask.dataset.taskId=decision?.task_id??aggregate.task_id??'';orbTask.hidden=!orbTask.dataset.taskId;orbTask.disabled=!c.connected;orbTask.textContent=t('任务：{0} 进行中 · {1} 待处理 · {2} 新结果',aggregate.active,Math.max(aggregate.decisions,decision?1:0),aggregate.results)
  error.textContent=c.error;error.hidden=!c.error||c.presentationMode!=='workbench';orbError.textContent=c.error;orbError.hidden=!c.error||c.presentationMode!=='orb'
  syncOrbVoice()
  const pending=[...(c.snapshot?.pending_approvals??[]),...(c.snapshot?.pending_confirmations??[])]
  waiting.replaceChildren();for(const item of pending){const b=button(`处理审批：${item.summary}`,async()=>{if(item.task_id){await openTask(item.task_id,true);return}if(item.conversation_id&&item.conversation_id!==c.selectedId)await c.select(item.conversation_id);await c.setPresentation('orb')},waiting);b.disabled=!c.connected}
  const unreadTotal=(c.snapshot?.conversations?.items??[]).reduce((sum,item)=>sum+(item.unread_count??0),0)
  const unreadDot=document.querySelector('#unread-indicator');if(unreadDot)unreadDot.hidden=!unreadTotal
  chat.update()
  if(!c.connected)unreadProjection=null
  const unread=c.connected&&c.snapshot?((c.snapshot.conversations?.unread_count??0)+pending.reduce((sum,item)=>sum+1+(item.queued??0),0)):undefined
  if(Number.isSafeInteger(unread)&&unread>=0&&unreadProjection!==unread){unreadProjection=unread;void api.personal.setUnread?.(unread)}
  if(renderedPageKey!==pageKey())renderPanel()
  syncPending()
 }
 async function collapse(value){await c.setPresentation(value?'orb':'workbench')}
 function receive(frame){chat.receive(frame);c.receive(frame);inspector?.receive(frame);if(frame.type==='executor.tasks')renderPanel()}
 api.personal.onPresentationRequest?.(mode=>run(()=>c.setPresentation(mode)));
 api.personal.onCollapsed?.(value=>c.collapse(value));update();renderPanel();return {controller:c,receive,refresh:update,setOrb:state=>chat.setOrb(state),setOrbLevel:level=>chat.setOrbLevel(level),expand:()=>run(()=>collapse(false)),openTask:id=>run(()=>openTask(id)),startup:value=>{const wasFailed=startupNotice.dataset.stage==='failed',failed=value?.stage==='failed';startupNotice.dataset.stage=value?.stage??'';startupNotice.className=failed?'page-error':'page-notice';startupNotice.setAttribute('role',failed?'alert':'status');startupSettings.hidden=!failed;startup.update(value);if(failed!==wasFailed){update();renderPanel()}}}
}
