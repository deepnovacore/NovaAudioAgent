import test from 'node:test'
import assert from 'node:assert/strict'
import {mountTaskDetail,taskDraftKey} from '../src/renderer/task-detail.mjs'
class Node {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.scrollTop=0}
 append(...nodes){this.children.push(...nodes)} replaceChildren(...nodes){this.children=nodes} setAttribute(k,v){this[k]=v} addEventListener(k,f){this.listeners[k]=f} removeEventListener(k){delete this.listeners[k]} focus(){document.activeElement=this}
}
const task=(overrides={})=>({id:'t',goal:'Fix login',phase:'running',control_revision:0,goal_revision:0,controller:{kind:'nova'},session_ids:['s1','s2'],events:{items:[]},artifact_refs:[],approvals:[],input_receipts:[],viewer:{client_id:'client',can_takeover:true},capabilities:{detail:'conversation',input:true},...overrides})
function mount(command=async()=>{}){globalThis.document={createElement:tag=>new Node(tag)};const root=new Node('div'),data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};const calls=[];const view=mountTaskDetail(root,{command:(...args)=>{calls.push(args);return command(...args)},storage,onClose:()=>{}});const all=()=>[root].flatMap(function walk(n){return [n,...n.children.flatMap(walk)]});return {root,view,calls,all,storage,find:label=>all().find(n=>n['aria-label']===label||n.textContent===label)}}
test('draft keys isolate trusted clients and exact task sessions',()=>{assert.notEqual(taskDraftKey('a','t','s1'),taskDraftKey('a','t','s2'));assert.notEqual(taskDraftKey('a','t','s1'),taskDraftKey('b','t','s1'))})
test('browsing is inert; receipt enables explicit executor composer, with stable draft and scroll',async()=>{
 let resolve;const m=mount(method=>method==='tasks.get'?Promise.resolve(task({controller:{kind:'user',client_id:'client'},control_revision:1})):new Promise(r=>{resolve=r}));m.view.update(task());assert.deepEqual(m.calls,[])
 const draft=m.find('回复执行器'),select=m.find('执行器会话');assert.equal(draft.disabled,true)
 const takeover=m.find('接管并回复').listeners.click();assert.equal(draft.disabled,true)
 resolve(task({controller:{kind:'user',client_id:'client'},control_revision:1}));await takeover;assert.equal(draft.disabled,false)
 draft.value='first';draft.listeners.input();m.root.scrollTop=57;m.view.update(task({controller:{kind:'user',client_id:'client'},control_revision:1,events:{items:[{seq:1,text:'<img onerror=alert(1)>',sender:'executor',kind:'message'}]}}));assert.equal(m.find('回复执行器'),draft);assert.equal(m.root.scrollTop,57);assert.equal(draft.value,'first');assert.ok(m.all().some(n=>n.textContent==='<img onerror=alert(1)>'))
 select.value='s2';select.listeners.change();assert.equal(draft.value,'');draft.value='second';draft.listeners.input();select.value='s1';select.listeners.change();assert.equal(draft.value,'first');assert.equal(m.calls.filter(([method])=>method!=='tasks.get').length,1)
})
test('unknown input retains exact draft and blocks retry; accepted receipt alone clears it',async()=>{
 let mode='unknown';const m=mount(async(method)=>{if(method==='tasks.input'){if(mode==='unknown')throw Error('task_input_unknown');return {status:'accepted'}}return task({controller:{kind:'user',client_id:'client'},control_revision:1})});m.view.update(task({controller:{kind:'user',client_id:'client'},control_revision:1}));const draft=m.find('回复执行器');draft.value='keep';draft.listeners.input();await m.find('发送给执行器').listeners.click();assert.equal(draft.value,'keep');assert.equal(m.find('发送给执行器').disabled,true)
})
test('unsupported detail preserves summary and disallows input; Escape closes without returning control',()=>{const m=mount();m.view.update(task({capabilities:{detail:'summary-only',input:false}}));assert.equal(m.find('回复执行器').disabled,true);assert.ok(m.all().some(n=>n.textContent?.includes('仅提供任务摘要')));m.root.listeners.keydown({key:'Escape',preventDefault(){}});assert.deepEqual(m.calls,[])})

