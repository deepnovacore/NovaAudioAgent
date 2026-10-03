import {t} from './locale.mjs'
export function renderConnectors({state,local,card,el,button,command,api,refresh}) {
 const intro=card(t('邮件与日历'),t('通过 Composio 连接 Google。Nova 只读取所选范围；托管 Google 授权可能包含写入权限，请以授权页面为准。'))
 if(!state?.available)intro.append(el('p',t('Google 连接需要在设置 → API 密钥填写 Composio 密钥。')))
 if(state?.memory_available===false){intro.append(el('p',t('请先在本机配置中启用本地记忆，再连接应用。')));return}
 const call=(method,params)=>command('connector.'+method,params)
 if(state?.local_available)button(t('连接本机日历'),async()=>{const status=await call('local_status',{});if(status.status!=='granted'){local.permission=true;refresh();return}await call('local_connect',{})},intro)
 if(state?.mail_available)button(t('连接本机邮件'),async()=>{const status=await call('mail_status',{});if(status.status!=='granted'){local.mailPermission=true;refresh();return}await call('mail_connect',{})},intro)
 if(local.mailPermission){intro.append(el('p',t('请先打开 Apple 邮件；Nova 需要自动化权限来只读所选邮箱，不发送或修改邮件。')));button(t('向系统申请邮件权限'),async()=>{await call('mail_access',{});await call('mail_connect',{});local.mailPermission=false},intro)}
 if(local.permission){intro.append(el('p',t('macOS 要求完整日历访问权限才能读取日程；Nova 只读，不修改日程。')));button(t('向系统申请日历权限'),async()=>{await call('local_access',{});await call('local_connect',{});local.permission=false},intro)}
 if(state?.available)for(const [toolkit,title] of [['gmail',t('连接 Gmail')],['googlecalendar',t('连接 Google 日历')]])button(title,async()=>{const result=await call('link',{toolkit});local[result.id]={url:result.url};await api.personal.openConnectorAuthorization(result.url)},intro)
 button(t('刷新连接'),()=>call('status',{}),intro)
 for(const connection of state?.connections??[]){
  const id=connection.id,edit=local[id]??=( {} ),a=card((connection.toolkit==='gmail'?'Gmail':connection.toolkit==='macos_mail'?t('本机邮件'):connection.toolkit==='macos_calendar'?t('本机日历'):t('Google 日历'))+(connection.identity?' · '+connection.identity:''),({authorizing:t('等待授权'),connected:t('已连接'),paused:t('已暂停'),disconnected:t('已断开，保留已同步数据')}[connection.state]??connection.state))
  if(connection.toolkit==='macos_mail')a.append(el('p',t('仅扫描最近最多 180 天，每轮最多检查 500 封；达到限额时不撤回范围外邮件。')))
  if(connection.scan_limited)a.append(el('p',t('已达到 500 封扫描上限，仅完成限额内读取。')))
  if(connection.last_complete)a.append(el('p',t('最近完整同步：')+new Date(connection.last_complete).toLocaleString()))
  if(connection.last_attempt)a.append(el('p',t('最近尝试：')+new Date(connection.last_attempt).toLocaleString()))
  if(connection.error)a.append(el('p',t('同步需要处理：')+connection.error))
  if(connection.has_pending)a.append(el('p',t('正在分批同步，已保存进度。')))
  if(connection.state==='authorizing'){
   if(edit.url)button(t('打开授权页面'),()=>api.personal.openConnectorAuthorization(edit.url),a)
   button(t('我已完成授权'),async()=>{await call('complete',{id});edit.url=null},a);continue
  }
  button(connection.scope?t('调整同步范围'):t('选择同步范围'),async()=>{edit.choices=await call('scopes',{id});edit.selected=new Set(connection.scope?.labels??connection.scope?.calendars??connection.scope?.mailboxes??[]);edit.processing=connection.processing_allowed;refresh()},a)
  if(edit.choices){
   const group=el('fieldset',undefined,'selection-list');group.append(el('legend',t('允许读取的标签、邮箱文件夹或日历')));a.append(group)
   for(const item of edit.choices.items){const label=el('label',undefined,'selection-row'),input=el('input');input.type='checkbox';input.checked=edit.selected.has(item.id);input.addEventListener('change',()=>input.checked?edit.selected.add(item.id):edit.selected.delete(item.id));label.append(input,el('span',item.name));group.append(label)}
   if(edit.choices.next)button(t('加载更多'),async()=>{const next=await call('scopes',{id,pageToken:edit.choices.next});edit.choices={items:[...edit.choices.items,...next.items],next:next.next};refresh()},a)
   const days=(title,name,fallback)=>{const label=el('label',title,'im-field'),input=el('input');input.type='number';input.min='1';input.max=connection.toolkit==='macos_mail'?'180':'365';input.value=String(edit[name]??connection.scope?.[name]??fallback);input.addEventListener('input',()=>{edit[name]=Number(input.value)});label.append(input);a.append(label);return input}
   const past=days(t('回溯天数'),'pastDays',connection.toolkit==='macos_mail'?180:30),future=!['gmail','macos_mail'].includes(connection.toolkit)?days(t('未来天数'),'futureDays',90):null
   const label=el('label',t('允许将所选原文发送给已配置的模型服务，抽取记忆和生成向量'),'personal-consent toggle-row'),consent=el('input');consent.type='checkbox';consent.setAttribute('role','switch');consent.checked=!!edit.processing;consent.addEventListener('change',()=>{edit.processing=consent.checked});label.prepend(consent);a.append(label)
   button(t('保存范围并开始同步'),async()=>{const values=[...edit.selected];await call('configure',{id,scope:future?{kind:'calendar',calendars:values,pastDays:Number(past.value),futureDays:Number(future.value)}:connection.toolkit==='macos_mail'?{kind:'macos_mail',mailboxes:values,pastDays:Number(past.value)}:{kind:'gmail',labels:values,pastDays:Number(past.value)},processingConsent:consent.checked});edit.choices=null;refresh()},a)
  }
  if(connection.scope){
   a.append(el('p',connection.processing_allowed?t('已允许模型处理所选内容'):t('仅保存在本机，不发送内容给模型')))
   if(connection.processing_allowed)button(t('撤回模型处理同意'),()=>call('consent',{id,processingConsent:false}),a)
   button(t('立即同步'),()=>call('sync',{id}),a)
   button(connection.state==='connected'?t('暂停同步'):t('恢复同步'),()=>call(connection.state==='connected'?'pause':'resume',{id}),a)
   button(t('断开连接'),()=>call('disconnect',{id}),a)
  }
  const deletion=el('div');deletion.hidden=true;deletion.append(el('p',t('删除 Nova 中此连接的同步数据及关联记忆；不会删除原应用中的邮件或日程。')))
  button(t('确认删除本地数据'),()=>call('delete',{id}),deletion);button(t('取消'),()=>{deletion.hidden=true},deletion)
  button(t('删除本地数据'),()=>{deletion.hidden=false},a);a.append(deletion)
 }
}
