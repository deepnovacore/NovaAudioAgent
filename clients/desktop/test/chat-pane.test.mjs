import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {mountPersonalView} from '../src/renderer/personal-view.mjs'
class Node{
 constructor(tag,text){this.tag=tag;this.tagName=tag.toUpperCase();this.text=text;this.children=[];this.listeners={};this.dataset=new Proxy({},{set:(object,key,value)=>{object[key]=String(value);return true}});this.classList={add:()=>{}};this.attrs={};this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100}
 append(...c){for(const n of c)n.parentElement=this;this.children.push(...c)}prepend(...c){for(const n of c)n.parentElement=this;this.children.unshift(...c)}replaceChildren(...c){this.children=[];this.append(...c)}setAttribute(k,v){this[k]=v;this.attrs[k]=v}getAttribute(k){return this.attrs[k]}addEventListener(n,f){this.listeners[n]=f}
 querySelectorAll(sel){const tags=sel.split(',');return this.children.flatMap(n=>[...(tags.includes(n.tag)?[n]:[]),...n.querySelectorAll(sel)])}querySelector(sel){return this.querySelectorAll(sel)[0]}focus(){this.focused=(this.focused??0)+1;document.activeElement=this}contains(node){return this===node||this.children.some(child=>child.contains?.(node))}
 dispatchEvent(event){this.listeners[event.type]?.(event);if(event.bubbles)this.parentElement?.dispatchEvent(event)}
 get childElementCount(){return this.children.length}
}
const controllers=[]
afterEach(async()=>{for(const c of controllers.splice(0))c.disconnect();await new Promise(resolve=>setImmediate(resolve))})
function mount(options={}){
 const body=new Node('body'),shell=new Node('div');body.append(shell);const sent=[],callbacks={}
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,visibilityState:'visible',hasFocus:()=>true,createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),createTextNode:text=>new Node('#text',text),querySelector:()=>shell}
 const view=mountPersonalView({send:frame=>(sent.push(frame),true),start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction(){},results:()=>[],api:{orbMenu:{},personal:{setUnread(){},openArticle:async()=>{},onPresentationRequest:fn=>{callbacks.presentation=fn},onCollapsed:fn=>{callbacks.collapsed=fn}}},...options})
 controllers.push(view.controller);view.controller.connect();view.receive({type:'client.ready',input_instance_id:'i',capabilities:['text_input']})
 const all=n=>[n,...n.children.flatMap(all)]
 return {body,sent,view,callbacks,all:()=>all(body),receipts:()=>sent.filter(f=>f.type==='personal.command'&&f.method==='feed.action'&&f.params.action==='presented').map(f=>f.params.id)}
}
const feedState=(revision,selected='chat:proactive',extra={})=>({type:'personal.state',revision,memory:{entries:[]},feed:[{id:'f1',kind:'suggestion',title:'T',why_now:'W',lifecycle:'active',user_state:'new',task_ref:null,delivery:{presented_at:null},prepared:{text:'## 前瞻\n- 一条',trust:'untrusted_external',evidence_refs:[]}}],conversations:{selected_id:selected,voice_id:null,unread_count:1,items:[{id:'chat:proactive',kind:'proactive',title:'主动提醒',unread_count:1},{id:'c',kind:'chat',title:'C'}],messages:[{id:'feed:f1',conversation_id:'chat:proactive',role:'assistant',text:'T\n## 前瞻\n- 一条'}]},...extra})
test('duplicate historical conversation labels distinguish dates and ties while selecting unchanged IDs',async()=>{
 const m=mount(),items=[
  {id:'a',kind:'chat',title:'新对话',created_at:'2025-01-01T12:00:00Z'},
  {id:'b',kind:'chat',title:'新对话',created_at:'2025-02-01T12:00:00Z'},
  {id:'c',kind:'chat',title:'新对话',created_at:'2025-02-01T12:00:00Z'},
  {id:'d',kind:'chat',title:'Custom {1}',created_at:'2025-02-01T12:00:00Z'},
  {id:'e',kind:'chat',title:'Custom {1}',created_at:'2025-03-01T12:00:00Z'},
  {id:'f',kind:'chat',title:'Unique {1}',created_at:'2025-03-01T12:00:00Z'},
 ],original=structuredClone(items)
 try{
  m.view.receive(feedState(1,'a',{feed:[],conversations:{selected_id:'a',voice_id:'b',items,messages:[]}}))
  const buttons=m.all().filter(n=>n.className==='conversation-item')
  assert.equal(new Set(buttons.slice(0,3).map(n=>n.textContent)).size,3)
  assert.match(buttons[0].textContent,/2025/);assert.notEqual(buttons[0].textContent,buttons[1].textContent)
  assert.ok(buttons[1].attrs['aria-label'].startsWith(buttons[1].textContent))
  assert.ok(buttons[3].textContent.startsWith('Custom {1} · '));assert.ok(buttons[4].textContent.startsWith('Custom {1} · '))
  assert.notEqual(buttons[3].textContent,buttons[4].textContent);assert.equal(buttons[5].textContent,'Unique {1}')
  assert.equal(m.all().find(n=>n.className==='switcher-title').textContent,'新对话')
  for(const [i,b]of buttons.entries()){
   b.listeners.click();const request=m.sent.at(-1)
   assert.equal(request.method,'conversations.select');assert.deepEqual(request.params,{id:items[i].id})
   m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick()
  }
  assert.deepEqual(items,original)
 }finally{m.view.controller.disconnect();await tick()}
})
test('new conversation and target menu controls explicitly translate dynamic UI without translating custom titles',async()=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs');setLanguage('en')
 const m=mount()
 try{
  m.view.receive(feedState(1,'c',{feed:[]}))
  m.view.receive({type:'executor.state',state:'idle'})
  assert.ok(m.all().some(n=>n.attrs['aria-label']==='Execution place'))
  for(const label of ['Choose workspace','New conversation'])assert.ok(m.all().some(n=>n.textContent===label),label)
  assert.equal(m.all().find(n=>n.className==='switcher-title').textContent,'C')
 }finally{m.view.controller.disconnect();await tick();setLanguage('zh-CN')}
})
test('dropdown and sidebar orb entry wait for the same host acknowledgement and preserve conversation drafts',async()=>{
 for(const route of ['dropdown','sidebar']){
  const applied=[],m=mount({applyPresentation:async mode=>{applied.push(mode)}}),c=m.view.controller
  try{
   let request=m.sent.findLast(f=>f.method==='presentation.set');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'workbench'}});await tick()
   m.view.receive(feedState(1,'c',{feed:[]}));c.draft='kept draft'
   if(route==='dropdown'){const select=m.all().find(n=>n.attrs['aria-label']==='显示模式');select.value='orb';select.listeners.change()}
   else m.all().find(n=>n.title==='收起 · 收起为悬浮球').listeners.click()
   request=m.sent.at(-1);assert.equal(request.method,'presentation.set');assert.equal(request.params.mode,'orb');assert.deepEqual(applied,['workbench'])
   m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'orb'}});await tick()
   assert.deepEqual(applied,['workbench','orb']);assert.equal(c.presentationMode,'orb');assert.equal(c.collapsed,true);assert.equal(c.selectedId,'c');assert.equal(c.draft,'kept draft')
  }finally{c.disconnect();await tick()}
 }
})
const enterOrb=async m=>{
 let request=m.sent.findLast(f=>f.method==='presentation.set');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'workbench'}});await tick()
 m.view.receive(feedState(1,'c',{feed:[]}))
 m.all().find(n=>n.title==='收起 · 收起为悬浮球').listeners.click()
 request=m.sent.findLast(f=>f.method==='presentation.set');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'orb'}});await tick()
}
const ackVoice=async(m,revision)=>{
 const request=m.sent.findLast(f=>f.method==='conversations.voice');const state=feedState(revision,'c',{feed:[]});state.conversations.voice_id=request.params.enabled?request.params.id:null
 m.view.receive(state);m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick();await tick()
}
test('an orb opens its voice conversation without waking a sleeping orb, and reopens one the host ends',async()=>{
 const starts=[],m=mount({applyPresentation:async()=>{},start:async options=>{starts.push(options)}}),c=m.view.controller
 try{
  await enterOrb(m);await ackVoice(m,2)
  assert.deepEqual(starts,[{wake:false}]);assert.equal(c.mode,'voice')
  assert.equal(m.sent.filter(f=>f.method==='conversations.voice').length,1)
  // The host ends the session (a purge, another device): the orb must not stay deaf.
  m.view.receive(feedState(3,'c',{feed:[]}));await tick();await ackVoice(m,4)
  assert.equal(c.mode,'voice');assert.deepEqual(starts,[{wake:false},{wake:false}])
  assert.equal(m.sent.filter(f=>f.method==='conversations.voice').length,2)
 }finally{c.disconnect();await tick()}
})
test('a refused microphone reports once on the orb instead of retrying',async()=>{
 let attempts=0
 const m=mount({applyPresentation:async()=>{},start:async()=>{attempts++;throw new Error('麦克风权限不可用，原有草稿已保留')}}),c=m.view.controller
 try{
  await enterOrb(m);await ackVoice(m,2);await ackVoice(m,3)
  for(let revision=4;revision<7;revision++){m.view.receive(feedState(revision,'c',{feed:[]}));await tick()}
  assert.equal(attempts,1);assert.equal(c.mode,'text');assert.match(c.error,/麦克风权限不可用/)
 }finally{c.disconnect();await tick()}
})
test('feed messages render as cards with the prepared body as markdown, and receipts follow visibility',()=>{
 const m=mount();m.view.controller.collapse(true);m.view.receive(feedState(1))
 const card=m.all().find(n=>n.className==='feed-card');assert.ok(card);assert.ok(m.all().some(n=>n.tag==='h2'&&n.text===undefined&&n.children.some(c=>c.text==='前瞻')),'prepared markdown heading rendered')
 assert.deepEqual(m.receipts(),[],'collapsed workbench sends no receipt')
 m.view.controller.collapse(false);assert.deepEqual(m.receipts(),['f1'],'expanding delivers the receipt without a transcript change')
 m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:false,error:'offline'})
})
test('collapsed chat pane defers receipts until it reopens, and failed receipts retry on the next update',async()=>{
 const m=mount();const toggle=m.all().find(n=>n.className==='chat-toggle');await toggle.listeners.click()
 m.view.receive(feedState(1));assert.deepEqual(m.receipts(),[])
 await toggle.listeners.click();assert.deepEqual(m.receipts(),['f1'])
 const request=m.sent.findLast(f=>f.method==='feed.action');m.view.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'offline'});await new Promise(r=>setImmediate(r))
 m.view.refresh();assert.deepEqual(m.receipts(),['f1','f1'],'a failed receipt is retried by a plain update')
})
test('durable cards browse a persistent central detail through snapshots, executor frames, and focusout',async()=>{
 const m=mount(),task={id:'t1',goal:'Task one',conversation_id:'c',phase:'running',controller:{kind:'nova'},control_revision:0,goal_revision:0,session_ids:['s1'],events:{items:[]},capabilities:{input:true},viewer:{client_id:'a',can_takeover:true}}
 m.view.receive(feedState(1,'c',{feed:[],tasks:[task,{...task,id:'t2',goal:'Task two'}],conversations:{selected_id:'c',items:[{id:'c',title:'C'}],messages:[]}}))
 const cards=m.all().filter(n=>n.className==='task-card');assert.equal(cards.length,2)
 assert.equal(cards[0].textContent,'Task one · 进行中 · Nova 在推进')
 m.view.receive(feedState(2,'c',{feed:[],tasks:[{...task,phase:'waiting',waiting_reason:'correction_limit',acceptance:['Tests pass','Docs updated']},{...task,id:'t2',goal:'Task two'}],conversations:{selected_id:'c',items:[{id:'c',title:'C'}],messages:[]}}))
 assert.equal(cards[0].textContent,'Task one · 等待处理 · 需要你：自动修正次数已用完，请决定是否继续 · 验收 2 条');assert.match(cards[0].title,/• Tests pass\n• Docs updated/)
 cards[0].focus();const opening=cards[0].listeners.click(),req=m.sent.findLast(f=>f.method==='tasks.get');m.view.receive({type:'personal.result',request_id:req.request_id,ok:true,data:task});await opening
 assert.equal(document.activeElement.textContent,'返回任务卡片');document.activeElement.dispatchEvent({type:'keydown',key:'Escape',bubbles:true,preventDefault(){}});assert.equal(document.activeElement,cards[0]);const reopened=cards[0].listeners.click(),again=m.sent.findLast(f=>f.method==='tasks.get');m.view.receive({type:'personal.result',request_id:again.request_id,ok:true,data:task});await reopened
 const draft=m.all().find(n=>n['aria-label']==='回复执行器'),panel=m.all().find(n=>n.className==='workbench-page');draft.value='keep';draft.focus();panel.scrollTop=88
 assert.equal(m.sent.some(f=>f.method==='tasks.control'),false)
 m.view.receive({type:'executor.tasks',tasks:[]});assert.ok(m.all().includes(draft));assert.equal(panel.scrollTop,88)
 m.view.receive({...m.view.controller.snapshot,revision:2,tasks:[{...task,phase:'waiting'}]});const refresh=m.sent.findLast(f=>f.method==='tasks.get');m.view.receive({type:'personal.result',request_id:refresh.request_id,ok:true,data:{...task,phase:'waiting'}});await new Promise(r=>setImmediate(r));assert.ok(m.all().includes(draft))
 const nova=m.all().find(n=>n['aria-label']==='消息草稿');nova.focus();panel.listeners.focusout();await new Promise(r=>setTimeout(r,1));assert.ok(m.all().includes(draft));assert.equal(draft.value,'keep')
 nova.value='Ask Nova';nova.listeners.input();await nova.listeners.keydown({key:'Enter',preventDefault(){}});assert.ok(m.sent.some(f=>f.type==='input.text'&&f.text==='Ask Nova'));assert.equal(m.sent.some(f=>f.method==='tasks.input'),false)
 m.all().find(n=>n.className==='task-detail').listeners.keydown({key:'Escape',preventDefault(){}});assert.equal(document.activeElement,cards[0]);assert.equal(m.sent.some(f=>f.method==='tasks.control'),false)
})
test('suggestion body is an accessible control and remains expanded after a snapshot refresh',()=>{
 const m=mount();const context={cards:[{id:'s1',tab:'todos',title:'Review',body:'A long recommendation '.repeat(30),refs:[]}],status:'ready'}
 m.view.receive(feedState(1,'c',{workbench_context:context,sources:[{id:'local'}]}))
 const body=()=>m.all().find(n=>n.className==='card-body')
 assert.equal(body().tag,'button')
 assert.equal(body().attrs['aria-expanded'],'false')
 body().listeners.click()
 assert.equal(body().attrs['aria-expanded'],'true')
 body().focus()
 m.view.receive(feedState(2,'c',{workbench_context:context,sources:[{id:'local'}]}))
 assert.equal(body().attrs['aria-expanded'],'true')
 assert.equal(document.activeElement,body())
})
test('a personal todo with a long note can expand its four-line body',()=>{
 const m=mount();m.view.receive(feedState(1,'c',{sources:[{id:'local'}],life:{todos:[{id:'todo1',title:'Prepare',note:'Detailed note '.repeat(30),status:'open',version:1}],ideas:[],goals:[]}}))
 const note=m.all().find(n=>n.className==='card-body'&&n.dataset.cardBodyId==='life:todo:todo1')
 assert.equal(note?.tag,'button')
 note.listeners.click()
 assert.equal(note.attrs['aria-expanded'],'true')
})
test('a cold start before any connection shows a neutral connecting state, not the disconnect banner',()=>{
 const body=new Node('body'),shell=new Node('div');body.append(shell)
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,visibilityState:'visible',hasFocus:()=>true,createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),createTextNode:text=>new Node('#text',text),querySelector:()=>shell}
 const v=mountPersonalView({send:()=>true,start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction(){},results:()=>[],api:{orbMenu:{},personal:{setUnread(){},openArticle:async()=>{}}}})
 const all=()=>[body].flatMap(function walk(n){return [n,...n.children.flatMap(walk)]})
 const hint=all().find(n=>n.className==='hint composer-hint'),status=all().find(n=>n.className==='workbench-status')
 assert.equal(hint.textContent,'正在连接…');assert.equal(status.textContent,'正在连接');assert.equal(status.dataset.state,'connecting')
 v.controller.connect()
 v.controller.disconnect()
 assert.equal(hint.textContent,'连接已断开，草稿已保留');assert.equal(status.textContent,'已断开 · 草稿保留');assert.equal(status.dataset.state,'disconnected')
})
test('hidden or unfocused windows defer presented receipts until visible and focused',()=>{
 const m=mount();document.visibilityState='hidden';m.view.receive(feedState(1));assert.deepEqual(m.receipts(),[])
 document.visibilityState='visible';document.hasFocus=()=>false;m.view.refresh();assert.deepEqual(m.receipts(),[])
 document.hasFocus=()=>true;m.view.refresh();assert.deepEqual(m.receipts(),['f1'])
})

