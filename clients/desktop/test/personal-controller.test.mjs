import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PersonalController} from '../src/renderer/personal-controller.mjs'
function harness({start,autoVoice=true}={}){
 let starts=0,stops=0,revision=0;const sent=[];let c
 function snapshot(selected='a',voice=null){c.receive({type:'personal.state',revision:++revision,feed:[],memory:{entries:[]},conversations:{selected_id:selected,voice_id:voice,items:[{id:'a',kind:'chat',title:'A'},{id:'b',kind:'chat',title:'B'},{id:'proactive',kind:'proactive',title:'主动提醒'}],messages:[]}})}
 c=new PersonalController({send:frame=>{sent.push(frame);if(autoVoice&&frame.method==='conversations.voice')queueMicrotask(()=>{snapshot(c.selectedId,frame.params.enabled?frame.params.id:null);c.receive({type:'personal.result',request_id:frame.request_id,ok:true})});return true},start:async()=>{starts++;await start?.()},stop:async()=>{stops++}})
 c.connect();c.receive({type:'desktop.capabilities',input_instance_id:'host-A',capabilities:['text_input','dictation']});snapshot()
 return {c,sent,snapshot,get starts(){return starts},get stops(){return stops}}
}
test('opening and changing text conversations never starts capture; drafts stay scoped',()=>{
 const h=harness();h.c.draft='A draft';h.snapshot('b');assert.equal(h.c.draft,'');h.c.draft='B draft';h.snapshot('a');assert.equal(h.c.draft,'A draft');assert.equal(h.starts,0)
 const revision=h.c.snapshot.revision;h.c.receive({type:'personal.state',revision:revision-1,conversations:{selected_id:'stale'}});assert.equal(h.c.selectedId,'a')
})
test('two text conversations send concurrently and receipts affect only their own drafts',async()=>{
 const {c,sent,snapshot}=harness();c.draft='A request';await c.submit();const a=sent.at(-1);assert.equal(a.conversation_id,'a')
 snapshot('b');c.draft='B request';await c.submit();const b=sent.at(-1);assert.equal(b.conversation_id,'b');assert.notEqual(a.request_id,b.request_id)
 c.receive({type:'caption',conversation_id:'a',role:'user',text:'A request',final:true});assert.ok(c.state('a').submission)
 c.receive({type:'input.text_result',request_id:a.request_id,conversation_id:'a',ok:false,error:'A failed'});assert.equal(c.state('a').draft,'A request');assert.equal(c.state('b').draft,'');assert.equal(c.error,'')
 c.receive({type:'input.text_result',request_id:b.request_id,conversation_id:'a',ok:true});assert.ok(c.state('b').submission)
 c.receive({type:'input.text_result',request_id:b.request_id,conversation_id:'b',ok:true});assert.equal(c.state('b').submission,null)
})
test('text sent for a named conversation goes there; text that cannot be sent is kept in that draft',()=>{
 const h=harness();h.snapshot('b');h.c.draft='B draft'
 assert.equal(h.c.submitText('switch place','a'),true);assert.equal(h.sent.at(-1).conversation_id,'a');assert.equal(h.c.state('b').draft,'B draft')
 assert.equal(h.c.submitText('second','a'),false,'a pending submission blocks the next');assert.equal(h.c.state('a').draft,'second')
})
test('voice owner blocks own text and all dictation, other text does not stop or steal capture',async()=>{
 const h=harness();await h.c.voice();assert.equal(h.starts,1);assert.equal(h.c.voiceId,'a');h.c.draft='blocked';assert.equal(await h.c.submit(),false)
 h.snapshot('b','a');h.c.draft='parallel text';const stops=h.stops;assert.equal(await h.c.submit(),true);assert.equal(h.stops,stops);assert.equal(h.c.mode,'voice')
 await assert.rejects(h.c.dictate(),/结束持续对话/);await assert.rejects(h.c.voice(),/结束当前语音/);assert.equal(h.starts,1)
 h.c.collapse(true);h.c.collapse(false);assert.equal(h.stops,stops);assert.equal(h.c.voiceId,'a')
 await h.c.stopVoice();assert.equal(h.c.voiceId,null);assert.equal(h.c.mode,'text')
})
test('dictation result returns to original conversation and never sends text',async()=>{
 const {c,snapshot,sent}=harness();c.draft='A old';await c.dictate();const id=c.dictationId;await c.finish();snapshot('b');c.draft='B keep'
 c.receive({type:'input.transcription',id,conversation_id:'a',text:'A editable'});assert.equal(c.draft,'B keep');assert.equal(c.state('a').draft,'A old\nA editable');assert.equal(sent.some(frame=>frame.type==='input.text'),false)
})
test('release during permission wait cancels capture; recognition error preserves draft',async()=>{
 let resolveStart;const h=harness({start:()=>new Promise(resolve=>{resolveStart=resolve})});h.c.draft='keep';const pending=h.c.dictate();await Promise.resolve();await h.c.finish();resolveStart();await pending
 assert.equal(h.c.mode,'text');assert.ok(h.stops>=1);assert.equal(h.c.draft,'keep')
 h.c.dictationId='draft';h.c.dictationConversationId='a';h.c.receive({type:'input.transcription',id:'draft',error:'recognition_failed'});assert.equal(h.c.draft,'keep');assert.match(h.c.error,/recognition_failed/)
})
test('reconnect replays every pending request with original conversation and host instance',async()=>{
 const {c,sent,snapshot}=harness();c.draft='A request';await c.submit();const a=sent.at(-1);snapshot('b');c.draft='B request';await c.submit();const b=sent.at(-1)
 c.disconnect();c.connect();assert.deepEqual(sent.slice(-2),[a,b]);c.receive({type:'desktop.capabilities',input_instance_id:'replacement',capabilities:['text_input']});c.disconnect();c.connect();assert.deepEqual(sent.slice(-2),[a,b])
 c.receive({type:'input.text_result',request_id:a.request_id,conversation_id:'a',ok:true});assert.equal(c.state('a').draft,'')
 c.receive({type:'input.text_result',request_id:b.request_id,conversation_id:'b',ok:false,error:'outcome_unknown'});assert.equal(c.state('b').draft,'B request');assert.match(c.state('b').error,/无法确认/)
})
test('a cold-start disconnect before any connection never raises the alarming error',()=>{
 const c=new PersonalController({send:()=>true,start:async()=>{},stop:async()=>{}})
 c.disconnect();assert.equal(c.error,'');assert.equal(c.everConnected,false)
})
test('a real exit after connect still raises the disconnect error',()=>{
 const {c}=harness();c.disconnect();assert.equal(c.error,'连接已断开，草稿已保留');assert.equal(c.everConnected,true)
})
test('rejected command remains an observable failure',async()=>{
 const {c,sent}=harness();const pending=c.command('memory.forget',{id:'x',expected_version:1});c.receive({type:'personal.result',request_id:sent.at(-1).request_id,ok:false,error:'version_conflict'});await assert.rejects(pending,/version_conflict/)
})
test('pending voice claim gates its text before host state arrives; host release stops capture',async()=>{
 const h=harness({autoVoice:false});const claim=h.c.voice();h.c.draft='not mixed';assert.equal(await h.c.submit(),false)
 const request=h.sent.at(-1);h.snapshot('a','a');h.c.receive({type:'personal.result',request_id:request.request_id,ok:true});await claim;assert.equal(h.c.mode,'voice')
 const stops=h.stops;h.snapshot('a',null);assert.equal(h.c.mode,'text');assert.equal(h.stops,stops+1)
})

