/** Sources stay out of the reading flow: a hover ⓘ, right-click, Shift+F10 or the ContextMenu key opens them in place. */
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
let current=null
const closeCurrent=restore=>{const open=current;current=null;open?.close(restore)}
/** Call before a panel rebuild: the open layer's document listeners and its detached subtree go with the old DOM. */
export function disposeSources(){closeCurrent(false)}
export function attachSources(host,labels,{title='查看依据',renderItem}={}){
 const items=[...new Set((labels??[]).filter(Boolean))]
 if(!items.length)return null
 host.dataset.sources='true'
 const info=el('button','ⓘ','source-info');info.type='button';info.setAttribute('aria-label',title);info.setAttribute('aria-haspopup','dialog');info.setAttribute('aria-expanded','false')
 const popover=el('div',undefined,'source-popover');popover.hidden=true;popover.tabIndex=-1;popover.setAttribute('role','dialog');popover.setAttribute('aria-label',title)
 popover.append(el('p',title,'source-popover-title'))
 const list=el('ul');for(const label of items){const row=el('li');if(renderItem)renderItem(row,label);else row.textContent=label;list.append(row)};popover.append(list)
 const menu=el('div',undefined,'source-menu');menu.hidden=true;menu.setAttribute('role','menu')
 const item=el('button',title);item.type='button';item.setAttribute('role','menuitem');menu.append(item)
 host.append(info,popover,menu)
 let returnFocus=null
 const onKey=event=>{if(event.key==='Escape'){event.preventDefault();closeCurrent(true)}}
 const onPointer=event=>{if(!popover.contains(event.target)&&!menu.contains(event.target)&&event.target!==info)closeCurrent(false)}
 const listen=on=>{const method=on?'addEventListener':'removeEventListener';document[method]?.('keydown',onKey,true);document[method]?.('pointerdown',onPointer,true)}
 const entry={close(restore){popover.hidden=true;menu.hidden=true;info.setAttribute('aria-expanded','false');listen(false);if(restore&&returnFocus?.isConnected!==false)returnFocus?.focus?.()}}
 const take=()=>{if(current!==entry){closeCurrent(false);current=entry;listen(true)}}
 const open=trigger=>{if(trigger)returnFocus=trigger;take();menu.hidden=true;popover.hidden=false;info.setAttribute('aria-expanded','true');popover.focus?.()}
 const openMenu=(x,y)=>{take();popover.hidden=true;menu.hidden=false;menu.style.left=`${Math.round(x)}px`;menu.style.top=`${Math.round(y)}px`;item.focus?.()}
 info.addEventListener('click',event=>{event.stopPropagation?.();returnFocus=info;if(popover.hidden)open();else closeCurrent(true)})
 item.addEventListener('click',()=>{open()})
 host.addEventListener('contextmenu',event=>{
  // A nested source host owns its own right-click; the outer card must not open over it.
  if(event.defaultPrevented)return
  event.preventDefault();returnFocus=document.activeElement??info;openMenu(event.clientX,event.clientY)
 })
 host.addEventListener('keydown',event=>{
  if(event.defaultPrevented||!(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey))return
  event.preventDefault();returnFocus=document.activeElement??info
  const box=(event.target?.getBoundingClientRect?.()??host.getBoundingClientRect?.())
  openMenu(box?.left??0,box?.bottom??0)
 })
 return {info,popover,menu,open,close:()=>closeCurrent(false)}
}

const channel=source=>new Map([['mail','邮件'],['calendar','日程'],['im',source.provider==='feishu'?'飞书':'IM'],['file','文件'],['conversation','对话'],['task','任务']]).get(source.type)
const safeSourceUrl=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null}catch{return null}}
/** Channel and mention badges come only from structured provenance, never from a title or reference ID. */
export function attachSourceTags(host,sources,{autoRecorded=false,sourceChanged=false,openArticle}={}){
 const items=(Array.isArray(sources)?sources:[]).filter(source=>source&&channel(source))
 if(!items.length&&!autoRecorded&&!sourceChanged)return null
 const tags=el('div',undefined,'source-tags');host.append(tags)
 const details=attachSources(host,items,{title:'查看来源',renderItem(row,source){
  row.append(el('strong',channel(source)))
  if(source.label)row.append(el('span',source.label,'source-label'))
  if(source.summary)row.append(el('p',source.summary))
  if(source.observed_at&&!Number.isNaN(Date.parse(source.observed_at))){const time=el('time',new Date(source.observed_at).toLocaleString());time.dateTime=source.observed_at;row.append(time)}
  const url=safeSourceUrl(source.url)
  if(url){const link=el('a','查看原文');link.href=url;link.target='_blank';link.rel='noopener noreferrer';if(openArticle)link.addEventListener('click',event=>{event.preventDefault();event.stopPropagation?.();openArticle(url)});row.append(link)}
 }})
 for(const name of [...new Set(items.map(channel))].slice(0,2)){
  const tag=el('button',name,'source-tag');tag.type='button';tag.setAttribute('aria-label',`${name} · 查看来源`);tag.setAttribute('aria-haspopup','dialog')
  tag.addEventListener('click',event=>{event.stopPropagation?.();details.open(tag)});tags.append(tag)
 }
 if(items.some(source=>source.mentioned_me===true))tags.append(el('span','@我','source-mention'))
 if(autoRecorded===true)tags.append(el('span','自动记录','source-automatic'))
 if(sourceChanged===true)tags.append(el('span','来源有更新','source-changed'))
 return {...details,tags}
}