test('task approval header stays in workbench and remains actionable while presentation sync is pending',async()=>{
 const m=mount(),task={id:'t',conversation_id:'c',goal:'Task',phase:'running',controller:{kind:'nova'},session_ids:[],approvals:[],viewer:{client_id:'a'},capabilities:{input:false}}
 m.view.receive(feedState(1,'c',{feed:[],tasks:[task],pending_approvals:[{task_id:'t',conversation_id:'c',approval_id:'original',summary:'Run'}],conversations:{selected_id:'c',items:[{id:'c',title:'C'}],messages:[]}}));m.view.controller.presentationPending=true;m.view.controller.presentationReady=false;m.view.refresh()
 const header=m.all().find(n=>n.textContent==='处理审批：Run');assert.equal(header.disabled,false);const opening=header.listeners.click(),request=m.sent.findLast(f=>f.method==='tasks.get');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:task});await opening
 assert.equal(m.sent.some(f=>f.method==='presentation.set'||f.method==='conversations.select'),false);assert.ok(m.all().some(n=>n.className==='task-detail'))
})

test('orb task deep link enters workbench before reading detail and never takes control',async()=>{
 const m=mount();m.view.controller.presentationMode='orb';const opening=m.view.openTask('exact-task'),mode=m.sent.at(-1)
 assert.equal(mode.method,'presentation.set');assert.equal(mode.params.mode,'workbench');assert.equal(m.sent.some(f=>f.method==='tasks.get'),false)
 m.view.receive({type:'personal.result',request_id:mode.request_id,ok:true,data:{mode:'workbench',returned_task_ids:[]}});await new Promise(r=>setImmediate(r))
 const read=m.sent.at(-1);assert.equal(read.method,'tasks.get');assert.equal(read.params.task_id,'exact-task');assert.equal(read.params.after,0)
 m.view.receive({type:'personal.result',request_id:read.request_id,ok:true,data:{id:'exact-task',goal:'Result',phase:'completed',controller:{kind:'nova'},events:{items:[],next:8}}});await opening
 assert.equal(m.sent.some(f=>f.method==='tasks.control'),false)
})


