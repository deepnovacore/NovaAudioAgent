import assert from 'node:assert/strict'
import {test} from 'node:test'
import {RealtimeProviderSession} from '../src/realtime/provider-session.js'
import {GeminiLiveAdapter} from '../src/realtime/gemini.js'
import type {QwenSocket} from '../src/realtime/qwen.js'

interface Sent {setup:{model:string;systemInstruction:unknown};realtimeInput:{audio:{mimeType:string}}}
function harness(options:{onSend?:(index:number,frame:unknown)=>void|Promise<void>;beforeConnect?:(index:number)=>Promise<void>}={}) {
  const sockets: {sent:Sent[]; push:(frame:unknown)=>void}[]=[]
  let id=0
  const adapter=new GeminiLiveAdapter({url:'wss://example.test/live',model:'gemini-3.8-live',voice:'Kore',apiKey:'synthetic',idFactory:()=>`id-${++id}`,connector:() => {
    const index=sockets.length
    const queue:unknown[]=[{setupComplete:{}}], sent:Sent[]=[]
    let wake: (()=>void)|undefined, closed=false
    const socket:QwenSocket={send:payload=>{const frame=JSON.parse(payload) as Sent;sent.push(frame);return Promise.resolve(options.onSend?.(index,frame))},receive:async()=>{while(!queue.length&&!closed)await new Promise<void>(r=>{wake=r});if(closed)throw new Error('closed');return JSON.stringify(queue.shift())},close:()=>{closed=true;wake?.();return Promise.resolve()}}
    sockets.push({sent,push:frame=>{queue.push(frame);wake?.()}})
    return (options.beforeConnect?.(index)??Promise.resolve()).then(()=>socket)
  }})
  return {adapter,sockets,signal:new AbortController().signal}
}
test('Gemini waits for setup acknowledgement, sends native audio and stages host facts locally',async()=>{
  const h=harness(); const identity=await h.adapter.connect({tools:[],signal:h.signal})
  assert.equal(identity.epoch,1)
  assert.equal(h.sockets[0]!.sent[0]!.setup.model,'models/gemini-3.8-live')
  await h.adapter.sendAudio(new Uint8Array([0,0]),h.signal)
  assert.equal(h.sockets[0]!.sent[1]!.realtimeInput.audio.mimeType,'audio/pcm;rate=16000')
  const before=h.sockets[0]!.sent.length
  await h.adapter.injectHostItem({kind:'progress',host_item_id:'host',event_id:'event',content:'ready',call_id:null},{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
  assert.equal(h.sockets[0]!.sent.length,before)
  await h.adapter.close()
})
test('Gemini normalizes transcript, PCM, terminal and ignores late frames after close',async()=>{
  const h=harness();await h.adapter.connect({tools:[],signal:h.signal});const events=h.adapter.events(h.signal)[Symbol.asyncIterator]()
  h.sockets[0]!.push({serverContent:{inputTranscription:{text:'hello',finished:true}}})
  assert.equal((await events.next()).value?.kind,'user_transcript_delta')
  assert.equal((await events.next()).value?.kind,'user_transcript_final')
  h.sockets[0]!.push({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AAA='}}]},outputTranscription:{text:'Hi'},turnComplete:true}})
  const kinds=[];for(let i=0;i<7;i++){const event=(await events.next()).value;kinds.push(event?.kind);if(event?.kind==='response_terminal')break}
  assert.deepEqual(kinds,['response_started','response_audio_delta','response_transcript_delta','response_transcript_final','response_terminal'])
  await h.adapter.close();assert.equal((await events.next()).done,true)
})
test('Gemini workspace replacement is acknowledged by a fresh setup and never sent as user activation',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 const item={kind:'workspace_context' as const,host_item_id:'h',event_id:'e',content:'workspace B',call_id:null,session_epoch:1,workspace_instance_id:'w',revision:1}
 const record=await h.adapter.injectWorkspaceContext(item,{confirmationTimeout:1,signal:h.signal})
 assert.equal(record.delivery.capability,'refresh_session');assert.equal(record.delivery.delivered,true)
 assert.equal(h.sockets.length,2);assert.match(JSON.stringify(h.sockets[1]!.sent[0]!.setup.systemInstruction),/workspace B/)
 assert.equal(h.sockets[1]!.sent.length,1)
 await h.adapter.close()
})
test('Gemini host narration accepts continuous microphone PCM without reconnecting or cancelling',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 const item={kind:'progress' as const,host_item_id:'h',event_id:'e',content:'ready',call_id:null}
 await h.adapter.injectHostItem(item,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 await h.adapter.createResponse({kind:'host_fact',item,task_summary:null,origin_spoken:false},h.signal)
 const count=h.sockets.length
 await h.adapter.sendAudio(new Uint8Array([0,0]),h.signal)
 assert.equal(h.sockets.length,count)
 assert.ok(h.sockets.at(-1)!.sent.at(-1)!.realtimeInput)
 await h.adapter.close()
})
test('Gemini rejects tool results for unknown or cancelled native call IDs',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 const item={kind:'tool_output' as const,host_item_id:'h',event_id:'e',content:'result',call_id:'cancelled'}
 await h.adapter.injectHostItem(item,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 await assert.rejects(h.adapter.createResponse({kind:'tool_result',item,task_summary:null,origin_spoken:false},h.signal))
 await h.adapter.close()
})
test('Gemini wrapper does not rebuild the session for rolling dispatch source updates',async()=>{
 const h=harness();let sources:{ref:string;text:string}[]=[]
 const wrapper=new RealtimeProviderSession(h.adapter,{responseAdaptation:()=>({revision:sources.length,content:null,user_sources:sources})})
 await wrapper.connect([],h.signal)
 const events=wrapper.events(h.signal)[Symbol.asyncIterator]()
 h.sockets[0]!.push({serverContent:{inputTranscription:{text:'hello',finished:true},outputTranscription:{text:'Hi'}}})
 for(let i=0;i<4;i++)await events.next()
 sources=[{ref:'conversation:1',text:'hello'}]
 await wrapper.sendAudio(new Uint8Array([0,0]),h.signal)
 assert.equal(h.sockets.length,1)
 await wrapper.close()
})
test('Gemini refresh discards queued old user/tool authority and rejects its result',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 h.sockets[0]!.push({serverContent:{inputTranscription:{text:'old request'}},toolCall:{functionCalls:[{id:'old-call',name:'dispatch',args:{}}]}})
 await new Promise<void>(r=>setImmediate(r))
 const item={kind:'workspace_context' as const,host_item_id:'w',event_id:'e',content:'new workspace',call_id:null,session_epoch:1,workspace_instance_id:'new',revision:1}
 await h.adapter.injectWorkspaceContext(item,{confirmationTimeout:1,signal:h.signal})
 const result={kind:'tool_output' as const,host_item_id:'result',event_id:'result',content:'done',call_id:'old-call'}
 await h.adapter.injectHostItem(result,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 await assert.rejects(h.adapter.createResponse({kind:'tool_result',item:result,task_summary:null,origin_spoken:false},h.signal))
 h.sockets[1]!.push({serverContent:{outputTranscription:{text:'new reply'},turnComplete:true}})
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]()
 const first=await events.next()
 assert.equal(first.value?.kind,'user_transcript_failed')
 assert.deepEqual((await events.next()).value,{kind:'provider_error',session_epoch:1,code:'context_refresh_pending_response',recoverable:true})
 await h.adapter.close()
})
test('Gemini native tool reply retains ID/name and never sends duplicate response activation',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 await h.adapter.submitText('search hello',h.signal)
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]()
 await events.next()
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'native',name:'search',args:{query:'hello'}}]}})
 assert.equal((await events.next()).value?.kind,'response_started')
 assert.equal((await events.next()).value?.kind,'tool_call_ready')
 assert.equal((await events.next()).value?.kind,'response_yielded')
 const item={kind:'tool_output' as const,host_item_id:'h',event_id:'e',content:'result',call_id:'native'}
 await h.adapter.injectHostItem(item,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 const before=h.sockets[0]!.sent.length
 await h.adapter.createResponse({kind:'tool_result',item,task_summary:null,origin_spoken:false},h.signal)
 assert.equal(h.sockets[0]!.sent.length,before+1)
 assert.deepEqual(h.sockets[0]!.sent.at(-1),{toolResponse:{functionResponses:[{id:'native',name:'search',response:{result:'result'}}]}})
 await h.adapter.close()
})
test('Gemini drops cancelled native tool calls still waiting in the event queue',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 await h.adapter.submitText('dispatch',h.signal)
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'cancelled',name:'dispatch',args:{}}]}})
 h.sockets[0]!.push({toolCallCancellation:{ids:['cancelled']}})
 h.sockets[0]!.push({serverContent:{outputTranscription:{text:'next'},turnComplete:true}})
 await new Promise<void>(r=>setImmediate(r))
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]()
 assert.equal((await events.next()).value?.kind,'user_transcript_final')
 assert.equal((await events.next()).value?.kind,'response_started')
 assert.equal((await events.next()).value?.kind,'response_yielded')
 assert.equal((await events.next()).value?.kind,'response_terminal')
 await h.adapter.close()
})

