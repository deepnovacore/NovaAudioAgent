/** Sources stay out of the reading flow: a hover ⓘ, right-click, Shift+F10 or the ContextMenu key opens them in place. */
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
let current=null
const closeCurrent=restore=>{const open=current;current=null;open?.close(restore)}
/** Call before a panel rebuild: the open layer's document listeners and its detached subtree go with the old DOM. */
export function disposeSources(){closeCurrent(false)}
export function attachSources(host,labels,{title='查看依据'}={}){
 const items=[...new Set((labels??[]).filter(Boolean))]
 if(!items.length)return null
 host.dataset.sources='true'
 const info=el('button','ⓘ','source-info');info.type='button';info.setAttribute('aria-label',title);info.setAttribute('aria-haspopup','dialog');info.setAttribute('aria-expanded','false')
 const popover=el('div',undefined,'source-popover');popover.hidden=true;popover.tabIndex=-1;popover.setAttribute('role','dialog');popover.setAttribute('aria-label',title)
 popover.append(el('p',title,'source-popover-title'))
 const list=el('ul');for(const label of items)list.append(el('li',label));popover.append(list)
 const menu=el('div',undefined,'source-menu');menu.hidden=true;menu.setAttribute('role','menu')
 const item=el('button',title);item.type='button';item.setAttribute('role','menuitem');menu.append(item)
 host.append(info,popover,menu)
 let returnFocus=null
 const onKey=event=>{if(event.key==='Escape'){event.preventDefault();closeCurrent(true)}}
 const onPointer=event=>{if(!popover.contains(event.target)&&!menu.contains(event.target)&&event.target!==info)closeCurrent(false)}
 const listen=on=>{const method=on?'addEventListener':'removeEventListener';document[method]?.('keydown',onKey,true);document[method]?.('pointerdown',onPointer,true)}
 const entry={close(restore){popover.hidden=true;menu.hidden=true;info.setAttribute('aria-expanded','false');listen(false);if(restore&&returnFocus?.isConnected!==false)returnFocus?.focus?.()}}
 const take=()=>{if(current!==entry){closeCurrent(false);current=entry;listen(true)}}
 const open=()=>{take();menu.hidden=true;popover.hidden=false;info.setAttribute('aria-expanded','true');popover.focus?.()}
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