test('main presentation request enters host path while collapsed display ACK sends no command',async()=>{
 const m=mount(),change=m.callbacks.presentation('orb'),request=m.sent.at(-1)
 assert.equal(request.method,'presentation.set');assert.equal(request.params.mode,'orb');const count=m.sent.length;m.callbacks.collapsed(true);assert.equal(m.sent.length,count)
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'orb',returned_task_ids:['t'],task_control_revisions:{t:2}}});await change
 assert.equal(m.view.controller.taskNotice,'已交还 Nova，未发送的草稿已保留')
})

test('late detail response after background exit neither steals focus nor advances the viewed cursor',async()=>{
 const m=mount(),origin=new Node('button');origin.focus();const opening=m.view.openTask('late'),read=m.sent.at(-1)
 m.view.controller.presentationMode='background';m.view.receive({type:'personal.result',request_id:read.request_id,ok:true,data:{id:'late',goal:'Late result',phase:'completed',controller:{kind:'nova'},events:{items:[{seq:9,text:'Unseen'}],next:9}}});await opening;assert.equal(document.activeElement,origin)
 m.view.controller.presentationMode='workbench';const again=m.view.openTask('late'),request=m.sent.at(-1);assert.equal(request.params.after,9)
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{id:'late',goal:'Late result',phase:'completed',controller:{kind:'nova'},events:{items:[],next:9}}});await again
})