test('Gemini does not infer transcript completion or speech activity from model output',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 const collected:unknown[]=[]
 const reading=(async()=>{for await(const event of h.adapter.events(h.signal))collected.push(event)})()
 h.sockets[0]!.push({serverContent:{inputTranscription:{text:'hello'}}})
 h.sockets[0]!.push({serverContent:{outputTranscription:{text:'Hi'},turnComplete:true}})
 await new Promise<void>(r=>setImmediate(r))
 const events=collected as {kind:string;text?:string;origin?:unknown}[]
 assert.equal(events.some(e=>e.kind==='user_transcript_final'||e.kind==='user_speech_started'||e.kind==='user_speech_ended'),false)
 assert.deepEqual(events.find(e=>e.kind==='response_started')?.origin,{kind:'unknown'})
 h.sockets[0]!.push({serverContent:{inputTranscription:{text:' world',finished:true}}})
 await new Promise<void>(r=>setImmediate(r))
 assert.equal(events.find(e=>e.kind==='user_transcript_final')?.text,'hello world')
 await h.adapter.close();await reading
})
test('Gemini yields a text-origin generation for native tools without claiming turn completion',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 await h.adapter.submitText('search hello',h.signal)
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]()
 assert.equal((await events.next()).value?.kind,'user_transcript_final')
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'native',name:'search',args:{query:'hello'}}]}})
 assert.equal((await events.next()).value?.kind,'response_started')
 assert.equal((await events.next()).value?.kind,'tool_call_ready')
 assert.equal((await events.next()).value?.kind,'response_yielded')
 await h.adapter.close()
})
test('Gemini rejects delivered tool results after session replacement without sending user content',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 await h.adapter.submitText('search',h.signal)
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]()
 await events.next()
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'old-call',name:'search',args:{}}]}})
 await events.next();await events.next();await events.next()
 await h.adapter.replaceResponseAdaptation({revision:1,content:'new context'},h.signal)
 const item={kind:'tool_output' as const,host_item_id:'h',event_id:'e',content:'result',call_id:'old-call'}
 await h.adapter.injectHostItem(item,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 const before=h.sockets[1]!.sent.length
 await assert.rejects(h.adapter.createResponse({kind:'tool_result',item,task_summary:null,origin_spoken:false},h.signal))
 assert.equal(h.sockets[1]!.sent.length,before)
 await h.adapter.close()
})

