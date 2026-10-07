import {t} from './locale.mjs'
/** Connection controls share the host's state; OAuth device codes never enter this view. */
export function renderFeishu({state={},local,card,el,button,command,refresh,api}) {
 state??={}
 const accountKey=state.account_id??state.account_name??null
 if(local.accountKey!==accountKey){local.accountKey=accountKey;local.chats=null;local.verification_url=null;local.editScope=false}
 if(!['ready','connected','paused'].includes(state.state))local.chats=null
 const a=card(t('飞书'),t('把选定会话里的约定和进展记下来。机器人提醒可单独开启。'))
 a.classList.add('im-guide')
 let guideActions
 const originalButton=button
 const primaryLabels=new Set([t('创建飞书应用'),t('继续在飞书中配置'),t('绑定并继续'),t('登录飞书'),t('重新授权飞书'),t('打开飞书授权页面'),t('选择会话'),t('完成配置')])
 button=(label,action,parent)=>{const b=originalButton(label,action,parent===a&&guideActions?guideActions:parent);if(primaryLabels.has(label))b.classList.add('im-guide-primary');return b}
 const note=text=>a.append(el('p',text,'personal-hint'))
 const call=async(method,params={})=>{const result=await command(`feishu.${method}`,params);refresh();return result}
 const check=(text,checked,parent=a,switchControl=true)=>{const label=el('label',undefined,'personal-consent toggle-row'),input=el('input');input.type='checkbox';if(switchControl)input.setAttribute('role','switch');else label.className='selection-row';input.checked=checked;label.append(input,document.createTextNode(text));parent.append(label);return input}
 if(!state.available){note(state.error||t('当前运行环境尚未启用飞书连接。'));note(t('需要安装 lark-cli 1.0.69 或更高版本，再重新打开 Nova。'));return}
 const connected=['ready','connected','paused'].includes(state.state)
 const completed=connected&&state.scope_configured===true
 const current=!state.configured?0:!connected?1:completed&&!local.editScope?3:2
 const steps=el('ol',undefined,'im-steps');steps.setAttribute('aria-label',t('飞书连接进度'))
 for(const [index,title] of [t('连接应用'),t('授权账号'),t('选择会话')].entries()){
  const step=el('li'),done=index<current
  step.setAttribute('aria-current',index===current?'step':'false');step.dataset.state=done?'done':index===current?'current':'pending'
  step.append(el('span',done?'✓':String(index+1),'im-step-dot'),el('span',title,'im-step-label'),el('small',done?t('已完成'):index===current?t('当前步骤'):t('接下来')));steps.append(step)
 }
 a.append(steps)
 const guide=el('section',undefined,'im-guide-stage')
 const titles=[t('先给 Nova 连接一个飞书应用'),t('授权你自己的飞书账号'),t('决定 Nova 可以读取哪些会话')]
 const descriptions=[t('应用用来连接飞书。完成后，还会单独请求你的账号授权。'),t('登录和确认在飞书官方页面完成，Nova 会在这里显示结果。'),t('只读取你选中的会话；之后随时可以调整范围或暂停同步。')]
 if(current===3){guide.setAttribute('role','status');guide.append(el('p',t('已完成'),'im-guide-kicker'),el('h4',t('飞书配置完成')),el('p',t('已保存同步范围。你可以随时调整会话或暂停同步。')))}
 else guide.append(el('p',t('第 {0} 步 / 共 3 步',current+1),'im-guide-kicker'),el('h4',titles[current]),el('p',descriptions[current]))
 if(current<2){
  guideActions=el('section',undefined,'im-guide-actions');guide.append(guideActions)
  const checklist=el('ol',undefined,'im-guide-checklist')
  const instructions=current===0?[t('打开飞书页面，确认登录的是你要使用的账号。'),t('按页面提示创建应用；已有应用可用下方入口绑定。'),t('完成后回到 Nova，继续授权账号。')]:[t('打开授权页面，使用飞书扫码或登录。'),t('查看页面列出的权限，再确认授权。'),t('回到 Nova 确认完成，然后选择要同步的会话。')]
  for(const text of instructions)checklist.append(el('li',text))
  guide.append(checklist)
 }
 a.append(guide)
 if(!state.configured){
  note(t('机器人提醒可以稍后单独设置，现在先完成连接。'))
  const setup=state.app_setup??{}
  if(setup.state==='waiting'){
   const waiting=el('p',t('正在等待你完成飞书页面上的操作。此窗口可以保持打开。'),'im-guide-waiting');waiting.setAttribute('role','status');a.append(waiting)
   if(setup.verification_url)button(t('继续在飞书中配置'),()=>api.personal.openFeishuVerification?.(setup.verification_url),a)
   button(t('我已完成，继续'),()=>call('app.status'),a)
   button(t('取消配置'),()=>call('app.cancel'),a)
  }else{
   if(setup.error)note(setup.error)
   button(t('创建飞书应用'),()=>call('app.start'),a)
   button(t('绑定已有应用'),()=>{local.bindApp=!local.bindApp;refresh()},a)
   if(local.bindApp){
    note(t('在飞书开放平台的应用详情中，找到「凭证与基础信息」。'))
    button(t('打开飞书开放平台'),()=>api.personal.openFeishuVerification?.('https://open.feishu.cn/app'),a)
    const field=(title,type)=>{const label=el('label',title,'im-field'),input=el('input');input.type=type;input.autocomplete='off';input.setAttribute('aria-label',title);label.append(input);a.append(label);return input}
    const id=field('App ID','text'),secret=field('App Secret','password')
    button(t('绑定并继续'),async()=>{const params={app_id:id.value.trim(),app_secret:secret.value};secret.value='';await call('app.bind',params);local.bindApp=false;refresh()},a)
   }
  }
  button(t('刷新状态'),()=>call('status'),a);return
 }
 note(({ready:t('已连接'),connected:t('已连接'),paused:t('同步已暂停'),disconnected:t('已断开，历史记录保留'),authorizing:t('等待飞书授权'),error:t('连接需要处理')}[state.state]??t('尚未登录'))+(state.account_name?` · ${state.account_name}`:''))
 if(state.error)note(state.error)
 button(t('刷新状态'),()=>call('status'),a)
 if(!['ready','connected','paused'].includes(state.state)) {
  const reauthorize=state.auth_issue==='expired'||state.auth_issue==='missing_scopes'
  note(state.auth_issue==='expired'?t('飞书账号授权已过期，同步和机器人提醒已暂停。请重新扫码授权，无需重新绑定应用；已选会话和本地历史保留。'):state.auth_issue==='missing_scopes'?t('飞书账号缺少所需读取权限。请重新授权，无需重新绑定应用。'):t('应用已连接。接下来授权你的账号，授权后再选择要同步的会话。'))
  button(reauthorize?t('重新授权飞书'):t('登录飞书'),async()=>{const result=await call('login');local.verification_url=result?.verification_url;refresh();if(local.verification_url)await api.personal.openFeishuVerification?.(local.verification_url)},a)
  if(local.verification_url){
   if(api.personal.openFeishuVerification)button(t('打开飞书授权页面'),()=>api.personal.openFeishuVerification(local.verification_url),a)
   else {const link=el('input');link.value=local.verification_url;link.readOnly=true;link.setAttribute('aria-label',t('飞书授权链接'));a.append(link)}
   button(t('我已完成授权'),async()=>{await call('complete');local.verification_url=null;const result=await call('chats');local.chats=result?.chats??result;refresh()},a)
  }
 } else {
  local.verification_url=null
  note(t('只同步你选中的会话。原文默认保留 30 天，到期清理原文；已形成的记忆可单独管理。'))
  button(completed?t('调整会话'):t('选择会话'),async()=>{const result=await call('chats');local.chats=result?.chats??result;local.editScope=true;refresh()},a)
  const chats=local.chats??state.chats??[]
  if(chats.length&&(!completed||local.editScope)){
   const group=el('fieldset');group.append(el('legend',t('选择要同步的会话')));a.append(group)
   const selected=new Set(chats.filter(chat=>chat.selected).map(chat=>chat.id))
   const bulk=el('div',undefined,'im-chat-bulk'),list=el('div',undefined,'im-chat-list');list.setAttribute('role','group');list.setAttribute('aria-label',t('可同步的飞书会话'));list.tabIndex=0;group.append(bulk,list)
   const choices=[]
   const setAll=value=>{for(const {chat,input}of choices){input.checked=value;if(value)selected.add(chat.id);else selected.delete(chat.id)}}
   button(t('全选'),()=>setAll(true),bulk);button(t('取消全选'),()=>setAll(false),bulk)
   group.append(el('p',t('最近活跃优先'),'personal-hint'))
   for(const chat of chats){const input=check(chat.name||t('未命名会话'),selected.has(chat.id),list,false);choices.push({chat,input});input.addEventListener('change',()=>input.checked?selected.add(chat.id):selected.delete(chat.id))}
   const consent=check(t('允许读取所选会话并保存在本机'),false,a,false)
   const save=button(t('完成配置'),async()=>{await call('configure',{chat_ids:[...selected],consent:true});local.chats=null;local.editScope=false;refresh()},a);save.disabled=true
   consent.addEventListener('change',()=>{save.disabled=!consent.checked})
  }else if(local.chats)note(t('没有可选会话。请确认账号权限后重新加载。'))
  const processing=check(t('允许设置中的模型服务处理飞书内容'),state.processing_consent_required===false)
  processing.disabled=!completed
  note(t('读取与模型处理分别授权。关闭模型处理后，已读取的内容保留在本机；保存新的会话范围后需重新开启。'))
  if(state.processing_consent_required)note(t('尚未同意当前模型处理，或模型服务已变更；开启后才会交由当前服务整理。'))
  processing.addEventListener('change',async()=>{const consent=processing.checked;processing.disabled=true;try{await call('consent',{consent})}catch(error){processing.checked=!consent;local.onError(error)}finally{processing.disabled=!completed}})
  if(state.last_sync)note(t('上次同步：{0}',state.last_sync))
  button(t('立即同步'),()=>call('sync'),a)
  button(state.state==='paused'?t('恢复同步'):t('暂停同步'),()=>call(state.state==='paused'?'resume':'pause'),a)
  button(t('断开（保留历史）'),async()=>{await call('disconnect');local.chats=null;local.verification_url=null;refresh()},a)
  const setupBot=el('details');setupBot.append(el('summary',t('设置 Nova 的飞书机器人')),el('p',t('在应用后台添加机器人能力，按页面提示配置权限、发布应用并确认你在可用范围内，再到飞书打开机器人私聊。完成后开启下方提醒。')));button(t('打开应用后台'),()=>api.personal.openFeishuVerification?.(state.app_id?`https://open.feishu.cn/app/${encodeURIComponent(state.app_id)}`:'https://open.feishu.cn/app'),setupBot);a.append(setupBot)
  const bot=check(t('在飞书私聊中接收 Nova 提醒'),state.bot_enabled===true)
  note(t('只发给你与机器人的私聊。可在卡片中稍后提醒或忽略；处理任务仍需回到 Nova 确认。'))
  bot.addEventListener('change',()=>{const enabled=bot.checked;bot.disabled=true;void call('bot.configure',{enabled}).catch(error=>{bot.checked=!enabled;local.onError(error)}).finally(()=>{bot.disabled=false})})
 }
 const deletion=el('div');deletion.hidden=true;deletion.setAttribute('role','group');deletion.setAttribute('aria-label',t('确认删除飞书历史'))
 deletion.append(el('p',t('删除本地已保存的飞书消息及其索引？依赖这些消息的记忆和建议会更新或撤回。飞书中的原消息不会被删除。')))
 button(t('确认删除本地历史'),async()=>{await call('delete');local.chats=null;refresh()},deletion)
 button(t('取消'),()=>{deletion.hidden=true},deletion)
 button(t('删除本地历史'),()=>{deletion.hidden=false;deletion.querySelector('button').focus()},a);a.append(deletion)
}