test('empty durable task aggregate does not expose a phantom null deep link',()=>{const m=mount();m.view.refresh();const button=m.all().find(n=>n.className==='personal-orb-task');assert.equal(button.hidden,true);assert.equal(button.dataset.taskId,'')})

test('closing and reopening detail retains earlier public history alongside the viewed cursor',async()=>{
 const m=mount(),task={id:'history',goal:'History',phase:'running',controller:{kind:'nova'},events:{items:[{seq:9,text:'Earlier public event'}],next:9}}
 const opening=m.view.openTask('history');m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:true,data:task});await opening
 m.all().find(n=>n.textContent==='返回任务卡片').listeners.click()
 const reopened=m.view.openTask('history');m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:true,data:{...task,events:{items:[{seq:12,text:'Later public event'}],next:12}}});await reopened
 assert.ok(m.all().some(n=>n.textContent==='Earlier public event'));assert.ok(m.all().some(n=>n.textContent==='Later public event'));assert.ok(m.all().some(n=>n.textContent==='自上次查看后有 1 条新活动'))
})

test('completion arriving in a visible inspector is already viewed in the orb aggregate',async()=>{
 const m=mount(),task={id:'visible',goal:'Visible',phase:'running',controller:{kind:'nova'},events:{items:[],next:0}}
 const opening=m.view.openTask(task.id);m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:true,data:task});await opening
 m.view.receive(feedState(1,'c',{tasks:[{...task,phase:'completed'}]}));m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:true,data:{...task,phase:'completed'}});await new Promise(r=>setImmediate(r));m.view.refresh()
 assert.match(m.all().find(n=>n.className==='personal-orb-task').textContent,/0 新结果/)
})