test('dictation rejects wrong conversation and preserves draft when finish cannot send',async()=>{
 const {c}=harness();c.draft='keep';await c.dictate();const id=c.dictationId
 c.receive({type:'input.transcription',id,conversation_id:'b',text:'wrong'});assert.equal(c.draft,'keep');assert.equal(c.dictationId,id)
 c.send=()=>false;await c.finish();assert.equal(c.mode,'text');assert.equal(c.draft,'keep');assert.match(c.error,/发送失败/)
})
test('empty transcription cannot erase the editable draft',async()=>{
 const {c}=harness();c.draft='keep';await c.dictate();const id=c.dictationId;await c.finish();c.receive({type:'input.transcription',id,text:''});assert.equal(c.draft,'keep');assert.match(c.error,/recognition_failed/)
})
test('dictation failures with a known cause say what went wrong and keep the draft',async()=>{
 for(const [error,expected] of [['no_audio',/没有录到声音/],['no_speech',/没有听清/]]){
  const {c}=harness();c.draft='keep';await c.dictate();const id=c.dictationId;await c.finish();c.receive({type:'input.transcription',id,error})
  assert.equal(c.draft,'keep');assert.match(c.error,expected);assert.match(c.error,/原有草稿已保留/);assert.doesNotMatch(c.error,/recognition_failed/)
 }
})

