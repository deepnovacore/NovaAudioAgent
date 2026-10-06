const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
const topics=['人工智能','科技产品','设计','科学','文化','商业']
export function initialInterests(news,warmup){
 // An intentionally empty, previously edited list is also a user choice.
 if(news?.interests?.length||news?.profile_version>0)return (news.interests??[]).map(i=>i.text)
 return warmup?.draft?.interests?.length?warmup.draft.interests.map(i=>i.text):topics.slice(0,3)
}
/** Interests guessed from the profile rank nothing until the user keeps them; this keeps them as they are. */
export function confirmedInterests(news){return {enabled:news?.enabled??false,explore:news?.explore??true,interests:(news?.interests??[]).map(i=>i.text),expected_version:news?.profile_version??0}}
export function renderWarmup(parent,{warmup,command,button}){
 // A draft on screen is refreshed silently; the status box is only for the first draft.
 if(warmup?.status!=='working'&&warmup?.status!=='failed'||warmup.draft)return
 const busy=warmup.status==='working',box=el('section',undefined,'warmup-status');box.setAttribute('role','status');box.setAttribute('aria-live','polite');box.setAttribute('aria-busy',String(busy));parent.append(box)
 if(busy){const spinner=el('span',undefined,'warmup-spinner');spinner.setAttribute('aria-hidden','true');box.append(spinner)}
 box.append(el('p',busy?'正在根据近期工作整理…':'初稿暂未生成，你仍可使用现有内容和通用主题。'))
 if(busy){const skeleton=el('div',undefined,'warmup-skeleton');skeleton.setAttribute('aria-hidden','true');for(let i=0;i<3;i++)skeleton.append(el('span'));box.append(skeleton)}
 if(!busy)button('重新生成',()=>command('profile.refresh',{}),box)
}
export function renderInterests(parent,{news,warmup,command,button,local,rerender,delegate}){
 const texts=initialInterests(news,warmup),seeded=Boolean(news?.interests_seeded&&news.interests?.length),configured=!seeded&&Boolean(news?.interests?.length||news?.profile_version>0)
 const card=el('section',undefined,'preference-card');card.setAttribute('aria-label','资讯兴趣');parent.append(card)
 const heading=el('div',undefined,'preference-heading');heading.append(el('h3','你的资讯兴趣'),el('span',configured?'已保存':seeded?'从 Profile 猜的 · 待确认':warmup?.draft?.interests?.length?'为你生成 · 可调整':'通用起点 · 可调整','preference-caption'));card.append(heading)
 if(local.interestSaving){const progress=el('p','正在保存…','action-progress');progress.setAttribute('role','status');card.append(progress)}
 const draft=local.interestEdit
 const save=async(value)=>{
  if(local.interestSaving)return
  local.interestSaving=true;delete local.interestError;rerender()
  try{await command('news.configure',value);delete local.interestEdit}
  catch{local.interestError='未能保存，调整已保留。请重试；若设置已在别处更新，请取消后重新调整。'}
  finally{local.interestSaving=false;rerender()}
 }
 const settings=(values=texts)=>({enabled:news?.enabled??false,explore:news?.explore??true,interests:values,expected_version:news?.profile_version??0})
 if(draft){
  const chips=el('div',undefined,'interest-chips');chips.setAttribute('role','group');chips.setAttribute('aria-label','选择兴趣');card.append(chips)
  for(const text of [...new Set([...draft.interests,...texts,...topics])]){
   const selected=draft.interests.includes(text),chip=button(`${selected?'✓ ':''}${text}`,()=>{draft.interests=selected?draft.interests.filter(t=>t!==text):[...draft.interests,text];rerender()},chips)
   chip.setAttribute('aria-label',text);chip.setAttribute('aria-pressed',String(selected));chip.disabled=local.interestSaving||!selected&&draft.interests.length>=8
  }
  const add=el('form',undefined,'interest-add'),input=el('input');input.value=draft.custom??'';input.placeholder='添加其他主题';input.maxLength=100;input.setAttribute('aria-label','自定义兴趣');input.addEventListener('input',()=>{draft.custom=input.value});add.append(input);card.append(add)
  const append=()=>{const text=input.value.trim();if(text&&!draft.interests.includes(text)&&draft.interests.length<8)draft.interests.push(text);draft.custom='';rerender()}
  add.addEventListener('submit',event=>{event.preventDefault();if(!local.interestSaving)append()});button('添加',append,add).disabled=local.interestSaving||draft.interests.length>=8
  card.append(el('p',`${draft.interests.length} / 8 个主题`,'preference-caption'))
  const actions=el('div',undefined,'preference-actions');card.append(actions)
  const done=button('完成调整',()=>save({enabled:draft.enabled,explore:draft.explore,interests:draft.interests,expected_version:draft.version}),actions);done.className='page-add';done.disabled=local.interestSaving||draft.enabled&&!draft.interests.length
  button('取消',()=>{delete local.interestEdit;delete local.interestError;rerender()},actions).disabled=local.interestSaving
 }else{
  const chips=el('div',undefined,'interest-chips');card.append(chips)
  for(const text of texts)chips.append(el('span',text,'interest-tag'))
  if(!texts.length)card.append(el('p','尚未选择兴趣，可以随时添加。','preference-caption'))
  const actions=el('div',undefined,'preference-actions');card.append(actions)
  if(seeded)button('就用这些',()=>save(confirmedInterests(news)),actions).disabled=local.interestSaving
  button('调整兴趣',()=>{local.interestEdit={...settings(),version:news?.profile_version??0,interests:[...texts],custom:''};rerender()},actions).disabled=local.interestSaving
  if(delegate)button('和 Nova 聊聊这些兴趣',()=>delegate(`我想调整资讯兴趣，目前是：${texts.join('、')}。请先和我讨论适合的主题。`),actions)
 }
 const enabled=news?.enabled??false
 const row=el('div',undefined,'preference-row'),copy=el('div');copy.append(el('h4','资讯更新'),el('p',enabled?'自动获取你感兴趣的公开资讯':'开启后获取公开资讯；只将所选主题和公开摘要用于推荐。','preference-caption'));row.append(copy);card.append(row)
 const toggle=button(enabled?'已开启':'开启资讯',()=>save({...settings(),enabled:!enabled}),row);toggle.className='preference-switch';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label','资讯更新');toggle.setAttribute('aria-checked',String(enabled));toggle.disabled=local.interestSaving||Boolean(draft)||!enabled&&!texts.length
 if(enabled){const range=el('div',undefined,'preference-row');range.append(el('div','推荐范围'));const choices=el('div',undefined,'preference-segments');choices.setAttribute('role','group');choices.setAttribute('aria-label','推荐范围');range.append(choices);card.append(range)
  for(const [value,label]of [[false,'专注兴趣'],[true,'适度探索']]){const b=button(label,()=>save({...settings(),explore:value}),choices);b.setAttribute('aria-pressed',String((news.explore??true)===value));b.disabled=local.interestSaving||Boolean(draft)}
  card.append(el('p',news.explore?'包含少量相关的新主题，帮助你发现更多内容。':'优先展示与你的兴趣相关的内容。','preference-caption'))
 }
 if(local.interestSaving){const status=el('p','正在保存…','preference-caption');status.setAttribute('role','status');card.append(status)}
 if(local.interestError){const error=el('p',local.interestError,'preference-error');error.setAttribute('role','alert');card.append(error)}
 return card
}