const tick=()=>new Promise(resolve=>setImmediate(resolve))
const taskRow=(id,phase='working')=>({work_id:id,title:'任务 '+id,phase,project:'Project',executor:'codex',summary:'执行中'})
const selectPage=(m,label)=>m.all().find(n=>n.className==='rail-item'&&n.children.some(c=>c.className==='rail-label'&&c.textContent===label)).listeners.click()
const taskCard=(m,id)=>m.all().find(n=>n.tag==='article'&&n.children.some(c=>c.tag==='h3'&&c.textContent==='任务 '+id))
const descendants=n=>[n,...n.children.flatMap(descendants)]
const clickProgress=(m,id)=>descendants(taskCard(m,id)).find(n=>n.tag==='button'&&n.textContent==='询问任务进展').listeners.click()
const textOf=n=>descendants(n).map(n=>n.textContent??'').join(' ')
const resultFor=(id,summary)=>({delegateId:id,executor:'codex',outcome:'ok',summary,startedAt:10,endedAt:20,changedFiles:2})

test('task progress fills only the original draft, preserves voice and pending state, and never sends',async()=>{
 const m=mount({tasks:()=>({connected:true,tasks:[taskRow('a','completed')]})}),c=m.view.controller
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));c.state('chat:proactive').draft='原有内容';c.state('c').draft='别的草稿'
  const pending={request_id:'kept',text:'sending'};c.state('chat:proactive').submission=pending
  selectPage(m,'任务');m.all().find(n=>n.className==='chat-toggle').listeners.click()
  clickProgress(m,'a');const request=m.sent.findLast(f=>f.method==='conversations.open_work')
  assert.ok(request);assert.deepEqual(request.params,{work_id:'a'})
  const owner=feedState(2,'chat:proactive',{feed:[]});owner.conversations.voice_id='chat:proactive';m.view.receive(owner)
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  const filled=c.state('chat:proactive').draft
  assert.equal(filled,'原有内容\n请告诉我「任务 a」（任务 a）的最新进展。')
  assert.equal(c.state('c').draft,'别的草稿');assert.equal(c.state('chat:proactive').submission,pending)
  assert.equal(c.voiceId,'chat:proactive');assert.equal(m.all().find(n=>n.id==='chat-pane').hidden,false)
  assert.equal(m.all().find(n=>n.attrs['aria-label']==='消息草稿').disabled,true)
  clickProgress(m,'a');const repeated=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:repeated.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('chat:proactive').draft,filled,'repeat click must not duplicate the trailing prompt')
  assert.equal(m.sent.some(f=>f.type==='input.text'||['conversations.create','conversations.open_feed'].includes(f.method)),false)
 }finally{c.disconnect();await tick()}
})

test('task progress races and failures remain scoped to the owning draft and originating card',async()=>{
 const m=mount({tasks:()=>({connected:true,tasks:[taskRow('a'),taskRow('b','failed')]})}),c=m.view.controller
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务');c.state('c').draft='Other draft'
  clickProgress(m,'a');let request=m.sent.findLast(f=>f.method==='conversations.open_work');assert.ok(request)
  const owner=feedState(2,'chat:proactive',{feed:[]});m.view.receive(owner)
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations})
  m.view.receive(feedState(3,'c',{feed:[]}));await tick()
  assert.equal(c.selectedId,'c');assert.equal(c.state('c').draft,'Other draft');assert.match(c.state('chat:proactive').draft,/任务 a/u)
  for(const response of [{ok:false,error:'conversation_not_found'},{ok:false,error:'network failed'},{ok:true},{ok:true,data:{selected_id:''}},{ok:true,data:{selected_id:'missing'}},{ok:true,data:{selected_id:'chat:proactive',items:{}}},{ok:true,data:{selected_id:'chat:proactive',items:[null]}}]){
   const before=c.state('chat:proactive').draft
   clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
   m.view.receive({type:'personal.result',request_id:request.request_id,...response});await tick()
   const errors=descendants(taskCard(m,'a')).filter(n=>n.attrs.role==='alert')
   assert.equal(errors.length,1);assert.ok(errors[0].textContent)
   assert.equal(descendants(taskCard(m,'b')).some(n=>n.attrs.role==='alert'),false)
   assert.equal(c.state('chat:proactive').draft,before);assert.equal(c.state('c').draft,'Other draft')
  }
  c.state('chat:proactive').draft='x'.repeat(4000)
  clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('chat:proactive').draft,'x'.repeat(4000));assert.match(textOf(taskCard(m,'a')),/4000/u)
  const prompt='请告诉我「任务 a」（任务 a）的最新进展。'
  c.state('chat:proactive').draft='x'.repeat(4000-prompt.length-1)
  clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('chat:proactive').draft.length,4000);assert.ok(c.state('chat:proactive').draft.endsWith(prompt))
  c.state('chat:proactive').draft='😀'.repeat(2000)
  clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('chat:proactive').draft,'😀'.repeat(2000));assert.match(textOf(taskCard(m,'a')),/4000/u)
  assert.equal(c.drafts.has(undefined),false);assert.equal(c.drafts.has('missing'),false)
 }finally{c.disconnect();await tick()}
})