test('late microphone permission cannot stop a newer capture',async()=>{
 let release;const h=harness({start:()=>new Promise(resolve=>{release=resolve})});const pending=h.c.dictate();await Promise.resolve();await h.c.text();await assert.rejects(h.c.dictate(),/结束持续对话/);release();await pending;assert.equal(h.c.mode,'text');assert.equal(h.starts,1)
})

function presentationHarness(){
 const sent=[],applied=[];let starts=0,stops=0
 const c=new PersonalController({send:frame=>{sent.push(frame);return true},start:async()=>{starts++},stop:async()=>{stops++},applyPresentation:async mode=>{applied.push(mode)}})
 const ack=(ok=true)=>{const request=sent.findLast(frame=>frame.method==='presentation.set');c.receive({type:'personal.result',request_id:request.request_id,ok,data:{mode:request.params.mode},error:ok?undefined:'mode rejected'})}
 return {c,sent,applied,ack,get starts(){return starts},get stops(){return stops}}
}
test('presentation waits for host ACK, preserves voice ownership and drafts, resumes only explicitly',async()=>{
 const h=presentationHarness(),ready=h.c.connect();assert.deepEqual(h.applied,[]);assert.equal(h.c.presentationReady,false);h.ack();await ready
 h.c.receive({type:'personal.state',revision:1,presentation_mode:'workbench',conversations:{selected_id:'a',voice_id:'a',items:[]}})
 h.c.mode='voice';h.c.captureConversationId='a';h.c.draft='keep';const pending=h.c.setPresentation('background')
 assert.equal(h.c.presentationMode,'background');assert.equal(h.stops,1);h.ack();await pending
 assert.equal(h.c.presentationMode,'background');assert.equal(h.c.voiceId,'a');assert.equal(h.c.draft,'keep');assert.equal(h.stops,1)
 assert.equal(h.sent.some(frame=>frame.method==='conversations.voice'),false)
 await h.c.resumeVoice();assert.equal(h.starts,0)
 const restore=h.c.setPresentation('orb');h.ack();await restore;assert.equal(h.starts,0)
 await h.c.resumeVoice();assert.equal(h.starts,1);assert.equal(h.c.mode,'voice');assert.equal(h.sent.at(-1).conversation_id,'a')
})
test('reconnect restores desired presentation before replaying pending text; rejection stays visible',async()=>{
 const h=presentationHarness(),ready=h.c.connect();h.ack();await ready
 h.c.state('a').submission={request_id:'original',text:'keep',instance:'host',restored:false}
 const hide=h.c.setPresentation('background');h.ack();await hide;h.c.disconnect();h.sent.length=0
 const reconnect=h.c.connect();assert.equal(h.sent[0].method,'presentation.set');assert.equal(h.sent[0].params.mode,'background');assert.equal(h.sent.length,1)
 h.ack();await reconnect;assert.equal(h.sent[1].type,'input.text');assert.equal(h.sent[1].request_id,'original')
 const show=h.c.setPresentation('orb');h.ack(false);await assert.rejects(show,/mode rejected/);assert.equal(h.c.presentationMode,'background');assert.equal(h.c.error,'mode rejected')
 await assert.rejects(h.c.setPresentation('invalid'),/无效/)
})
test('snapshot presentation update pauses capture without changing host voice owner',async()=>{
 const h=presentationHarness(),ready=h.c.connect();h.ack();await ready
 h.c.receive({type:'personal.state',revision:1,presentation_mode:'background',conversations:{selected_id:'a',voice_id:'a',items:[]}})
 await Promise.resolve();assert.equal(h.c.presentationMode,'background');assert.equal(h.c.voiceId,'a');assert.equal(h.starts,0);assert.equal(h.stops,1)
})