test('Gemini replies to a complete native tool batch including delegation acknowledgements',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 await h.adapter.submitText('search and dispatch',h.signal)
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]();await events.next()
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'a',name:'search',args:{}},{id:'b',name:'dispatch',args:{}}]}})
 for(let i=0;i<4;i++)await events.next()
 const a={kind:'tool_output' as const,host_item_id:'a',event_id:'a',call_id:'a',content:'search result'}
 const b={kind:'tool_output' as const,host_item_id:'b',event_id:'b',call_id:'b',content:'accepted'}
 await h.adapter.injectHostItem(a,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 await assert.rejects(h.adapter.createResponse({kind:'tool_result',item:a,task_summary:null,origin_spoken:false},h.signal),/Incomplete/)
 await h.adapter.injectHostItem(b,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 await h.adapter.createResponse({kind:'delegation_acknowledgement',item:b,task_summary:'dispatch',origin_spoken:false},h.signal)
 assert.deepEqual(h.sockets[0]!.sent.at(-1),{toolResponse:{functionResponses:[{id:'a',name:'search',response:{result:'search result'}},{id:'b',name:'dispatch',response:{result:'accepted'}}]}})
 await h.adapter.close()
})
test('Gemini returns a native refusal for uncorrelated audio tools without dispatching host actions',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 await h.adapter.sendAudio(new Uint8Array([0,0]),h.signal)
 const collected:{kind:string}[]=[]
 const reading=(async()=>{for await(const event of h.adapter.events(h.signal))collected.push(event)})()
 h.sockets[0]!.push({serverContent:{inputTranscription:{text:'search',finished:true}}})
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'unsafe',name:'dispatch',args:{}}]}})
 await new Promise<void>(r=>setImmediate(r))
 assert.equal(collected.some(event=>event.kind==='tool_call_ready'),false)
 assert.match(JSON.stringify(h.sockets[0]!.sent.at(-1)),/unverified_input_origin/)
 await h.adapter.close();await reading
})