test('native task details isolate results, preserve expansion across refresh/reset, and display row errors',async()=>{
 let state={connected:true,selected:{work_id:'b'},error:'B error',tasks:[taskRow('a'),{...taskRow('b','failed'),error:'B error',opening:true},taskRow('c','completed'),taskRow('d','cancelled')]}
 let results=[resultFor('a','A result'),resultFor('d','D result')]
 const actions=[],m=mount({tasks:()=>state,results:()=>results,taskAction:(...args)=>actions.push(args)}),c=m.view.controller
 const details=id=>descendants(taskCard(m,id)).find(n=>n.tag==='details')
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务')
  assert.equal(m.all().filter(n=>n.tag==='details'&&n.dataset.workId).length,4)
  assert.match(textOf(details('b')),/暂无结果/u);assert.doesNotMatch(textOf(details('b')),/A result|D result/u)
  assert.match(textOf(details('a')),/A result/u);assert.doesNotMatch(textOf(details('a')),/D result/u)
  assert.equal(descendants(taskCard(m,'a')).some(n=>n.attrs.role==='alert'),false)
  assert.equal(m.all().filter(n=>n.attrs.role==='alert'&&n.textContent==='B error').length,1)
  assert.equal(descendants(taskCard(m,'b')).find(n=>n.textContent==='正在打开…').disabled,true)
  details('b').open=true // refresh before the browser delivers the queued toggle event
  results=[...results,{...resultFor('b','B result'),outcome:'failed',diagnostic:{method:'turn/start',server_code:500,message:'<b>literal</b>'}}]
  m.view.refresh();assert.equal(details('b').open,true);assert.match(textOf(details('b')),/B result/u)
  assert.match(textOf(details('b')),/<b>literal<\/b>/u);assert.equal(descendants(details('b')).some(n=>n.tag==='b'),false)
  assert.match(textOf(details('b')),/2/u);assert.match(textOf(details('b')),/耗时：10\.0 秒/u)
  selectPage(m,'Todos');selectPage(m,'任务');assert.equal(details('b').open,true)
  results=[];m.view.refresh();assert.equal(details('b').open,true);assert.match(textOf(details('b')),/暂无结果/u)
  assert.doesNotMatch(textOf(details('b')),/B result/u)
  details('a').open=true;details('a').listeners.toggle()
  state={connected:true,tasks:[taskRow('b','failed')]};m.view.refresh()
  state={connected:true,tasks:[taskRow('a'),taskRow('b','failed')]};m.view.refresh()
  assert.equal(details('a').open,false,'an evicted work loses its local expansion')
  state={...state,connected:false};m.view.refresh()
  assert.equal(descendants(taskCard(m,'a')).filter(n=>n.tag==='button').every(n=>n.disabled),true)
  assert.deepEqual(actions,[])
 }finally{c.disconnect();await tick()}
})


test('result and reset wire handlers refresh expanded task details after retaining validated results',async()=>{
 const {readFile}=await import('node:fs/promises'),{createContext,runInContext}=await import('node:vm')
 const wire=await import('../src/renderer/wire-frame-types.mjs'),{parseLastResultFrame}=await import('../src/renderer/bubbles.mjs')
 const results=new Map(),m=mount({tasks:()=>({connected:true,tasks:[taskRow('a'),taskRow('b')]}),results:()=>[...results.values()]})
 const source=await readFile(new URL('../src/renderer/index.mjs',import.meta.url),'utf8')
 const context=createContext({...wire,personalView:m.view,retainedResults:results,parseLastResultFrame,updateResultButton(){},render(){}})
 runInContext(source.slice(source.indexOf('async function handleControl(message)'),source.indexOf('async function handleSocketMessage')),context)
 const details=id=>descendants(taskCard(m,id)).find(n=>n.tag==='details')
 const frame=id=>({type:'executor.result',work_id:id,result:{delegate_id:id,executor:'codex',outcome:'ok',summary:id+' finished',started_at:1,ended_at:2,changed_files:1}})
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务');details('a').open=true
  await context.handleControl(frame('a'))
  assert.equal(details('a').open,true);assert.match(textOf(details('a')),/a finished/u);assert.match(textOf(details('b')),/暂无结果/u)
  await context.handleControl({...frame('b'),result:frame('a').result})
  assert.match(textOf(details('b')),/暂无结果/u,'cross-work payload must not be retained')
  await context.handleControl(frame('b'));await context.handleControl({type:'executor.result',work_id:'a',result:null})
  assert.match(textOf(details('a')),/暂无结果/u);assert.equal(details('a').open,true);assert.match(textOf(details('b')),/b finished/u)
  await context.handleControl({type:'executor.results.reset',extra:true});assert.match(textOf(details('b')),/b finished/u)
  await context.handleControl({type:'executor.results.reset'});assert.match(textOf(details('b')),/暂无结果/u);assert.equal(details('a').open,true)
 }finally{m.view.controller.disconnect();await tick()}
})

test('new task result text and progress drafts use English UI translations without translating task identity',async()=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs');setLanguage('en')
 const results=[],m=mount({tasks:()=>({connected:true,tasks:[taskRow('a')]}),results:()=>results}),c=m.view.controller
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务')
  assert.match(textOf(taskCard(m,'a')),/No result yet/u)
  clickProgress(m,'a');assert.match(textOf(taskCard(m,'a')),/Opening conversation/u)
  let request=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'conversation_not_found'});await tick()
  assert.match(textOf(taskCard(m,'a')),/original task conversation no longer exists/u)
  clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
  const owner=feedState(2,'chat:proactive',{feed:[]});m.view.receive(owner)
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.draft,'Please update me on “任务 a” (task a).')
  results.push(resultFor('a','User summary 中文'));m.view.refresh()
  assert.match(textOf(taskCard(m,'a')),/Changed files: 2/u);assert.match(textOf(taskCard(m,'a')),/Duration: 10\.0 seconds/u)
  assert.match(textOf(taskCard(m,'a')),/User summary 中文/u)
  for(const [outcome,label] of [['failed','Failed'],['refused','Rejected'],['cancelled','Stopped'],['unknown','Awaiting confirmation']]){
   results[0]={...resultFor('a','User summary 中文'),outcome,changedFiles:null};m.view.refresh()
   const detail=descendants(taskCard(m,'a')).find(n=>n.tag==='details')
   assert.ok(descendants(detail).some(n=>n.textContent===label));assert.match(textOf(detail),/Changed files: Unknown/u)
  }
 }finally{c.disconnect();await tick();setLanguage('zh-CN')}
})