test('background during pending microphone permission keeps the acquired voice owner',async()=>{
 let rejectStart;const h=presentationHarness(),ready=h.c.connect();h.ack();await ready
 h.c.start=()=>new Promise((_resolve,reject)=>{rejectStart=reject})
 h.c.receive({type:'personal.state',revision:1,conversations:{selected_id:'a',voice_id:null,items:[]}})
 const voice=h.c.voice(),claim=h.sent.at(-1)
 h.c.receive({type:'personal.state',revision:2,conversations:{selected_id:'a',voice_id:'a',items:[]}})
 h.c.receive({type:'personal.result',request_id:claim.request_id,ok:true});for(let n=0;n<10&&!rejectStart;n++)await Promise.resolve();assert.equal(typeof rejectStart,'function')
 const background=h.c.setPresentation('background');h.ack();await background
 rejectStart(new Error('permission denied'));await voice
 assert.equal(h.c.voiceId,'a');assert.equal(h.c.mode,'text');assert.equal(h.sent.filter(frame=>frame.method==='conversations.voice').length,1)
})

test('offline background is immediate and foreground remains available without capture',async()=>{
 const h=presentationHarness();h.c.draft='offline draft';await h.c.setPresentation('background')
 assert.equal(h.c.presentationMode,'background');assert.equal(h.sent.length,0);assert.equal(h.stops,1)
 await h.c.setPresentation('workbench');assert.equal(h.c.presentationMode,'workbench');assert.equal(h.starts,0);assert.equal(h.c.draft,'offline draft');assert.equal(h.c.presentationReady,false)
})
test('background preempts an outstanding foreground request and a late ACK cannot reopen',async()=>{
 const h=presentationHarness(),ready=h.c.connect();h.ack();await ready
 const foreground=h.c.setPresentation('orb'),older=h.sent.at(-1)
 const background=h.c.setPresentation('background');assert.equal(h.c.presentationMode,'background')
 h.c.receive({type:'personal.result',request_id:older.request_id,ok:true,data:{mode:'orb'}});await foreground
 assert.equal(h.c.presentationMode,'background');h.ack();await background;assert.equal(h.c.desiredPresentation,'background')
})
test('presentation recovery retries once without requesting focus and replays only after success',async()=>{
 const h=presentationHarness(),activations=[];h.c.applyPresentation=async(_mode,options)=>activations.push(options.activate)
 h.c.state('a').submission={request_id:'kept',text:'draft',instance:'host'}
 const ready=h.c.connect();h.ack(false)
 for(let n=0;n<10&&h.sent.length<2;n++)await Promise.resolve()
 assert.equal(h.sent.length,2);assert.equal(h.sent[1].method,'presentation.set');h.ack();await ready
 assert.equal(h.c.presentationReady,true);assert.deepEqual(activations,[false]);assert.equal(h.sent[2].type,'input.text')
})
test('failed presentation retries leave a safe offline-style view and preserve pending delivery',async()=>{
 const h=presentationHarness();h.c.state('a').submission={request_id:'kept',text:'draft',instance:'host'}
 const ready=h.c.connect();h.ack(false);for(let n=0;n<10&&h.sent.length<2;n++)await Promise.resolve();h.ack(false);await ready
 assert.equal(h.c.presentationMode,'background');assert.equal(h.c.presentationReady,false);assert.equal(h.c.presentationPending,false);assert.equal(h.sent.some(frame=>frame.type==='input.text'),false)
 const state=h.c.command('state'),request=h.sent.at(-1);h.c.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await state
})
test('conversation notices stay scoped and do not create failed response state',()=>{
 const h=harness();h.c.receive({type:'conversation.notice',conversation_id:'b',code:'coding_target_unavailable',message:'重新选择目标'})
 assert.equal(h.c.error,'');assert.equal(h.c.state('b').error,'重新选择目标');assert.equal(h.c.state('b').submission,null)
})