test('only exact accepted input receipt clears pending draft, and stale errors retain text',async()=>{
 const owned=task({controller:{kind:'user',client_id:'client'},control_revision:1});let stale=false
 const m=mount(async method=>{if(method==='tasks.input')throw Object.assign(Error(stale?'stale_task':'task_input_unknown'),{input_status:stale?'failed':'unknown'});return owned});m.view.update(owned)
 const draft=m.find('回复执行器');draft.value='exact';draft.listeners.input();await m.find('发送给执行器').listeners.click();const request=m.calls.find(([method])=>method==='tasks.input')[2].request_id
 m.view.update({...owned,input_receipt:{request_id:'other',status:'accepted'}});assert.equal(draft.value,'exact');assert.equal(draft.disabled,true)
 m.view.update({...owned,input_receipt:{request_id:request,status:'accepted'}});assert.equal(draft.value,'');assert.equal(draft.disabled,false)
 stale=true;draft.value='retain stale';draft.listeners.input();await m.find('发送给执行器').listeners.click();assert.equal(draft.value,'retain stale');assert.equal(draft.disabled,false)
})

test('accepted adapter input followed by unclassified status persistence error retains exact pending request',async()=>{
 const owned=task({controller:{kind:'user',client_id:'client'},control_revision:1});let writes=0
 const m=mount(async method=>{if(method==='tasks.input'){writes++;throw Error('EIO: status rename failed')}return owned});m.view.update(owned)
 const draft=m.find('回复执行器');draft.value='sent once';draft.listeners.input();await m.find('发送给执行器').listeners.click()
 const request=m.calls.find(([method])=>method==='tasks.input')[2].request_id
 assert.equal(draft.disabled,true);assert.equal(JSON.parse(m.storage.getItem(taskDraftKey('client','t','s1'))).pending.request_id,request)
 await m.find('发送给执行器').listeners.click();assert.equal(writes,1);assert.ok(m.calls.some(([method,params])=>method==='tasks.get'&&params.input_request_id===request))
 m.view.update({...owned,input_receipt:{request_id:request,status:'accepted'}});assert.equal(draft.value,'')
})