test('refresh restores keyboard focus to the same task result summary instead of the first identical label',async()=>{
 let results=[],state={connected:true,tasks:[taskRow('a'),taskRow('b')]}
 const m=mount({tasks:()=>state,results:()=>results}),summary=id=>descendants(taskCard(m,id)).find(n=>n.tag==='summary')
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务')
  summary('b').focus();descendants(taskCard(m,'b')).find(n=>n.tag==='details').open=true
  results=[resultFor('b','B finished')];m.view.refresh()
  assert.equal(document.activeElement,summary('b'),'result arrival preserves the focused work ID')
  assert.notEqual(document.activeElement,summary('a'))
  assert.equal(descendants(taskCard(m,'b')).find(n=>n.tag==='details').open,true)
  state={...state,tasks:[taskRow('a'),taskRow('b','completed')]};m.view.refresh()
  assert.equal(document.activeElement,summary('b'),'progress refresh preserves the focused work ID')
 }finally{m.view.controller.disconnect();await tick()}
})


test('task progress accepts the command owner snapshot before a later state broadcast',async()=>{
 const m=mount({tasks:()=>({connected:true,tasks:[taskRow('a')]})}),c=m.view.controller
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));c.draft='Keep current draft';selectPage(m,'任务')
  clickProgress(m,'a');const request=m.sent.findLast(f=>f.method==='conversations.open_work')
  const owner=feedState(2,'late-owner',{feed:[]});owner.conversations.items.push({id:'late-owner',kind:'chat',title:'Original owner'})
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('late-owner').draft,'请告诉我「任务 a」（任务 a）的最新进展。')
  assert.equal(c.selectedId,'c');assert.equal(c.draft,'Keep current draft')
  m.view.receive(owner);assert.equal(c.draft,'请告诉我「任务 a」（任务 a）的最新进展。')
  assert.equal(m.sent.some(f=>f.type==='input.text'||['conversations.select','conversations.create'].includes(f.method)),false)
 }finally{c.disconnect();await tick()}
})
test('startup progress reads as loading; only a failed start shows an error with settings',()=>{
 const m=mount(),notice=m.all().find(n=>n.id==='startup-notice'),settings=notice.children[1]
 m.view.startup({stage:'backend'})
 assert.equal(notice.className,'page-notice');assert.equal(notice.attrs.role,'status');assert.equal(notice.hidden,false);assert.equal(settings.hidden,true)
 m.view.startup({stage:'failed',code:'workspace_not_found'})
 assert.equal(notice.className,'page-error');assert.equal(notice.attrs.role,'alert');assert.equal(settings.hidden,false)
 m.view.startup({stage:'ready'})
 assert.equal(notice.hidden,true);assert.equal(settings.hidden,true)
})
test('a failed first start stops claiming to connect, and retry restores loading',()=>{
 const m=mount();m.view.controller.everConnected=false;m.view.controller.disconnect()
 const text=()=>m.all().map(n=>n.textContent).join('\n')
 m.view.startup({stage:'backend'})
 assert.match(text(),/正在连接后台/u)
 m.view.startup({stage:'failed',code:'workspace_not_found'})
 assert.doesNotMatch(text(),/正在连接后台/u);assert.match(text(),/暂时连不上后台/u)
 assert.equal(m.all().find(n=>n.className==='workbench-status').textContent,'启动失败')
 assert.equal(m.all().find(n=>n.className==='workbench-status').dataset.state,'disconnected')
 m.view.startup({stage:'backend'})
 assert.match(text(),/正在连接后台/u);assert.doesNotMatch(text(),/暂时连不上后台/u)
 assert.equal(m.all().find(n=>n.className==='workbench-status').dataset.state,'connecting')
})
test('the mic starts dictation on one click and finishes it on the next',async()=>{
 let stops=0
 const m=mount({stop:async()=>{stops++}})
 try{
  m.view.receive({type:'client.ready',input_instance_id:'i',capabilities:['text_input','dictation']})
  m.view.receive(feedState(1,'c',{feed:[]}))
  const mic=m.all().find(n=>n.className==='composer-dictate')
  assert.equal(mic.attrs['aria-pressed'],'false')
  await mic.listeners.click();await tick()
  const start=m.sent.find(f=>f.type==='input.dictation'&&f.action==='start')
  assert.ok(start);assert.equal(mic.attrs['aria-label'],'停止录音');assert.equal(mic.attrs['aria-pressed'],'true')
  await mic.listeners.click();await tick()
  assert.ok(m.sent.some(f=>f.type==='input.dictation'&&f.action==='finish'&&f.id===start.id))
  assert.equal(m.sent.filter(f=>f.type==='input.dictation'&&f.action==='start').length,1)
 }finally{m.view.controller.disconnect();await tick()}
})
test('the round composer action is voice until there is a draft, then send; voice shows a stop cross while running',async()=>{
 const m=mount()
 try{
  m.view.receive(feedState(1,'c',{feed:[]}))
  const byClass=name=>m.all().find(n=>n.className===name)
  const voice=byClass('composer-voice'),submit=byClass('composer-submit'),draft=m.all().find(n=>n.attrs['aria-label']==='消息草稿')
  assert.equal(voice.hidden,false);assert.equal(submit.hidden,true)
  assert.equal(voice.attrs['aria-label'],'持续对话');assert.equal(voice.attrs['aria-pressed'],'false')
  draft.value='hello';draft.listeners.input()
  assert.equal(voice.hidden,true);assert.equal(submit.hidden,false)
  draft.value='   ';draft.listeners.input()
  assert.equal(voice.hidden,false);assert.equal(submit.hidden,true)
  assert.equal(byClass('composer-dictate').attrs['aria-label'],'语音输入')
  assert.ok(voice.children[0].tag==='svg'&&submit.children[0].tag==='svg'&&byClass('composer-dictate').children[0].tag==='svg')
  m.view.receive(feedState(2,'c',{feed:[],conversations:{selected_id:'c',voice_id:'c',items:[{id:'c',kind:'chat',title:'C'}],messages:[]}}))
  assert.equal(voice.attrs['aria-label'],'结束语音');assert.equal(voice.attrs['aria-pressed'],'true')
 }finally{m.view.controller.disconnect();await tick()}
})
test('continuous voice shows the orb stage with its status line and removes it when voice ends',async()=>{
 const m=mount()
 try{
  m.view.receive(feedState(1,'c',{feed:[]}))
  const stage=m.all().find(n=>n.className==='voice-stage'),label=m.all().find(n=>n.className==='voice-stage-label')
  assert.equal(stage.hidden,true)
  m.view.setOrb({name:'listening',statusLine:'正在听'});m.view.setOrb({name:'not-a-state',statusLine:'x'});m.view.setOrbLevel(0.5)
  m.view.receive(feedState(2,'c',{feed:[],conversations:{selected_id:'c',voice_id:'c',items:[{id:'c',kind:'chat',title:'C'}],messages:[]}}))
  assert.equal(stage.hidden,false)
  m.view.setOrb({name:'speaking',statusLine:'正在说'});m.view.setOrbLevel(0.2)
  assert.equal(label.textContent,'正在说')
  m.view.receive(feedState(3,'c',{feed:[]}))
  assert.equal(stage.hidden,true)
 }finally{m.view.controller.disconnect();await tick()}
})
test('pending suggestion actions survive refresh, reject double clicks and recover after failure',async()=>{
 const m=mount(),context={cards:[{id:'s1',tab:'todos',title:'Review',body:'Details',next:'Start',refs:[]}],status:'ready'}
 const state=revision=>feedState(revision,'c',{workbench_context:context,sources:[{id:'local',health:String(revision)}],conversations:{selected_id:'c',voice_id:'c',items:[{id:'c',title:'C'}],messages:[]}})
 m.view.receive(state(1))
 const action=()=>m.all().find(n=>n.textContent==='帮我做')
 const first=action();first.listeners.click();const request=m.sent.at(-1)
 assert.equal(request.method,'conversations.create');assert.equal(first.attrs['aria-busy'],'true');assert.equal(first.disabled,true)
 first.listeners.click();m.view.receive(state(2));assert.notEqual(action(),first)
 assert.equal(action().disabled,true);action().listeners.click()
 assert.equal(m.sent.filter(f=>f.method==='conversations.create').length,1)
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'操作超时，请刷新状态后重试'});await tick()
 assert.equal(action().disabled,false);assert.equal(action().attrs['aria-busy'],'false')
 assert.match(m.view.controller.error,/超时/)
})
test('life status shows saving, survives refresh and does not restore an obsolete focused value',async()=>{
 const m=mount(),row={id:'todo1',title:'Prepare',note:'',status:'open',version:1}
 const state=(revision,item)=>feedState(revision,'c',{life:{todos:[item],ideas:[],goals:[]}})
 m.view.receive(state(1,row));const select=()=>m.all().find(n=>n.attrs['aria-label']==='Prepare状态')
 select().focus();select().value='doing';select().listeners.change();const request=m.sent.at(-1)
 assert.equal(request.method,'life.mutate');assert.equal(select().attrs['aria-busy'],'true')
 assert.equal(m.all().find(n=>n.textContent==='正在保存…').hidden,false)
 m.view.receive(state(2,{...row,note:'Updated elsewhere'}));assert.equal(select().disabled,true);select().listeners.change()
 assert.equal(m.sent.filter(f=>f.method==='life.mutate').length,1)
 m.view.receive(state(3,{...row,status:'doing',version:2}));m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick()
 assert.equal(select().disabled,false);assert.equal(select().value,'doing')
 select().focus();m.view.receive(state(4,{...row,status:'waiting',version:3}));assert.equal(select().value,'waiting')
})
test('goal adoption and status changes use the shared pending guard; conflicts refresh with readable feedback',async()=>{
 const m=mount(),goal={id:'g1',kind:'goal',title:'Goal',note:'',status:'active',version:1,progress:{total:0,done:0}}
 const state=revision=>feedState(revision,'c',{life:{todos:[],ideas:[],goals:[goal]},workbench_context:{cards:[{id:'s1',tab:'goals',title:'Suggested goal',body:'Details',refs:[]}]}})
 m.view.receive(state(1));m.all().find(n=>n.title==='Goals · 目标').listeners.click()
 const adopt=()=>m.all().find(n=>n.textContent==='设为目标')
 adopt().listeners.click();const request=m.sent.at(-1);assert.equal(request.method,'context.adopt');assert.equal(adopt().disabled,true)
 const state2=state(2);state2.life.goals=[{...goal,note:'changed'}];m.view.receive(state2)
 adopt().listeners.click();assert.equal(m.sent.filter(f=>f.method==='context.adopt').length,1)
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick();assert.equal(adopt().disabled,false)
 const select=()=>m.all().find(n=>n.attrs['aria-label']==='Goal状态');select().value='paused';select().listeners.change()
 const mutation=m.sent.at(-1);assert.equal(select().disabled,true)
 m.view.receive({type:'personal.result',request_id:mutation.request_id,ok:false,error:'version_conflict'});await tick()
 assert.match(m.view.controller.error,/核对最新状态/);const refresh=m.sent.at(-1);assert.equal(refresh.method,'state')
 m.view.receive({type:'personal.result',request_id:refresh.request_id,ok:true,data:{}});await tick()
 assert.equal(select().disabled,false);assert.equal(select().value,'active')
})
