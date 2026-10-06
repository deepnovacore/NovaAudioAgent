import test from 'node:test'
import assert from 'node:assert/strict'
import {mountCodingTargetMenu,targetLevels,targetLabel} from '../src/renderer/coding-target-menu.mjs'

class Node{
 constructor(tag,text){this.tag=tag;this.textContent=text??'';this.children=[];this.listeners={};this.attrs={};this.hidden=false;this.disabled=false}
 append(...c){for(const n of c)n.parentElement=this;this.children.push(...c)}
 replaceChildren(...c){this.children=[];this.append(...c)}
 setAttribute(k,v){this.attrs[k]=v}
 addEventListener(name,fn){this.listeners[name]=fn}
 querySelectorAll(sel){return this.children.flatMap(n=>[...(n.tag===sel?[n]:[]),...n.querySelectorAll(sel)])}
 contains(node){return this===node||this.children.some(child=>child.contains(node))}
 focus(){document.activeElement=this}
}
const el=(tag,text,className)=>{const n=new Node(tag,text);if(className)n.className=className;return n}
const all=n=>[n,...n.children.flatMap(all)]
const flush=async()=>{for(let i=0;i<4;i++)await Promise.resolve()}
const catalog=[
 {workspace_id:'ws-1',session_id:null,project:'Alpha',title:'',directory:'/one'},
 {workspace_id:'ws-1',session_id:'s-1',project:'Alpha',title:'Fix audio',directory:'/one'},
 {workspace_id:'ws-2',session_id:null,project:'Beta',title:'',directory:'/two'},
]

function mount({targets=catalog,fail=false,gate=null}={}){
 globalThis.document={addEventListener(){},removeEventListener(){},activeElement:null}
 const parent=el('div'),commands=[]
 const c={connected:true,presentationReady:true,selectedId:'a',snapshot:{conversations:{items:[{id:'a'},{id:'b'}]}},
  command:async(method,params)=>{commands.push([method,params]);if(fail&&method==='conversations.targets')throw new Error('x');if(gate&&method==='conversations.target')await gate;return method==='conversations.targets'?{targets}:{}}}
 const menu=mountCodingTargetMenu(parent,{c,el,run:action=>action()})
 menu.update()
 const chip=()=>all(menu.element).find(n=>n.className==='target-chip')
 const items=()=>all(menu.element).filter(n=>n.className==='target-item')
 const byText=text=>items().find(n=>n.textContent===text)
 return {c,menu,commands,chip,items,byText}
}

test('the chip is absent until a coding executor announces itself and goes away on disconnect', () => {
 const m=mount()
 assert.equal(m.menu.element.hidden,true)
 m.menu.receive({type:'executor.state',state:'idle'})
 assert.equal(m.menu.element.hidden,false)
 m.c.connected=false;m.menu.update()
 assert.equal(m.menu.element.hidden,true)
 m.c.connected=true;m.menu.update()
 assert.equal(m.menu.element.hidden,true,'the announcement belongs to the old connection')
 m.menu.receive({type:'executor.state',state:'idle'})
 assert.equal(m.menu.element.hidden,false)
})

test('opening loads targets and lists workspaces; picking one keeps the menu open for its sessions', async () => {
 const m=mount();m.menu.receive({type:'executor.state'})
 m.chip().listeners.click();await flush()
 assert.equal(m.chip().attrs['aria-expanded'],'true')
 assert.deepEqual(m.commands[0],['conversations.targets',{}])
 assert.deepEqual(m.items().map(n=>n.textContent),['不指定工作区','Alpha','Beta'])
 m.byText('Alpha').listeners.click();await flush()
 assert.deepEqual(m.commands.at(-1),['conversations.target',{id:'a',target:{workspace_id:'ws-1',session_id:null}}])
 assert.equal(m.menu.open,true)
})

test('the second level lists sessions plus a new-session row and picking one closes the menu', async () => {
 const m=mount();m.menu.receive({type:'executor.state'})
 m.c.snapshot.conversations.items[0].coding_target={workspace_id:'ws-1',session_id:null,project:'Alpha',title:''}
 m.menu.update();m.chip().listeners.click();await flush()
 assert.deepEqual(m.items().map(n=>n.textContent),['不指定工作区','Alpha','Beta','新会话','Fix audio'])
 m.byText('Fix audio').listeners.click();await flush()
 assert.deepEqual(m.commands.at(-1),['conversations.target',{id:'a',target:{workspace_id:'ws-1',session_id:'s-1'}}])
 assert.equal(m.menu.open,false)
 assert.equal(m.chip().attrs['aria-expanded'],'false')
})

test('clearing the workspace sends a null target', async () => {
 const m=mount();m.menu.receive({type:'executor.state'})
 m.c.snapshot.conversations.items[0].coding_target={workspace_id:'ws-1',session_id:null,project:'Alpha',title:''}
 m.menu.update();m.chip().listeners.click();await flush()
 m.byText('不指定工作区').listeners.click();await flush()
 assert.deepEqual(m.commands.at(-1),['conversations.target',{id:'a',target:null}])
})

test('empty, loading and failed loads are explicit, never a silent disabled control', async () => {
 let m=mount({targets:[]});m.menu.receive({type:'executor.state'})
 m.chip().listeners.click()
 assert.ok(all(m.menu.element).some(n=>n.textContent==='正在加载工作区…'))
 await flush()
 assert.ok(all(m.menu.element).some(n=>n.textContent==='还没有工作区'))
 m=mount({fail:true});m.menu.receive({type:'executor.state'})
 m.chip().listeners.click();await flush()
 const retry=m.byText('加载失败，点击重试');assert.ok(retry)
 m.commands.length=0;retry.listeners.click();await flush();assert.equal(m.commands[0][0],'conversations.targets')
})