test('single-panel task inspection uses the same breakpoint as the chat overlay drawer',async()=>{
 const {readFile}=await import('node:fs/promises'),css=await readFile(new URL('../src/renderer/workbench.css',import.meta.url),'utf8')
 const drawer=css.match(/@media\s*\(max-width:\s*(\d+)px\)\{(?:(?!@media)[\s\S])*?\.chat-pane\{position:absolute/)[1]
 const detail=css.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{\s*\.workbench\[data-task-detail/)[1]
 assert.equal(detail,drawer);assert.ok(Number(detail)>=959)
})

test('event refresh uses the exact received cursor and retains preceding public events',async()=>{
 const m=mount(async()=>task({events:{items:[{seq:9,text:'New result'}],next:9}}))
 m.view.update(task({events:{items:[{seq:7,text:'Viewed result'}],next:7}}));m.view.receive({type:'personal.state',tasks:[]});await new Promise(r=>setImmediate(r))
 assert.equal(m.calls.at(-1)[1].after,7)
 assert.ok(m.all().some(n=>n.textContent==='Viewed result'));assert.ok(m.all().some(n=>n.textContent==='New result'))
})

test('missing and truncated public history remains visibly incomplete after incremental refresh',()=>{
 const m=mount();m.view.update(task({events:{items:[],next:4,incomplete:true,truncated:true}}));assert.ok(m.all().some(n=>n.textContent==='部分公开活动缺失，请核对执行器与任务结果。'))
 m.view.update(task({events:{items:[],next:4,incomplete:false,truncated:false}}));assert.ok(m.all().some(n=>n.textContent==='部分公开活动缺失，请核对执行器与任务结果。'));assert.ok(m.all().some(n=>n.textContent?.includes('较早活动已截断')))
})

test('Nova-only detail uses a normal goal paragraph, criteria list and no empty executor controls',()=>{
 const m=mount(),goal='Long delegated goal '.repeat(30);m.view.update(task({goal,execution_route:'nova',session_ids:[],acceptance:['First criterion','Second criterion'],capabilities:{detail:'summary-only',input:false}}))
 assert.equal(m.all().find(n=>n.tagName==='H2').textContent,'任务详情');assert.ok(m.all().some(n=>n.tagName==='P'&&n.textContent===goal));assert.equal(m.all().filter(n=>n.tagName==='LI').length,2)
 assert.equal(m.find('执行器会话').hidden,true);assert.ok(m.find('回复执行器'));assert.ok(m.all().find(n=>n.children.includes(m.find('回复执行器'))).hidden);assert.ok(m.find('接管任务'))
})

test('verification status is readable while its exact public receipt and refs remain expandable',()=>{
 const m=mount(),raw=JSON.stringify({kind:'correct',instruction:'Add the missing regression',evidence_refs:['evidence:1']});m.view.update(task({phase:'waiting',waiting_reason:'task_check_unavailable',events:{items:[{seq:1,kind:'verification',text:raw,refs:['evidence:1']}],next:1}}))
 assert.ok(m.all().some(n=>n.textContent?.includes('暂时无法验证任务结果')));assert.ok(m.all().some(n=>n.textContent==='需要修正：Add the missing regression'))
 const receipt=m.all().find(n=>n.tagName==='DETAILS');assert.ok(receipt);assert.ok(receipt.children.some(n=>n.tagName==='PRE'&&n.textContent.includes(raw)&&n.textContent.includes('evidence:1')))
})

test('long task cards have a bounded scrolling area and cannot shrink the Nova composer',async()=>{
 const {readFile}=await import('node:fs/promises'),css=await readFile(new URL('../src/renderer/workbench.css',import.meta.url),'utf8')
 assert.match(css,/\.conversation-task-cards\s*\{[^}]*max-height:[^}]*overflow:\s*auto/);assert.match(css,/\.conversation-task-cards \.task-card\s*\{[^}]*-webkit-line-clamp:\s*2/);assert.match(css,/\.composer\s*\{[^}]*flex-shrink:\s*0/)
})

test('quiet completed task can load public activity beyond the first hundred events',async()=>{
 const initial=Array.from({length:100},(_,n)=>({seq:n+1,kind:'message',sender:'executor',text:`Public event ${n+1}`}))
 const m=mount(async(_method,params)=>{assert.equal(params.after,100);return task({phase:'completed',events:{items:[{seq:101,kind:'message',sender:'executor',text:'Final public event'}],next:101}})})
 m.view.update(task({phase:'completed',events:{items:initial,next:100}}));const more=m.find('加载更多活动');assert.equal(more.hidden,false);await more.listeners.click()
 assert.ok(m.all().some(n=>n.textContent==='Public event 1'));assert.ok(m.all().some(n=>n.textContent==='Final public event'));assert.equal(more.hidden,true)
})


test('real command-state-inspector feedback settles control actions and refreshes new activity with bounded reads',async()=>{
 const {DesktopRealtime}=await import('../../../runtime/dist/src/desktop/desktop-session.js')
 const {PersonalController}=await import('../src/renderer/personal-controller.mjs')
 const {WebSocket}=await import('ws'),{once}=await import('node:events')
 const token='0'.repeat(32),stop=new AbortController(),methods=[],frames=[]
 let revision=1,current=task({viewer:{client_id:'desktop:local',can_takeover:true}})
 const snapshot=()=>({type:'personal.state',revision,tasks:[current]})
 const realtime=new DesktopRealtime({token,stop,executor:{executor:'codex',display_name:'Codex'},
  service:{executorState:'idle',playbackDisconnected:async()=>true},personalSnapshot:snapshot,
  personalCommand:async command=>{
   methods.push(command.method)
   if(command.method==='tasks.control'){current={...current,controller:{kind:'user',client_id:'desktop:local'},control_revision:1};revision++}
   const data=command.method==='tasks.list'?[current]:{...current,events:{items:current.events.items.filter(event=>event.seq>(command.params.after??0)),next:current.events.next??0}}
   return {type:'personal.result',request_id:command.request_id,ok:true,data}
  }})
 const ready=await realtime.server.start(),socket=new WebSocket(`ws://127.0.0.1:${ready.port}/`)
 const controller=new PersonalController({send:frame=>{socket.send(JSON.stringify(frame));return true},stop:async()=>{}})
 const m=mount((...args)=>controller.command(...args))
 socket.on('message',raw=>{const frame=JSON.parse(raw.toString());frames.push(frame);controller.receive(frame);m.view.receive(frame)})
 const waitFor=async(predicate,label)=>{const deadline=Date.now()+1000;while(!predicate()){if(Date.now()>deadline)throw Error(label);await new Promise(resolve=>setTimeout(resolve,5))}}
 try{
  await once(socket,'open');await controller.connect();socket.send(JSON.stringify({type:'hello',token}))
  await waitFor(()=>frames.some(frame=>frame.type==='executor.tasks'),'bootstrap missing')
  m.view.update(current)
  let settled=false;const takeover=m.find('接管并回复').listeners.click().then(()=>{settled=true})
  await waitFor(()=>settled,'takeover stays busy in command/state refresh feedback');await takeover
  assert.equal(m.find('回复执行器').disabled,false);assert.equal(m.find('交还 Nova').disabled,false)
  assert.ok(methods.filter(method=>method==='tasks.get').length<=2,'takeover refresh must settle after bounded reads')
  const beforeStates=frames.filter(frame=>frame.type==='personal.state').length
  await controller.command('tasks.list')
  await controller.command('tasks.get',{task_id:'t'})
  await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal(frames.filter(frame=>frame.type==='personal.state').length,beforeStates,'task reads do not publish state changes')
  const beforeReads=methods.filter(method=>method==='tasks.get').length
  current={...current,events:{items:[{seq:1,kind:'message',sender:'executor',text:'Fresh executor activity'}],next:1}};revision++
  realtime.bridge.onPersonalFrame(snapshot())
  await waitFor(()=>m.all().some(node=>node.textContent==='Fresh executor activity'),'new public activity was not refreshed')
  await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal(methods.filter(method=>method==='tasks.get').length,beforeReads+1)
  assert.equal(stop.signal.aborted,false)
 }finally{
  m.view.dispose();controller.disconnect();socket.terminate();await realtime.server.close()
 }
})
test('while Nova holds control the user can stop, reconcile an unknown step and continue without taking over',async()=>{
 const m=mount(async(method,params)=>method==='tasks.get'?task({phase:'waiting',waiting_reason:'user_reconciled'}):task({phase:'waiting',waiting_reason:'user_reconciled',...params}))
 m.view.update(task({phase:'running'}));assert.equal(m.find('停止任务').disabled,false);assert.equal(m.find('已核对：已执行').hidden,true)
 m.view.update(task({phase:'waiting',waiting_reason:'task_effect_unknown',capabilities:{detail:'conversation',input:true,reconcile:true}}))
 const done=m.find('已核对：已执行'),notRun=m.find('已核对：未执行'),resume=m.find('继续任务')
 assert.equal(done.hidden,false);assert.equal(notRun.disabled,false);assert.equal(resume.disabled,true,'continue waits for the user to reconcile')
 await notRun.listeners.click();assert.deepEqual(m.calls.find(([method])=>method==='tasks.reconcile')[1],{task_id:'t',control_revision:0,goal_revision:0,resolution:'not_run'})
 assert.equal(m.find('已核对：已执行').hidden,true);assert.equal(resume.disabled,false)
 m.view.update(task({phase:'waiting',controller:{kind:'user',client_id:'other'},capabilities:{detail:'conversation',input:true,reconcile:true}}))
 assert.equal(m.find('停止任务').disabled,true);assert.equal(m.find('已核对：已执行').disabled,true)
})
test('a completed task whose Todo changed offers an explicit Todo completion',async()=>{
 const m=mount(async()=>task({phase:'completed',todo_sync:'synced'}))
 m.view.update(task({phase:'completed',todo_sync:'conflict',capabilities:{detail:'conversation',input:true,todo_conflict:true,todo:{title:'Ship',version:3,status:'open'}}}))
 const close=m.find('标记 Todo 完成');assert.equal(close.hidden,false);await close.listeners.click()
 assert.deepEqual(m.calls.find(([method])=>method==='tasks.complete_todo')[1],{task_id:'t',control_revision:0,goal_revision:0,todo_version:3});assert.equal(close.hidden,true)
})
test('task detail shows readable errors and positional session names instead of raw identifiers',async()=>{
 const m=mount(async method=>{if(method==='tasks.cancel')throw Error('stale_task');if(method==='tasks.continue')throw Error('weird_internal_code');return task()})
 m.view.update(task({session_ids:['thread-abc','thread-def'],artifact_refs:['/tmp/work/out/report.md']}))
 const labels=m.find('执行器会话').children.map(option=>option.textContent);assert.deepEqual(labels,['会话 1','会话 2']);assert.equal(m.find('执行器会话').children[0].title,'thread-abc')
 assert.ok(m.all().some(n=>n.textContent==='report.md'));assert.equal(m.all().some(n=>n.textContent==='/tmp/work/out/report.md'),false)
 await m.find('停止任务').listeners.click();assert.ok(m.all().some(n=>n.textContent==='任务已在别处更新，已刷新，请重试'))
 assert.equal(m.all().some(n=>n.textContent==='stale_task'),false)
})
test('verified criteria show which kind of evidence proved each one',()=>{
 const m=mount();m.view.update(task({phase:'completed',acceptance:['Bug fixed','Docs updated'],criteria_evidence:[{index:0,evidence_refs:['task-work:w1','task-work:w2']},{index:1,evidence_refs:['task-delivery:r']}]}))
 const items=m.all().filter(n=>n.tagName==='LI');assert.equal(items[0].children[0].textContent,' · 依据：执行结果');assert.equal(items[0].children[0].title,'task-work:w1\ntask-work:w2');assert.equal(items[1].children[0].textContent,' · 依据：Nova 交付')
})
test('a message delivered after handback and a user reconciliation read as plain activity',()=>{
 const m=mount();m.view.update(task({events:{items:[{seq:1,kind:'control',text:JSON.stringify({operation:'input_before_handback',control_revision:2})},{seq:2,kind:'control',text:JSON.stringify({operation:'reconcile',resolution:'done'})}],next:2}}))
 assert.ok(m.all().some(n=>n.textContent==='交还前已发送的消息已送达执行器'));assert.ok(m.all().some(n=>n.textContent==='已核对执行结果'))
})
test('sessions name their executor, the primary one is marked default and preselected',()=>{
 const m=mount();m.view.update(task({session_ids:['s1','s2'],primary_session_id:'s2',works:[{work_id:'w1',executor:'codex',session_id:'s1'},{work_id:'w2',executor:'midscene',session_id:'s2'}]}))
 const select=m.find('执行器会话');assert.deepEqual(select.children.map(option=>option.textContent),['Codex 会话 1','Midscene 会话 2（默认）']);assert.equal(select.value,'s2')
})