test('Gemini partial tool cancellation reconnects instead of resuming an incomplete batch',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 await h.adapter.submitText('two actions',h.signal)
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]();await events.next()
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'a',name:'search',args:{}},{id:'b',name:'search',args:{}}]}})
 for(let i=0;i<4;i++)await events.next()
 h.sockets[0]!.push({toolCallCancellation:{ids:['a']}})
 h.sockets[0]!.push({serverContent:{outputTranscription:{text:'barrier'}}})
 assert.deepEqual((await events.next()).value,{kind:'provider_error',session_epoch:1,code:'tool_batch_cancelled',recoverable:true})
 await h.adapter.close()
})

test('Gemini local host facts survive a setup refresh before activation',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 const item={kind:'progress' as const,host_item_id:'h',event_id:'e',content:'ready',call_id:null}
 const receipt=await h.adapter.injectHostItem(item,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 assert.equal(receipt.delivery,'staged')
 await h.adapter.replaceResponseAdaptation({revision:1,content:'speak briefly'},h.signal)
 await h.adapter.createResponse({kind:'host_fact',item,task_summary:null,origin_spoken:false},h.signal)
 assert.match(JSON.stringify(h.sockets[1]!.sent.at(-1)),/ready/)
 await h.adapter.close()
})

test('Gemini context refresh settles pre-start host response debt through host reconnect',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 const item={kind:'progress' as const,host_item_id:'h',event_id:'e',content:'ready',call_id:null}
 await h.adapter.injectHostItem(item,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 await h.adapter.createResponse({kind:'host_fact',item,task_summary:null,origin_spoken:false},h.signal)
 await h.adapter.replaceResponseAdaptation({revision:1,content:'brief'},h.signal)
 h.sockets[1]!.push({serverContent:{outputTranscription:{text:'barrier'}}})
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]()
 assert.deepEqual((await events.next()).value,{kind:'provider_error',session_epoch:1,code:'context_refresh_pending_response',recoverable:true})
 await h.adapter.close()
})
test('Gemini rejects a second activation before the first response begins',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 await h.adapter.submitText('hello',h.signal)
 const item={kind:'progress' as const,host_item_id:'h',event_id:'e',content:'ready',call_id:null}
 await h.adapter.injectHostItem(item,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 const before=h.sockets[0]!.sent.length
 await assert.rejects(h.adapter.createResponse({kind:'host_fact',item,task_summary:null,origin_spoken:false},h.signal),/busy/)
 assert.equal(h.sockets[0]!.sent.length,before)
 await h.adapter.close()
})
test('Gemini retains a fully heard text tool continuation in refreshed history',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 await h.adapter.submitText('search hello',h.signal)
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]();await events.next()
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'native',name:'search',args:{}}]}})
 for(let i=0;i<3;i++)await events.next()
 const item={kind:'tool_output' as const,host_item_id:'h',event_id:'e',content:'result',call_id:'native'}
 await h.adapter.injectHostItem(item,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 await h.adapter.createResponse({kind:'tool_result',item,task_summary:null,origin_spoken:false},h.signal)
 h.sockets[0]!.push({serverContent:{outputTranscription:{text:'Found it'},turnComplete:true}})
 const response=(await events.next()).value;assert.ok(response&&'response_id' in response)
 for(let i=0;i<3;i++)await events.next()
 await h.adapter.reportPlayback({response_id:response.response_id!,played_ms:100,disposition:'spoken'},h.signal)
 await h.adapter.replaceResponseAdaptation({revision:1,content:'brief'},h.signal)
 assert.match(JSON.stringify(h.sockets[1]!.sent[0]!.setup.systemInstruction),/Found it/)
 await h.adapter.close()
})

