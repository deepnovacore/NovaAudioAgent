import test from 'node:test'
import assert from 'node:assert/strict'
import {PersonalController} from '../src/renderer/personal-controller.mjs'
function harness(){const sent=[],applied=[];const c=new PersonalController({send:f=>{sent.push(f);return true},start:async()=>{},stop:async()=>{},applyPresentation:async m=>applied.push(m)});const ack=(data={},ok=true)=>{const f=sent.at(-1);c.receive({type:'personal.result',request_id:f.request_id,ok,error:ok?undefined:'handback_pending',data:{mode:f.params.mode,...data}})};return {c,sent,applied,ack}}
for(const mode of ['orb','background'])test(`${mode} handback notice requires receipt and preserves exact retry across reconnect`,async()=>{
 const h=harness(),ready=h.c.connect();h.ack();await ready;h.c.draft='Nova draft'
 h.c.receive({type:'personal.state',revision:1,tasks:[{id:'a',controller:{kind:'user',client_id:'me'}}]})
 const exit=h.c.setPresentation(mode);const first=h.sent.at(-1);assert.match(h.c.taskNotice,/待确认/);h.ack({},false);await assert.rejects(exit,/handback_pending/);assert.match(h.c.taskNotice,/待确认/)
 h.c.disconnect();const reconnect=h.c.connect();assert.deepEqual(h.sent.at(-1),first)
 h.ack({returned_task_ids:['a','b'],task_control_revisions:{a:2,b:5}});await reconnect
 assert.match(h.c.taskNotice,/已交还 Nova/);assert.equal(h.c.draft,'Nova draft')
 const open=h.c.setPresentation('workbench');h.ack({returned_task_ids:[],task_control_revisions:{}});await open;assert.equal(h.c.taskNotice,'','returning to the workbench clears the handback notice')
 assert.equal(h.sent.some(f=>['tasks.control','tasks.input','conversations.approve','tasks.cancel'].includes(f.method)),false)
})
test('display collapse acknowledgment and conversation selection never request handback',async()=>{const h=harness(),ready=h.c.connect();h.ack();await ready;h.sent.length=0;h.c.collapse(true);h.c.collapse(false);const select=h.c.select('b');h.ack();await select;assert.deepEqual(h.sent.map(f=>f.method),['conversations.select'])})

test('orb summary prioritizes decisions, then unseen results, then active work',async()=>{
 const {summarizeTasks}=await import('../src/renderer/task-banner.mjs')
 const tasks=[{id:'run',phase:'running'},{id:'done',phase:'completed'},{id:'wait',phase:'waiting',waiting_reason:'user_decision'}]
 assert.deepEqual(summarizeTasks(tasks,[]),{active:2,decisions:1,results:1,task_id:'wait'})
 assert.equal(summarizeTasks(tasks.slice(0,2),[]).task_id,'done')
 assert.equal(summarizeTasks(tasks.slice(0,2),['done']).task_id,'run')
})

test('failed orb handback cannot be confirmed by a later presentation snapshot',async()=>{const h=harness(),ready=h.c.connect();h.ack();await ready;h.c.receive({type:'personal.state',revision:1,tasks:[{id:'a',controller:{kind:'user',client_id:'me'}}]});const exit=h.c.setPresentation('orb');h.ack({},false);await assert.rejects(exit);h.c.receive({type:'personal.state',revision:2,presentation_mode:'orb'});assert.equal(h.c.presentationReady,false);assert.equal(h.c.presentationMode,'workbench');assert.match(h.c.taskNotice,/待确认/)})

test('failed exit is reconciled before a later workbench request using its original identity',async()=>{
 const h=harness(),ready=h.c.connect();h.ack();await ready;const exit=h.c.setPresentation('orb'),original=h.sent.at(-1);h.ack({},false);await assert.rejects(exit)
 const opening=h.c.setPresentation('workbench');assert.deepEqual(h.sent.at(-1),original);h.ack({returned_task_ids:['a'],task_control_revisions:{a:2}});await new Promise(r=>setImmediate(r));assert.equal(h.sent.at(-1).params.mode,'workbench');h.ack();await opening
 assert.equal(h.c.presentationRequests.size,0);assert.match(h.c.taskNotice,/已交还/)
})

test('background remains immediate when an earlier orb handback failed',async()=>{
 const h=harness(),ready=h.c.connect();h.ack();await ready;const orb=h.c.setPresentation('orb');h.ack({},false);await assert.rejects(orb)
 const background=h.c.setPresentation('background');assert.equal(h.c.presentationMode,'background');assert.equal(h.sent.at(-1).params.mode,'background');h.ack({returned_task_ids:[],task_control_revisions:{}});await background
})

test('repeated in-flight background intent shares one command and settles both callers',async()=>{
 const h=harness(),ready=h.c.connect();h.ack();await ready
 const first=h.c.setPresentation('background'),second=h.c.setPresentation('background');const requests=h.sent.filter(f=>f.params.mode==='background')
 h.ack({returned_task_ids:[],task_control_revisions:{}});await second
 assert.equal(requests.length,1);await first;assert.equal(h.c.pending.size,0)
})
test('leaving the workbench with no taken-over task shows no handback notice',async()=>{
 const h=harness(),ready=h.c.connect();h.ack();await ready;h.c.receive({type:'personal.state',revision:1,tasks:[{id:'a',controller:{kind:'nova'}}]})
 const exit=h.c.setPresentation('orb');assert.equal(h.c.taskNotice,'');h.ack({returned_task_ids:[],task_control_revisions:{}});await exit;assert.equal(h.c.taskNotice,'')
})
