import assert from 'node:assert/strict'
import {test} from 'node:test'
import {RealtimeProviderSession} from '../src/realtime/provider-session.js'
import {GeminiLiveAdapter} from '../src/realtime/gemini.js'
import type {QwenSocket} from '../src/realtime/qwen.js'

interface Sent {setup:{model:string;systemInstruction:unknown};realtimeInput:{audio:{mimeType:string}}}
function harness() {
  const sockets: {sent:Sent[]; push:(frame:unknown)=>void}[]=[]
  let id=0
  const adapter=new GeminiLiveAdapter({url:'wss://example.test/live',model:'gemini-3.8-live',voice:'Kore',apiKey:'synthetic',idFactory:()=>`id-${++id}`,connector:() => {
    const queue:unknown[]=[{setupComplete:{}}], sent:Sent[]=[]
    let wake: (()=>void)|undefined, closed=false
    const socket:QwenSocket={send:payload=>{sent.push(JSON.parse(payload) as Sent);return Promise.resolve()},receive:async()=>{while(!queue.length&&!closed)await new Promise<void>(r=>{wake=r});if(closed)throw new Error('closed');return JSON.stringify(queue.shift())},close:()=>{closed=true;wake?.();return Promise.resolve()}}
    sockets.push({sent,push:frame=>{queue.push(frame);wake?.()}})
    return Promise.resolve(socket)
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
  h.sockets[0]!.push({serverContent:{inputTranscription:{text:'hello'}}})
  assert.equal((await events.next()).value?.kind,'user_speech_started')
  assert.equal((await events.next()).value?.kind,'user_transcript_delta')
  h.sockets[0]!.push({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AAA='}}]},outputTranscription:{text:'Hi'},turnComplete:true}})
  const kinds=[];for(let i=0;i<7;i++){const event=(await events.next()).value;kinds.push(event?.kind);if(event?.kind==='response_terminal')break}
  assert.deepEqual(kinds,['user_speech_ended','user_transcript_final','response_started','response_audio_delta','response_transcript_delta','response_transcript_final','response_terminal'])
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
 h.sockets[0]!.push({serverContent:{inputTranscription:{text:'hello'},outputTranscription:{text:'Hi'}}})
 for(let i=0;i<6;i++)await events.next()
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
 assert.equal(first.value?.kind,'response_started')
 await h.adapter.close()
})
test('Gemini native tool reply retains ID/name and never sends duplicate response activation',async()=>{
 const h=harness();await h.adapter.connect({tools:[],signal:h.signal})
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]()
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'native',name:'search',args:{query:'hello'}}]}})
 assert.equal((await events.next()).value?.kind,'response_started')
 assert.equal((await events.next()).value?.kind,'tool_call_ready')
 assert.equal((await events.next()).value?.kind,'response_terminal')
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
 h.sockets[0]!.push({toolCall:{functionCalls:[{id:'cancelled',name:'dispatch',args:{}}]}})
 h.sockets[0]!.push({toolCallCancellation:{ids:['cancelled']}})
 h.sockets[0]!.push({serverContent:{outputTranscription:{text:'next'},turnComplete:true}})
 await new Promise<void>(r=>setImmediate(r))
 const events=h.adapter.events(h.signal)[Symbol.asyncIterator]()
 assert.equal((await events.next()).value?.kind,'response_started')
 assert.equal((await events.next()).value?.kind,'response_terminal')
 await h.adapter.close()
})