test('failed background synchronization cannot be undone by a stale foreground snapshot',async()=>{
 const h=presentationHarness(),ready=h.c.connect();h.ack();await ready
 const hidden=h.c.setPresentation('background');h.ack(false);await assert.rejects(hidden,/mode rejected/)
 h.c.receive({type:'personal.state',revision:1,presentation_mode:'workbench',conversations:{selected_id:'a',voice_id:null,items:[]}})
 assert.equal(h.c.presentationMode,'background');assert.equal(h.c.presentationReady,false)
})

test('startup Orb selection is acknowledged before native presentation and survives reconnect', async () => {
 const h=presentationHarness()
 h.c.desiredPresentation='orb'
 const ready=h.c.connect()
 assert.equal(h.sent.at(-1).params.mode,'orb')
 assert.deepEqual(h.applied,[])
 h.ack();await ready
 assert.equal(h.c.presentationMode,'orb')
 assert.equal(h.c.collapsed,true)
 assert.equal(h.starts,0)
 h.c.disconnect()
 const reconnect=h.c.connect();h.ack();await reconnect
 assert.equal(h.c.presentationMode,'orb')
})

test('Todo source drafts stay per conversation and exact submission context survives reconnect',async()=>{
 const h=harness(),source={id:'todo',version:4};h.c.draft='Todo help';h.c.state().source_todo=source;h.snapshot('b');h.c.draft='Other';assert.equal(h.c.state().source_todo,undefined);h.snapshot('a');assert.deepEqual(h.c.state().source_todo,source)
 await h.c.submit();const first=h.sent.findLast(f=>f.type==='input.text');assert.deepEqual(first.source_todo,source);assert.equal(h.c.state().source_todo,null)
 h.c.disconnect();assert.deepEqual(h.c.state('a').source_todo,source);await h.c.connect();assert.deepEqual(h.sent.findLast(f=>f.type==='input.text'),first)
 h.c.receive({type:'input.text_result',request_id:first.request_id,conversation_id:'a',ok:false,error:'submission_failed'});h.snapshot('a');assert.deepEqual(h.c.state().source_todo,source);h.c.draft='';assert.equal(h.c.state().source_todo,null)
})

test('command rejection preserves host input delivery status without interpreting error text',async()=>{
 const h=harness(),pending=h.c.command('tasks.input',{task_id:'t'}),request=h.sent.at(-1)
 h.c.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'arbitrary disk failure',input_status:'unknown'})
 await assert.rejects(pending,error=>error.input_status==='unknown'&&error.message==='arbitrary disk failure')
})

test('a local pre-send rejection is explicitly failed rather than uncertain',async()=>{
 const h=harness();h.c.disconnect();await assert.rejects(h.c.command('tasks.input',{task_id:'t'}),error=>error.input_status==='failed');assert.equal(h.sent.some(frame=>frame.method==='tasks.input'),false)
})

test('oversized personal projections show an error without replacing retained state or replaying commands',async()=>{
 const {c,sent}=harness();const retained=c.snapshot
 c.receive({type:'personal.error',error:'personal_frame_too_large'})
 assert.match(c.error,/过大/);assert.equal(c.snapshot,retained);assert.equal(c.connected,true)
 const pending=c.command('tasks.get',{task_id:'task'});const request=sent.at(-1),count=sent.length
 c.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'personal_frame_too_large',input_status:'unknown'})
 await assert.rejects(pending,error=>error.input_status==='unknown'&&/过大/.test(error.message))
 assert.equal(sent.length,count);assert.equal(c.snapshot,retained)
})
