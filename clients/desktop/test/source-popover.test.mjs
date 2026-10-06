import test from 'node:test'
import assert from 'node:assert/strict'
import {attachSources} from '../src/renderer/source-popover.mjs'

class Node{
 constructor(tag){this.tag=tag;this.children=[];this.parent=null;this.textContent='';this.className='';this.dataset={};this.style={};this.listeners={};this.hidden=false}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node)}}
 setAttribute(k,v){this[k]=v}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn)}
 contains(node){for(let n=node;n;n=n.parent)if(n===this)return true;return false}
 focus(){globalThis.document.activeElement=this}
 getBoundingClientRect(){return {left:40,bottom:90}}
}
function dom(t){
 const previous=globalThis.document;t.after(()=>{globalThis.document=previous})
 const doc={listeners:{},activeElement:null,createElement:tag=>new Node(tag),addEventListener(type,fn){(this.listeners[type]??=new Set()).add(fn)},removeEventListener(type,fn){this.listeners[type]?.delete(fn)}}
 globalThis.document=doc;return doc
}
const event=(target,extra={})=>({target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true},stopPropagation(){},...extra})
// Dispatch from the innermost node outward, as the browser bubbles.
const bubble=(target,type,extra)=>{const e=event(target,extra);for(let n=target;n;n=n.parent)for(const fn of n.listeners[type]??[])fn(e);return e}
const docFire=(doc,type,extra)=>{const e=event(extra?.target,extra);for(const fn of [...doc.listeners[type]??[]])fn(e);return e}

test('nothing is attached when there are no usable sources',t=>{
 dom(t);const host=new Node('article')
 assert.equal(attachSources(host,[]),null);assert.equal(attachSources(host,[undefined,null]),null)
 assert.deepEqual(host.children,[]);assert.equal(host.dataset.sources,undefined)
})

test('sources start hidden; the info icon toggles them and Escape returns focus',t=>{
 const doc=dom(t),host=new Node('article')
 const s=attachSources(host,['a.md','a.md','b.md'],{title:'查看来源'})
 assert.equal(s.popover.hidden,true);assert.equal(s.menu.hidden,true);assert.equal(host.dataset.sources,'true')
 assert.deepEqual(s.popover.children[1].children.map(n=>n.textContent),['a.md','b.md'],'labels are de-duplicated')
 assert.equal(s.info['aria-label'],'查看来源')
 bubble(s.info,'click');assert.equal(s.popover.hidden,false);assert.equal(s.info['aria-expanded'],'true');assert.equal(doc.activeElement,s.popover)
 docFire(doc,'keydown',{key:'Escape'});assert.equal(s.popover.hidden,true);assert.equal(s.info['aria-expanded'],'false');assert.equal(doc.activeElement,s.info)
 assert.equal(doc.listeners.keydown.size,0,'closing removes document listeners')
})

test('right-click opens a one-item menu at the pointer, and the item opens the sources',t=>{
 const doc=dom(t),host=new Node('article'),s=attachSources(host,['notes.md'])
 const e=bubble(host,'contextmenu',{clientX:120.4,clientY:48});assert.equal(e.defaultPrevented,true)
 assert.equal(s.menu.hidden,false);assert.deepEqual([s.menu.style.left,s.menu.style.top],['120px','48px'])
 const item=s.menu.children[0];assert.equal(item.role,'menuitem');assert.equal(doc.activeElement,item)
 bubble(item,'click');assert.equal(s.menu.hidden,true);assert.equal(s.popover.hidden,false)
 docFire(doc,'pointerdown',{target:new Node('main')});assert.equal(s.popover.hidden,true,'clicking elsewhere closes')
})

test('Shift+F10 and the ContextMenu key open the menu from the keyboard; plain F10 does not',t=>{
 dom(t);const host=new Node('article'),inner=new Node('button');host.append(inner);const s=attachSources(host,['notes.md'])
 bubble(inner,'keydown',{key:'F10',shiftKey:false});assert.equal(s.menu.hidden,true)
 bubble(inner,'keydown',{key:'F10',shiftKey:true});assert.equal(s.menu.hidden,false);assert.deepEqual([s.menu.style.left,s.menu.style.top],['40px','90px'])
 s.close();bubble(inner,'keydown',{key:'ContextMenu'});assert.equal(s.menu.hidden,false)
})

