import {onButton} from './button-action.mjs'
import {t} from './locale.mjs'
import {renderConnectors} from './connectors-view.mjs'
import {renderDailyBrief} from './daily-brief-view.mjs'

/** Sources, app connectors, briefing schedule and discovery cadence, reached through the settings window's narrow IPC bridge. */
export function createConnectionsPanel({document, api}) {
 const root=document.querySelector('#connections-panel'),error=document.querySelector('#connections-error')
 let state=null,busy=false,selected='files',actionPending=false
 let actionNeedsRender=false,pendingLabel=null
 const local={onError:caught=>{error.textContent=caught?.message||t('连接暂时不可用')}}
 const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node}
 const button=(text,action,parent)=>{const node=el('button',text);node.type='button';node.disabled=busy||actionPending;if(actionPending&&pendingLabel===text)node.setAttribute('aria-busy','true');onButton(node,async()=>{actionPending=true;pendingLabel=text;try{return await action()}finally{actionPending=false;pendingLabel=null;if(actionNeedsRender){actionNeedsRender=false;render()}}},local.onError);parent.append(node);return node}
 const chips=(parent,values)=>{const row=el('div',undefined,'personal-chips');for(const value of values.filter(Boolean))row.append(el('span',value));parent.append(row)}
 function render(){
  if(actionPending)actionNeedsRender=true
  root.replaceChildren()
  let target=root
  const panels={}
  if(state!==null){
   const tabs=el('div',undefined,'connections-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',t('资料与提醒分类'));root.append(tabs)
   const items=[['files',t('本机资料')],['apps',t('邮件与日历')],['reminders',t('主动提醒')]]
   for(const [id,label]of items){const b=button(label,()=>{selected=id;render()},tabs);b.id='connections-tab-'+id;b.setAttribute('role','tab');b.setAttribute('aria-selected',String(selected===id));b.setAttribute('aria-controls','connections-page-'+id);b.tabIndex=selected===id?0:-1;b.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=items.findIndex(item=>item[0]===id);selected=items[event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3][0];render();document.querySelector('#connections-tab-'+selected)?.focus()})}
   for(const [id]of items){const page=el('div',undefined,'connections-page');page.id='connections-page-'+id;page.setAttribute('role','tabpanel');page.setAttribute('aria-labelledby','connections-tab-'+id);page.hidden=selected!==id;panels[id]=page;root.append(page)}
   target=panels.files
  }
  const card=(title,description)=>{const node=el('article',undefined,'im-card');node.append(el('h3',title));if(description)node.append(el('p',description));target.append(node);return node}
  if(state===null){const loading=card(t('连接与权限'),t('正在读取连接状态…'));loading.setAttribute('aria-busy',String(busy));return}
  const s=state,caps=s.capabilities??{}
  const sourceCard=card(t('本机目录'),t('已授权的来源列在下方；新增来源时单独确认读取和模型处理权限。'))
  const sources=el('details',undefined,'source-add');sources.open=local.addSourceOpen??!(s.sources?.length);sources.addEventListener('toggle',()=>{local.addSourceOpen=sources.open});sources.append(el('summary',t('添加授权来源')));sourceCard.append(sources)
  const consent=el('label',undefined,'personal-consent');const check=el('input');check.type='checkbox';check.checked=!!local.sourceConsent;consent.append(check,document.createTextNode(t('允许将授权资料的片段发送给当前配置的模型，用于理解与检索。')));sources.append(consent)
  const computer=(s.sources??[]).find(source=>source.scope==='computer'&&source.state!=='disconnected')
  const add=button(computer?t('选择优先整理的目录'):t('选择并授权目录'),async()=>{const path=await api.chooseDirectory();if(path)await command(computer?'sources.priority.add':'sources.add',computer?{path}:{path,consent:true})},sources);add.disabled=!check.checked;const whole=button(t('授权本机全部可访问数据'),()=>command('sources.authorize_computer',{consent:true}),sources);whole.disabled=!check.checked;check.addEventListener('change',()=>{local.sourceConsent=check.checked;add.disabled=whole.disabled=!check.checked});sources.append(el('p',t('全机模式分批持续处理。系统权限仍由 macOS / Windows 管理；不读取凭据、密钥、系统文件、依赖和构建缓存。暂停会停止后续读取。'),'hint'))
  if(!caps.sources)sources.append(el('p',t('授权时会同时启用本机资料服务。'),'hint'))
  const sourceList=el('ul',undefined,'source-list');sourceList.setAttribute('aria-label',t('已授权来源'));target.append(sourceList)
  for(const source of s.sources??[]){const item=el('li');sourceList.append(item);target=item;const a=card(source.scope==='computer'?t('本机全部可访问数据'):source.path);if(source.scope==='computer'){a.append(el('p',t('已索引 {0} 份文档 · {1}；不支持的类型与权限失败见同步详情。',source.indexed??0,source.scan_pending?t('后台处理进行中'):t('本轮遍历结束'))));for(const path of source.priority_dirs??[]){const row=el('div',undefined,'source-priority-row');row.append(el('span',t('优先整理：{0}',path)));button(t('移除优先目录'),()=>command('sources.priority.remove',{path}),row);a.append(row)}}chips(a,[{connected:t('已连接'),paused:t('已暂停'),disconnected:t('已断开'),error:t('异常')}[source.state]||source.state,t('扫描 {0}',source.scanned),t('本次读取正文 {0}',source.read),t('跳过 {0}',source.skipped)]);a.append(el('p',t('上次同步：{0}',source.last_sync??t('尚未同步'))))
   const grant=el('p',source.processing_consent_required===false?t('已授权当前模型处理'):t('需要确认当前模型处理权限'),'source-grant');grant.dataset.state=source.processing_consent_required===false?'granted':'required';a.append(grant)
   if(source.processing_consent_required)button(t('授权当前模型处理'),()=>command('sources.consent',{id:source.id,consent:true}),a);const details=el('details');details.append(el('summary',t('同步详情')));for(const line of [t('排除：{0}',(source.excludes??[]).join(', ')),t('跳过原因：{0}',JSON.stringify(source.reasons??{})),...(source.failures??[]).map(f=>`${f.path} · ${f.code}`)])details.append(el('p',line));a.append(details)
   if(source.state!=='disconnected')for(const [label,method]of [[source.state==='paused'?t('恢复同步'):t('暂停同步'),source.state==='paused'?'resume':'pause'],[t('立即同步'),'sync'],[t('断开（保留数据）'),'disconnect']])button(label,()=>command(`sources.${method}`,{id:source.id}),a)
   else a.append(el('p',t('已停止访问；重新授权连接暂不支持。')))
   const deletion=el('div');deletion.hidden=true;deletion.setAttribute('role','group');deletion.setAttribute('aria-label',t('确认删除来源数据'));deletion.append(el('p',t('确认删除「{0}」的索引与来源记录？依赖此来源的记忆和建议也会更新或撤回；不会删除磁盘原文件。',source.path)))
   button(t('确认删除来源数据'),()=>command('sources.delete',{id:source.id}),deletion);button(t('取消删除'),()=>{deletion.hidden=true},deletion)
   button(t('删除来源数据'),()=>{deletion.hidden=false;deletion.querySelector('button')?.focus?.()},a);a.append(deletion)
  }
  target=panels.apps
  renderConnectors({state:s.connectors,local,card,el,button,command,api:{personal:{openConnectorAuthorization:url=>api.openConnectorAuthorization(url)}},refresh:render})
  target=panels.reminders
  renderDailyBrief({settings:s.settings,connected:true,card,el,button,command})
  const discovery=card(t('主动发现'),t('有依据才提出建议。关闭后仍可主动交办任务。'));const select=el('select');select.setAttribute('aria-label',t('主动发现间隔'));for(const [value,label]of [['0',t('关闭')],['15',t('每 15 分钟')],['30',t('每 30 分钟')],['60',t('每小时')],['120',t('每两小时')]]){const option=el('option',label);option.value=value;select.append(option)}select.value=s.settings?.discovery_enabled?String(s.settings.discovery_interval_minutes):'0';select.disabled=!caps.discovery||busy;select.addEventListener('change',()=>{void command('discovery.configure',{enabled:select.value!=='0',...(select.value!=='0'?{interval_minutes:Number(select.value)}:{})}).catch(local.onError)});discovery.append(select)
  if(busy)for(const input of root.querySelectorAll('button,input,select'))input.disabled=true
 }
 async function command(method,params={}){
  if(busy)throw new Error(t('请等待当前操作完成'))
  busy=true;actionNeedsRender=actionPending;error.textContent='';for(const input of root.querySelectorAll('button,input,select'))input.disabled=true
  try{
   const result=await api.personalCommand(method,params)
   if(result?.error)throw new Error(result.error)
   if(['sources.add','sources.authorize_computer'].includes(method)){local.sourceConsent=false;local.addSourceOpen=false}
   state=method==='state'?result:await api.personalCommand('state',{})
   if(state?.error)throw new Error(state.error)
   return result
  }finally{busy=false;if(!actionPending)render()}
 }
 async function load(){if(busy||actionPending)return;try{await command('state')}catch(caught){root.replaceChildren(el('p',t('未能读取连接状态，请重试。')));local.onError(caught)}}
 let polling=false
 const canPoll=()=>!busy&&!actionPending&&selected==='files'&&state?.sources?.some(s=>s.scan_pending)&&document.visibilityState==='visible'&&root.offsetParent!==null&&!root.contains(document.activeElement)
 const timer=document.defaultView?.setInterval(()=>{if(polling||!canPoll())return;polling=true;void api.personalCommand('state',{}).then(next=>{if(canPoll()&&!next?.error){state=next;render()}}).catch(()=>{/* Keep the last status during a transient disconnect. */}).finally(()=>{polling=false})},5000)
 document.defaultView?.addEventListener('pagehide',()=>document.defaultView.clearInterval(timer),{once:true})
 render()
 return {load}
}
