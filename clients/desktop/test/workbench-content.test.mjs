import test from 'node:test'
import assert from 'node:assert/strict'
import {renderLife} from '../src/renderer/life-view.mjs'
import {renderNews} from '../src/renderer/news-view.mjs'
import {renderSourceSuggestions} from '../src/renderer/workbench-suggestions.mjs'
import {mountPersonalView} from '../src/renderer/personal-view.mjs'

class Node{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.dataset={};this.className=''}append(...nodes){this.children.push(...nodes)}setAttribute(k,v){this[k]=v}addEventListener(){}}
const all=node=>[node,...node.children.flatMap(all)]
function harness(t){const previous=globalThis.document;t.after(()=>{globalThis.document=previous});globalThis.document={createElement:tag=>new Node(tag)};const panel=new Node('main');const button=(label,action,parent)=>{const node=new Node('button');node.textContent=label;node.action=action;parent.append(node);return node};return {panel,button,command:async()=>{},local:{},rerender(){},delegate(){}}}
const text=panel=>all(panel).map(node=>node.textContent).filter(Boolean).join('\n')

test('populated saved Todos have no saved-empty copy beside suggestions',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'todos',context:{status:'ready',candidate_count:1,cards:[{id:'c',tab:'todos',title:'Compare flows',body:'The note lists a next step.',refs:[]}]},sources:[{state:'connected'}],button:h.button,command:h.command,continueChat:()=>{}})
 renderLife(h.panel,{...h,kind:'todo',state:{todos:[{id:'t',kind:'todo',title:'Call supplier',note:'',status:'open',version:1}],ideas:[],goals:[]}})
 const output=text(h.panel)
 assert.match(output,/Call supplier/u);assert.match(output,/Compare flows/u)
 assert.doesNotMatch(output,/还没有待办/u)
})
test('an empty saved list beside suggestions says whose list it is instead of claiming nothing is there',t=>{
 for(const [kind,tab] of [['todo','todos'],['idea','ideas'],['goal','goals']]){
  const h=harness(t)
  renderLife(h.panel,{...h,kind,state:{todos:[],ideas:[],goals:[]},suggested:1})
  assert.doesNotMatch(text(h.panel),/还没有(待办|保存想法|设定目标)/u,tab)
  assert.match(text(h.panel),/不会自动加进来/u)
  const bare=harness(t);renderLife(bare.panel,{...bare,kind,state:{todos:[],ideas:[],goals:[]}})
  assert.match(text(bare.panel),/还没有(待办|保存想法|设定目标)/u,'without suggestions the empty state stays')
 }
})
test('the Todo top shows a recap and action cards that hand a prepared request to Nova',t=>{
 const h=harness(t),drafts=[],chats=[]
 const context={status:'ready',candidate_count:2,recap:{text:'最近主要在做语音 Agent 的工作台。',projects:[{name:'nova',line:'正在修工作台内容'}]},cards:[
  {id:'a',tab:'todos',title:'完成摘要层',body:'已接入项目摘要。',why:'下一步已经写明',next:'跑一次原生验收',refs:[{entry_id:'source:x',label:'notes.md'}]},
  {id:'b',tab:'todos',title:'Old card',body:'Only a body.',why:null,next:null,refs:[]},
 ]}
 renderSourceSuggestions(h.panel,{tab:'todos',context,sources:[{state:'connected'}],button:h.button,command:h.command,continueChat:x=>chats.push(x),delegate:x=>drafts.push(x)})
 const nodes=all(h.panel),output=text(h.panel)
 const recap=nodes.find(node=>node.className==='workbench-recap'),section=nodes.find(node=>node.className==='workbench-suggestions')
 assert.ok(recap&&nodes.indexOf(recap)<nodes.indexOf(section),'recap sits above the cards')
 assert.equal(section.children.filter(node=>node.tag==='article').length,2,'the recap is not counted as a card')
 assert.match(output,/最近主要在做语音 Agent 的工作台/u);assert.match(output,/可以接着做/u)
 const project=nodes.find(node=>node['aria-label']==='nova · 正在修工作台内容');assert.deepEqual(project.children.map(node=>[node.tag,node.textContent]),[['strong','nova'],['span','正在修工作台内容']])
 assert.match(output,/下一步已经写明/u);assert.match(output,/下一步：跑一次原生验收/u);assert.match(output,/Only a body/u)
 assert.doesNotMatch(output,/需要你自行判断/u)
 const [first,second]=section.children.filter(node=>node.tag==='article')
 const row=card=>card.children.find(node=>node.className==='card-actions')
 const firstButtons=row(first).children;assert.deepEqual(firstButtons.map(node=>node.textContent),['帮我做','隐藏'],'actions share one row')
 assert.equal(firstButtons[1].className,'quiet')
 firstButtons[0].action();assert.deepEqual(drafts,['请帮我推进「完成摘要层」：跑一次原生验收']);assert.deepEqual(chats,[])
 assert.equal(row(second).children[0].textContent,'聊聊这个')
 const popover=first.children.find(node=>node.className==='source-popover');assert.equal(popover.hidden,true);assert.match(text(popover),/notes\.md/u)
 assert.equal(first.dataset.sources,'true');assert.ok(!first.children.some(node=>node.tag==='details'))
 assert.ok(!second.children.some(node=>node.className==='source-info'),'no sources, no icon')
})
test('while project digests are pending the Todo top says so instead of claiming nothing is there',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'todos',context:{status:'ready',candidate_count:0,cards:[],empty_reason:'digests_pending',recap:{text:null,projects:[]}},sources:[{state:'connected'}],button:h.button,command:h.command,continueChat:()=>{}})
 assert.match(text(h.panel),/还在看你最近的项目/u)
 assert.ok(!all(h.panel).some(node=>node.className==='workbench-recap'),'an empty recap is not rendered')
})
test('empty Life and source states use specific copy without inventing work',t=>{
 const h=harness(t)
 renderLife(h.panel,{...h,kind:'goal',state:{todos:[],ideas:[],goals:[]}})
 assert.match(text(h.panel),/还没有设定目标/u)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:{status:'ready',candidate_count:0,cards:[],empty_reason:'no_eligible_sources'},sources:[{state:'connected',scan_pending:true}],button:h.button,command:h.command,continueChat:()=>{}})
 assert.match(text(h.panel),/还在读你给我的资料/u)
 assert.doesNotMatch(text(h.panel),/值得关注|持续推进/u)
})
test('unloaded Life data and paused sources never claim an empty list or active scan',t=>{
 const h=harness(t)
 renderLife(h.panel,{...h,kind:'todo',state:undefined})
 assert.match(text(h.panel),/正在读取已保存的内容/u)
 assert.doesNotMatch(text(h.panel),/还没有待办/u)
 renderSourceSuggestions(h.panel,{tab:'todos',context:{status:'idle',candidate_count:0,cards:[]},sources:[{state:'paused',scan_pending:true}],button:h.button,command:h.command,continueChat:()=>{}})
 assert.match(text(h.panel),/资料来源已暂停/u)
 assert.doesNotMatch(text(h.panel),/还在读你给我的资料/u)
})
test('disconnected source state does not claim that no sources are connected',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:null,sources:[],button:h.button,command:h.command,continueChat:()=>{},connected:false,everConnected:true})
 assert.match(text(h.panel),/暂时连不上后台/u)
 assert.doesNotMatch(text(h.panel),/还没给我看过资料/u)
})
test('first connection reads as loading, not an outage, and offers no dead source button',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'todos',context:null,sources:[],button:h.button,command:h.command,continueChat:()=>{},openSettings:()=>{},connected:false,everConnected:false})
 assert.match(text(h.panel),/正在连接后台/u)
 assert.doesNotMatch(text(h.panel),/暂时连不上后台|连接资料/u)
})
test('first connection copy is translated in English',async t=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs');setLanguage('en');t.after(()=>setLanguage('zh-CN'))
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'todos',sources:[],button:h.button,command:h.command,connected:false,everConnected:false})
 assert.match(text(h.panel),/Connecting to the backend/u)
 assert.match(text(h.panel),/I'll look through your sources once connected\./u)
})
test('a partial source failure remains visible beside available suggestions',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:{status:'ready',cards:[{id:'card',tab:'ideas',title:'Simplify setup',body:'The note suggests a shorter setup.',refs:[]}]},sources:[{scope:'computer',state:'error'}],button:h.button,command:h.command,continueChat:()=>{},openSettings:()=>{}})
 assert.match(text(h.panel),/Simplify setup/u)
 assert.match(text(h.panel),/整机资料还没读完/u)
 assert.match(text(h.panel),/查看来源/u)
})
test('disabled news has an honest empty state',t=>{
 const h=harness(t)
 renderNews(h.panel,{...h,news:{enabled:false,items:[],saved:[],sources:[],interests:[],profile_version:0}})
 assert.match(text(h.panel),/资讯更新已关闭/u)
 assert.doesNotMatch(text(h.panel),/资讯精选|好内容正在路上/u)
})
test('scan progress preserves a focused Todo draft and material content refresh restores it',t=>{
 const previous=globalThis.document,oldWindow=globalThis.window
 t.after(()=>{globalThis.document=previous;globalThis.window=oldWindow})
 class DomNode extends Node{
  constructor(tag){super(tag);this.listeners={};this.scrollTop=0;this.attrs={};this.classList={add(){}}}
  prepend(...nodes){this.children.unshift(...nodes)}replaceChildren(...nodes){this.children=nodes}
  addEventListener(name,fn){this.listeners[name]=fn}
  querySelectorAll(selector){const tags=selector.split(',');return this.children.flatMap(node=>[...(tags.includes(node.tag)?[node]:[]),...node.querySelectorAll(selector)])}
  querySelector(selector){return this.querySelectorAll(selector)[0]}
  contains(node){return this.children.some(child=>child===node||child.contains(node))}
  getAttribute(name){return this.attrs[name]}
  setAttribute(name,value){this.attrs[name]=value}
  focus(){document.activeElement=this}
  get childElementCount(){return this.children.length}
 }
 const body=new DomNode('body'),shell=new DomNode('div');body.append(shell)
 globalThis.window={addEventListener(){}}
 globalThis.document={body,activeElement:null,visibilityState:'hidden',hasFocus:()=>false,addEventListener(){},createElement:tag=>new DomNode(tag),createElementNS:(_,tag)=>new DomNode(tag),createTextNode:()=>new DomNode('text'),querySelector:()=>shell}
 const view=mountPersonalView({send:()=>true,start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction(){},results:()=>[],openResults(){},api:{orbMenu:{},personal:{}}})
 view.controller.connect()
 const state=(revision,title,scanned)=>({type:'personal.state',revision,life:{todos:[{id:'t',kind:'todo',title,note:'',status:'open',version:title==='Updated'?2:1}],ideas:[],goals:[]},sources:[{state:'connected',scanned}],conversations:{items:[]},memory:{entries:[]}})
 view.receive(state(1,'Original',1))
 const panel=body.querySelector('.workbench-page')??all(body).find(node=>node.className==='workbench-page')
 const edit=panel.querySelectorAll('textarea')[0];edit.value='Unsaved words';edit.selectionStart=2;edit.selectionEnd=7;edit.focus();panel.scrollTop=73
 view.receive(state(2,'Original',2));assert.equal(panel.querySelectorAll('textarea')[0],edit);assert.equal(document.activeElement,edit);assert.equal(panel.scrollTop,73);assert.match(all(body).find(node=>node.className==='page-title').textContent,/Todos/u)
 view.receive(state(3,'Updated',2));assert.match(all(panel).map(node=>node.textContent).join(' '),/Updated/u)
 const restored=panel.querySelectorAll('textarea')[0];assert.equal(document.activeElement,restored);assert.equal(restored.value,'Unsaved words');assert.equal(restored.selectionStart,2);assert.equal(restored.selectionEnd,7);assert.equal(panel.scrollTop,73)
 const candidate=id=>({id,kind:'todo',text:`Candidate ${id}`,quote:'said'})
 const withCandidates=(revision,ids)=>({...state(revision,'Updated',2),understanding:{items:ids.map(candidate)}})
 view.receive(withCandidates(4,['a','b']))
 const editors=()=>panel.querySelectorAll('textarea').filter(node=>node.getAttribute('aria-label')==='候选内容')
 const b=editors()[1];b.value='Unsaved B';b.selectionStart=1;b.selectionEnd=5;b.scrollTop=12;b.focus();panel.scrollTop=81
 view.receive(withCandidates(5,['x','a','b']))
 assert.deepEqual(editors().map(node=>node.value),['Candidate x','Candidate a','Unsaved B'])
 assert.equal(document.activeElement,editors()[2]);assert.equal(editors()[2].selectionStart,1);assert.equal(editors()[2].selectionEnd,5);assert.equal(editors()[2].scrollTop,12);assert.equal(panel.scrollTop,81)
 view.receive(withCandidates(6,['b']))
 assert.equal(document.activeElement,editors()[0]);assert.equal(editors()[0].value,'Unsaved B');assert.equal(editors()[0].selectionStart,1);assert.equal(editors()[0].scrollTop,12);assert.equal(panel.scrollTop,81)
})
test('a goal suggestion becomes a goal only when the user sets it, and the page stays quiet without one',async t=>{
 const h=harness(t),calls=[]
 const command=(method,params)=>{calls.push([method,params]);return Promise.resolve()}
 renderSourceSuggestions(h.panel,{tab:'goals',context:{status:'ready',candidate_count:1,cards:[],empty_reasons:{goals:'model_abstained'}},sources:[{state:'connected'}],button:h.button,command,continueChat:()=>{}})
 assert.deepEqual(h.panel.children,[],'no empty suggestion block under the goal list')
 const context={status:'ready',candidate_count:2,cards:[
  {id:'g',tab:'goals',title:'让 Nova 成为每天在用的助手',body:'一周里大部分事情都交给它。',why:null,next:'先把待办页跑顺',refs:[{entry_id:'source:x',label:'README.md'}]},
  {id:'t',tab:'todos',title:'Not a goal',body:'x',refs:[]},
 ]}
 renderSourceSuggestions(h.panel,{tab:'goals',context,sources:[{state:'connected'}],button:h.button,command,continueChat:()=>{}})
 const output=text(h.panel),nodes=all(h.panel)
 assert.match(output,/可以定下的方向/u);assert.match(output,/先从：先把待办页跑顺/u);assert.doesNotMatch(output,/Not a goal/u)
 const actions=nodes.find(node=>node.className==='card-actions')
 assert.deepEqual(actions.children.map(node=>node.textContent),['设为目标','隐藏'])
 assert.equal(calls.length,0,'nothing is saved by rendering')
 let settle;const pending=new Promise(resolve=>{settle=resolve})
 h.panel.children.length=0;renderSourceSuggestions(h.panel,{tab:'goals',context,sources:[{state:'connected'}],button:h.button,command:(method,params)=>{calls.push([method,params]);return pending},continueChat:()=>{}})
 const adopt=all(h.panel).find(node=>node.className==='card-actions').children[0]
 const done=adopt.action()
 settle();await done // Pending feedback is exercised through mountPersonalView in chat-pane.test.mjs.
 assert.deepEqual(calls,[['context.adopt',{id:'g'}]],'adoption is one backend command keyed by the suggestion')
})

test('the frameless workbench draws its own edge in both light and dark themes',async()=>{
 const {readFile}=await import('node:fs/promises')
 const css=await readFile(new URL('../src/renderer/workbench.css',import.meta.url),'utf8')
 assert.match(css,/\.workbench\{[^}]*border:1px solid var\(--frame\);border-radius:var\(--radius-window\)/)
 assert.doesNotMatch(css,/\.workbench::after\{/)
 const light=css.slice(0,css.indexOf('@media(prefers-color-scheme:dark)')),dark=css.slice(css.indexOf('@media(prefers-color-scheme:dark)'),css.indexOf('body[data-personal-collapsed="false"]'))
 assert.match(light,/--frame:rgba\(20,24,31,/);assert.match(dark,/--frame:rgba\(255,255,255,/)
})
