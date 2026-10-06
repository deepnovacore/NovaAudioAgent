import {memoryOverview} from './memory-overview.mjs'
/** The memory section under Profile: host-generated overview first, editable records behind a disclosure. */
export function renderMemorySection(parent,{snapshot:s,caps,el,button,chips,command,continueChat,connected,bindPending,local={}}){
 const section=el('details',undefined,'memory-section');section.append(el('summary','Nova 对你的了解'));section.open=Boolean(local.memoryOpen);section.addEventListener('toggle',()=>{local.memoryOpen=section.open});parent.append(section)
 const card=(title,summary)=>{const a=el('article',undefined,'card');a.append(el('h3',title));if(summary)a.append(el('p',summary));section.append(a);return a}
 for(const pending of s?.memory?.pending_purges??[]){
  const a=card('彻底删除尚未完成','仍有历史或备份副本未清除。恢复备份访问后可继续清理。')
  button('继续清理',async()=>{const result=await command('memory.purge',{id:pending.entry_id,expected_version:pending.expected_revision});if(result?.status!=='complete')throw new Error('彻底删除未完成：仍有副本未清除。')},a)
 }
 const includeExpired=s?.memory?.include_expired===true
 const entries=(s?.memory?.entries??[]).filter(m=>m.status==='active')
 const overview=memoryOverview(entries,s?.memory?.overview)
 const recordDetails=(host,items,label)=>{
  const records=el('details',undefined,'memory-group-details');records.append(el('summary',label));host.append(records)
  for(const entry of items){
   const a=el('article',undefined,'memory-entry-details');a.append(el('h4',entry.topic||entry.content?.slice(0,48)||'记忆'));a.append(el('p',entry.content));chips(a,[entry.origin==='stated'?'你说过':'根据资料',entry.status==='expired'?'已过期':null,entry.confidence_note]);records.append(a)
   if(entry.commitment)chips(a,[{owed_by_me:'我答应的',owed_to_me:'等对方回复'}[entry.commitment.direction],{open:'待完成',done:'已完成',dropped:'已取消'}[entry.commitment.status],entry.commitment.due?new Date(entry.commitment.due).toLocaleDateString('zh-CN'):null])
   const actions=el('div',undefined,'card-actions')
   button('接着聊',()=>continueChat(entry.content),actions)
   if(entry.editable!==false){
    const correction=el('textarea');correction.value=entry.content;correction.maxLength=500;correction.setAttribute('aria-label','纠正记忆内容');correction.hidden=true;a.append(correction,actions)
    const edit=button('纠正',async()=>{if(correction.hidden){correction.hidden=false;correction.focus();edit.textContent='保存纠正';return}await command('memory.correct',{id:entry.id,expected_version:entry.version,content:correction.value})},actions,`memory:${entry.id}`);edit.disabled=!caps.memory?.correct||entry.version==null;edit.title=edit.disabled?'当前后端不支持版本化纠正':''
    const forget=button('忘记',()=>command('memory.forget',{id:entry.id,expected_version:entry.version}),actions,`memory:${entry.id}`);forget.disabled=!caps.memory?.forgetEntry||entry.version==null;forget.title=forget.disabled?'当前后端不支持按条目忘记':''
    if(caps.memory?.purgeEntry&&entry.version!=null){
     const deletion=el('div');deletion.hidden=true;deletion.setAttribute('role','group');deletion.setAttribute('aria-label','确认彻底删除记忆');deletion.append(el('p','彻底删除这条记忆及其对应原文、Git 历史和迁移备份副本。相关派生摘要也会清除，此操作无法撤销。'))
     button('彻底删除',()=>{deletion.hidden=false},actions).className='quiet danger';a.append(deletion)
     button('取消',()=>{deletion.hidden=true},deletion)
     button('确认彻底删除',async()=>{const result=await command('memory.purge',{id:entry.id,expected_version:entry.version});if(result?.status!=='complete')throw new Error('彻底删除未完成：仍有副本未清除，请重试或查看备份状态。')},deletion,`memory:${entry.id}`)
    }
   }
   else a.append(actions)
  }
  return records
 }
 if(!caps.memory?.list)card('暂时无法查看记忆','此工作台当前无法显示记忆记录。')
 else{
  const hero=card('记忆总览');hero.classList.add('memory-hero')
  hero.append(el('p',overview.summary,'memory-overview-copy'))
  if(!overview.generated&&entries.length)hero.append(el('p','摘要尚未生成，原始记录仍可在下方查看。','hint'))
  hero.append(el('p',overview.coverage,'memory-coverage'))
  for(const group of overview.groups){const a=card(group.title,group.summary);a.classList.add('memory-group');chips(a,group.keywords)}
  const holder=el('div',undefined,'memory-records');section.append(holder)
  const managed=(s?.memory?.entries??[]).filter(entry=>entry.status==='active'||includeExpired&&entry.status==='expired')
  const records=recordDetails(holder,managed,'管理记忆')
  const expiredLabel=el('label',undefined,'consent'),expiredCheck=el('input');expiredCheck.type='checkbox';expiredCheck.checked=includeExpired;expiredCheck.disabled=!connected;expiredLabel.append(expiredCheck,document.createTextNode('包含已过期'));records.append(expiredLabel)
  const loadExpired=async()=>{try{await command('memory.list',{limit:50,include_expired:expiredCheck.checked})}catch(error){expiredCheck.checked=includeExpired;throw error}};if(bindPending)bindPending(expiredCheck,'memory:list',loadExpired,'change');else expiredCheck.addEventListener('change',()=>{void loadExpired().catch(error=>{expiredLabel.append(el('span',error.message,'page-error'))})})
  const pager=el('div',undefined,'memory-pager');section.append(pager)
  if(s?.memory?.cursor)button('下一页',()=>command('memory.list',{cursor:s.memory.cursor,limit:50,include_expired:includeExpired}),pager,'memory:list')
  button('返回第一页',()=>command('memory.list',{limit:50,include_expired:includeExpired}),pager,'memory:list')
 }
 return section
}