test('only one source layer is open, and a nested host owns its own right-click',t=>{
 dom(t);const outer=new Node('section'),inner=new Node('article');outer.append(inner)
 const a=attachSources(outer,['about.md']),b=attachSources(inner,['work.md'])
 bubble(inner,'contextmenu',{clientX:1,clientY:1});assert.equal(b.menu.hidden,false);assert.equal(a.menu.hidden,true)
 bubble(a.info,'click');assert.equal(a.popover.hidden,false);assert.equal(b.menu.hidden,true,'opening another closes the first')
})

test('a panel rebuild disposes the open layer, and focus never returns to a detached node',async t=>{
 const doc=dom(t),{disposeSources}=await import('../src/renderer/source-popover.mjs')
 const host=new Node('article'),s=attachSources(host,['notes.md'])
 bubble(s.info,'click');assert.equal(doc.listeners.keydown.size,1)
 disposeSources();assert.equal(s.popover.hidden,true);assert.equal(doc.listeners.keydown.size,0);assert.equal(doc.listeners.pointerdown.size,0)
 const again=attachSources(new Node('article'),['a.md']);bubble(again.info,'click');again.info.isConnected=false;doc.activeElement=null
 docFire(doc,'keydown',{key:'Escape'});assert.equal(again.popover.hidden,true);assert.equal(doc.activeElement,null,'a detached trigger is not focused')
})

test('verified channels are deduplicated and limited; details retain evidence without IDs or unsafe links',async t=>{
 dom(t);const {attachSourceTags}=await import('../src/renderer/source-popover.mjs'),host=new Node('article')
 const sources=[{type:'mail',evidence_id:'private-id',observed_at:'2026-10-04T00:00:00Z',summary:'邮件摘要',url:'https://example.com/message',mentioned_me:true},{type:'mail',evidence_id:'second'},{type:'im',provider:'feishu',summary:'讨论',url:'javascript:alert(1)'},{type:'calendar',summary:'会议'},{type:'unknown',label:'虚构'}]
 const result=attachSourceTags(host,sources,{autoRecorded:true})
 assert.deepEqual(result.tags.children.map(n=>n.textContent),['邮件','飞书','@我','自动记录'])
 bubble(result.tags.children[0],'click');assert.equal(result.popover.hidden,false)
 const all=n=>[n,...n.children.flatMap(all)],nodes=all(host)
 assert.equal(nodes.some(n=>n.textContent==='private-id'||n.textContent==='虚构'),false)
 assert.equal(nodes.filter(n=>n.tag==='a').length,1)
 assert.equal(nodes.find(n=>n.tag==='a').href,'https://example.com/message')
 assert.ok(nodes.some(n=>n.textContent==='日程'))
})
test('unknown origins get no invented channel and automatic recording is explicit',async t=>{
 dom(t);const {attachSourceTags}=await import('../src/renderer/source-popover.mjs'),host=new Node('article')
 assert.equal(attachSourceTags(host,[{type:'unknown'}]),null)
 const result=attachSourceTags(host,[],{autoRecorded:true});assert.deepEqual(result.tags.children.map(n=>n.textContent),['自动记录'])
})
test('tag dialogs restore keyboard focus and original links use the desktop opener',async t=>{
 const doc=dom(t),{attachSourceTags}=await import('../src/renderer/source-popover.mjs'),host=new Node('article'),opened=[]
 const result=attachSourceTags(host,[{type:'mail',url:'https://example.com/message',summary:'摘要'}],{openArticle:url=>opened.push(url)})
 const tag=result.tags.children[0];bubble(tag,'click')
 const row=result.popover.children[1].children[0],link=row.children.find(n=>n.tag==='a')
 assert.equal(bubble(link,'click').defaultPrevented,true);assert.deepEqual(opened,['https://example.com/message'])
 docFire(doc,'keydown',{key:'Escape'});assert.equal(doc.activeElement,tag)
})