test('a catalog that finishes loading for another conversation is discarded', async () => {
 const m=mount();m.menu.receive({type:'executor.state'})
 m.chip().listeners.click()
 m.c.selectedId='b';m.menu.update();await flush()
 assert.equal(m.menu.open,false)
 m.chip().listeners.click();await flush()
 assert.equal(m.commands.filter(([method])=>method==='conversations.targets').length,2)
 assert.deepEqual(m.items().map(n=>n.textContent).slice(0,3),['不指定工作区','Alpha','Beta'])
})

test('Escape closes the menu and returns focus to the chip', async () => {
 const m=mount();m.menu.receive({type:'executor.state'})
 m.chip().listeners.click();await flush()
 const panel=all(m.menu.element).find(n=>n.attrs.role==='menu')
 panel.listeners.keydown({key:'Escape',preventDefault(){}})
 assert.equal(m.menu.open,false);assert.equal(document.activeElement,m.chip())
})

test('a re-render keeps keyboard focus on the same item and never disables items while a change is pending', async () => {
 const m=mount();m.menu.receive({type:'executor.state'})
 m.chip().listeners.click();await flush()
 const before=m.byText('Beta');before.focus()
 before.listeners.click()
 assert.ok(m.items().every(n=>!n.disabled),'pending must not disable focusable items')
 await flush()
 const after=m.byText('Beta')
 assert.notEqual(after,before,'the menu was rebuilt')
 assert.equal(document.activeElement,after,'focus followed the item across the rebuild')
})

test('a session picked while the workspace change is still pending is applied afterwards, not dropped', async () => {
 let release;const gate=new Promise(resolve=>{release=resolve})
 const m=mount({gate});m.menu.receive({type:'executor.state'})
 m.chip().listeners.click();await flush()
 m.byText('Alpha').listeners.click();await flush()
 m.byText('Fix audio').listeners.click();await flush()
 assert.equal(m.menu.open,false,'the pick still closes the menu')
 assert.equal(m.commands.filter(([method])=>method==='conversations.target').length,1,'only one change in flight')
 release();await flush();await flush()
 assert.deepEqual(m.commands.at(-1),['conversations.target',{id:'a',target:{workspace_id:'ws-1',session_id:'s-1'}}])
})

test('returning to the current workspace while another selection is pending keeps the last choice', async () => {
 let release;const gate=new Promise(resolve=>{release=resolve})
 const m=mount({gate});m.menu.receive({type:'executor.state'})
 m.c.snapshot.conversations.items[0].coding_target=catalog[0]
 m.menu.update();m.chip().listeners.click();await flush()
 m.byText('Beta').listeners.click()
 m.byText('Alpha').listeners.click()
 assert.equal(m.commands.filter(([method])=>method==='conversations.target').length,1,'only one change in flight')
 release();await flush();await flush()
 assert.deepEqual(m.commands.filter(([method])=>method==='conversations.target'),[
  ['conversations.target',{id:'a',target:{workspace_id:'ws-2',session_id:null}}],
  ['conversations.target',{id:'a',target:{workspace_id:'ws-1',session_id:null}}],
 ])
})

test('label and levels project the current target even before the catalog loads', () => {
 const target={workspace_id:'w',session_id:'s',project:'P',title:'Session',directory:'/d'}
 assert.equal(targetLabel(target),'P / Session')
 assert.equal(targetLabel({...target,session_id:null}),'P / 新会话')
 assert.equal(targetLabel(null),'选择工作区')
 assert.deepEqual(targetLevels(null,target).map(w=>[w.workspace_id,w.sessions.length]),[['w',1]])
})


test('worktree sessions appear under the saved project and select their own workspace',async()=>{
 const targets=[catalog[0],{workspace_id:'tree',session_id:'branch',title:'Branch',project:'Worktree',directory:'/tree',group_workspace_id:'ws-1',group_project:'Alpha',group_directory:'/one'}]
 const levels=targetLevels(targets,null);assert.equal(levels.length,1);assert.equal(levels[0].sessions[0].workspace_id,'tree')
 const m=mount({targets});m.menu.receive({type:'executor.state'});await m.chip().listeners.click();await flush()
 m.byText('Alpha').listeners.click();await flush();m.byText('Branch').listeners.click();await flush()
 assert.deepEqual(m.commands.at(-1),['conversations.target',{id:'a',target:{workspace_id:'tree',session_id:'branch'}}])
})

test('a loaded project catalog does not resurrect a previously selected scratch workspace',()=>{
 const stale={workspace_id:'scratch',session_id:null,project:'Old scratch',title:''}
 assert.deepEqual(targetLevels(catalog,stale).map(level=>level.workspace_id),['ws-1','ws-2'])
})

test('clicking the highlighted project of a worktree session browses it instead of retargeting',async()=>{
 const targets=[catalog[0],{workspace_id:'tree',session_id:'branch',title:'Branch',project:'Worktree',directory:'/tree',group_workspace_id:'ws-1',group_project:'Alpha',group_directory:'/one'}]
 const m=mount({targets});m.menu.receive({type:'executor.state'})
 m.c.snapshot.conversations.items[0].coding_target={workspace_id:'tree',session_id:'branch',project:'Worktree',title:'Branch'}
 m.menu.update();await m.chip().listeners.click();await flush()
 m.byText('Alpha').listeners.click();await flush()
 assert.equal(m.commands.some(([method])=>method==='conversations.target'),false)
 assert.ok(m.byText('Branch'))
})