test('Gemini refusal stays on its issuing socket during concurrent context refresh',async()=>{
 let refreshed:Promise<void>|undefined
 const h=harness({onSend:(index,frame)=>{
   if(index===0&&typeof frame==='object'&&frame!==null&&'toolResponse' in frame){
     refreshed=h.adapter.replaceResponseAdaptation({revision:1,content:'updated'},h.signal)
     return refreshed
   }
 }})
 await h.adapter.connect({tools:[],signal:h.signal})
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'a',name:'search',args:{}},{id:'b',name:'search',args:{}}]}})
 await new Promise<void>(r=>setImmediate(r));await refreshed
 const oldReplies=h.sockets[0]!.sent.filter(frame=>'toolResponse' in frame)
 assert.equal(oldReplies.length,1)
 assert.deepEqual((oldReplies[0] as unknown as {toolResponse:{functionResponses:{id:string}[]}}).toolResponse.functionResponses.map(call=>call.id),['a','b'])
 assert.equal(h.sockets[1]!.sent.some(frame=>'toolResponse' in frame),false)
 await h.adapter.close()
})
test('Gemini local staging remains available while a replacement socket is connecting',async()=>{
 let release!:()=>void
 const connecting=new Promise<void>(resolve=>{release=resolve})
 const h=harness({beforeConnect:index=>index===1?connecting:Promise.resolve()})
 await h.adapter.connect({tools:[],signal:h.signal})
 const refreshing=h.adapter.replaceResponseAdaptation({revision:1,content:'updated'},h.signal)
 await new Promise<void>(r=>setImmediate(r))
 const item={kind:'progress' as const,host_item_id:'h',event_id:'e',content:'ready',call_id:null}
 const receipt=await h.adapter.injectHostItem(item,{confirmationTimeout:1,asUserActivation:false,signal:h.signal})
 assert.equal(receipt.delivery,'staged')
 assert.equal(await h.adapter.ensureResponse(h.signal),false)
 await h.adapter.reportPlayback({response_id:'old',played_ms:0,disposition:'interrupted'},h.signal)
 release();await refreshing
 await h.adapter.createResponse({kind:'host_fact',item,task_summary:null,origin_spoken:false},h.signal)
 assert.match(JSON.stringify(h.sockets[1]!.sent.at(-1)),/ready/)
 await h.adapter.close()
})
