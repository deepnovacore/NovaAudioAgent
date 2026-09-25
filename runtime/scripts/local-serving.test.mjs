import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings, requirePersonalMemory} from '../dist/src/config/config.js'
import {requireSelectedCascadedLlmConfig} from '../dist/src/config/cascaded-realtime-config.js'
const profile = {llm:{baseUrl:'http://127.0.0.1:18101/v1',model:'Qwen/Qwen3.5-4B'},asr:{endpoint:'http://127.0.0.1:18102/v1/audio/stream'},tts:{endpoint:'http://127.0.0.1:18103/v1/audio/speech'},embedding:{baseUrl:'http://127.0.0.1:18104/v1',model:'Qwen/Qwen3-Embedding-0.6B'}}
test('local serving routes conversation and memory without cloud credentials',()=>{
 const settings=loadSettings({NOVA_AUDIO_AGENT_LOCAL_SERVING:JSON.stringify(profile)})
 assert.equal(settings.pipeline_mode,'cascaded')
 assert.equal(requireSelectedCascadedLlmConfig(settings).config.baseUrl,profile.llm.baseUrl)
 const memory=requirePersonalMemory(settings)
 assert.equal(memory.extraction.baseUrl,profile.llm.baseUrl)
 assert.equal(memory.embedding.baseUrl,profile.embedding.baseUrl)
 assert.equal(memory.extractionModel,profile.llm.model)
})
test('local serving rejects credential URLs and non-loopback plaintext',()=>{
 for(const url of ['http://example.com/v1','http://user:secret@localhost/v1','file:///tmp/model','http://127.0.0.1/v1?secret=yes']){
  assert.throws(()=>loadSettings({NOVA_AUDIO_AGENT_LOCAL_SERVING:JSON.stringify({...profile,llm:{...profile.llm,baseUrl:url}})}))
 }
})

test('TTS preserves streaming PCM across odd chunks',async()=>{
 const {BreezeTtsClient}=await import('../dist/src/realtime/cascaded/http-speech.js')
 const tts=await new BreezeTtsClient({...profile.tts,instruction:'clear',apiKey:'',fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.enqueue(new Uint8Array([4]));c.close()}}),{headers:{'content-type':'audio/pcm','x-sample-rate':'24000','x-sample-format':'s16le'}})}).open()
 const audio=Array.fromAsync(tts.events());await tts.sendText('你好。');await tts.finish()
 assert.deepEqual([...Buffer.concat((await audio).map(x=>Buffer.from(x.pcm)))],[1,2,3,4]);await tts.close()
})

test('TTS cancellation aborts its active request and prevents queued speech',async()=>{
 const {BreezeTtsClient}=await import('../dist/src/realtime/cascaded/http-speech.js')
 let calls=0,resolveStarted
 const started=new Promise(resolve=>{resolveStarted=resolve})
 const session=await new BreezeTtsClient({...profile.tts,instruction:'clear',apiKey:'',fetch:async(_url,init)=>{
  calls++;resolveStarted()
  return await new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}))
 }}).open()
 const events=Array.fromAsync(session.events()).catch(error=>error)
 await session.sendText('第一句。第二句。');await started
 await session.cancel();await events;assert.equal(calls,1)
 await assert.rejects(session.sendText('第三句。'));await session.close()
})

test('streaming ASR emits partial before finish, final once, and rejects premature close',async()=>{
 const {WebSocketServer}=await import('ws')
 const {once}=await import('node:events')
 const {StreamingAsrClient}=await import('../dist/src/realtime/cascaded/streaming-asr.js')
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening')
 let disconnect=false,busyOnce=true
 server.on('connection',socket=>{
  if(busyOnce){busyOnce=false;socket.close(1013);return}
  socket.send(JSON.stringify({type:'ready',sampleRate:16000,format:'s16le'}))
  socket.on('message',(data,binary)=>{
   if(disconnect){socket.close();return}
   if(binary)socket.send(JSON.stringify({text:'hello',final:false,replace:true}))
   else if(data.toString()==='finish')setTimeout(()=>socket.send(JSON.stringify({text:'hello world',final:true,replace:true})),50)
  })
 })
 const client=new StreamingAsrClient({endpoint:`http://127.0.0.1:${server.address().port}/v1/audio/stream`,apiKey:''})
 try{
  const session=await client.open();const events=session.events()[Symbol.asyncIterator]()
  await session.append(new Uint8Array(320));assert.equal((await events.next()).value.text,'hello')
  await session.finish();assert.equal((await events.next()).value.final,true);assert.equal((await events.next()).done,true)
  await session.close();disconnect=true
  const failed=await client.open();const reading=Array.fromAsync(failed.events());void reading.catch(()=>{})
  await failed.append(new Uint8Array(320));await assert.rejects(reading,/closed before final/);await failed.close()
 }finally{for(const c of server.clients)c.terminate();await new Promise(resolve=>server.close(resolve))}
})

test('TTS tolerates brief upstream cancellation cleanup before the next request',async()=>{
 const {BreezeTtsClient}=await import('../dist/src/realtime/cascaded/http-speech.js')
 let calls=0
 const session=await new BreezeTtsClient({...profile.tts,apiKey:'',instruction:'clear',fetch:async()=>++calls===1?new Response(null,{status:409}):new Response(new Uint8Array([1,2]),{headers:{'content-type':'audio/pcm','x-sample-rate':'24000','x-sample-format':'s16le'}})}).open()
 const audio=Array.fromAsync(session.events());void audio.catch(()=>{})
 try{await session.sendText('恢复。');await session.finish();assert.equal((await audio).length,1);assert.equal(calls,2)}finally{await session.close()}
})
test('explicit invalid local profiles never silently select cloud',()=>{
 for(const value of ['null','',JSON.stringify({...profile,llm:{...profile.llm,apiKey:''}})])assert.throws(()=>loadSettings({NOVA_AUDIO_AGENT_LOCAL_SERVING:value}))
})

test('remote local serving audio format is independent of legacy cloud TTS settings',async()=>{
 const {remoteClientMedia}=await import('../dist/src/server/server-config.js')
 const settings=loadSettings({NOVA_AUDIO_AGENT_LOCAL_SERVING:JSON.stringify(profile),NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE:'16000'})
 assert.equal(remoteClientMedia(settings).pipeline,'cascaded')
})

test('stage metrics distinguish first transcript, endpoint latency and delivery RTF',async()=>{
 const {voiceMetrics}=await import('./local-serving/metrics.mjs')
 const events=[{kind:'user_speech_started',ms:100},{kind:'user_transcript_delta',ms:600,text:'hello'},{kind:'user_speech_ended',ms:1000},{kind:'user_transcript_final',ms:1100,text:'hello'},{kind:'response_audio_delta',ms:1500},{kind:'response_terminal',ms:2000,status:'completed'}]
 const telemetry=[{name:'cascaded.llm.requested',ms:1110},{name:'cascaded.llm.first_text',ms:1300},{name:'volcengine.tts.first_text',ms:1400}]
 const result=voiceMetrics(events,telemetry,48000,{startedMs:0,acousticStartMs:100,acousticEndMs:800,reference:'hello world'})
 assert.equal(result.speechStartToFirstTranscriptMs,500)
 assert.equal(result.endpointToFirstAudioMs,500)
 assert.equal(result.estimatedAcousticEndToFirstAudioMs,700)
 assert.equal(result.llmFirstTextMs,190)
 assert.equal(result.ttsDeliveryRtf,.6)
 assert.equal(result.llmCompletionMs,null)
 assert.equal(result.firstTranscriptBeforeEndpoint,true)
 assert.equal(result.firstUsefulTranscriptFromSpeechEventMs,500)
 assert.equal(result.finalTranscriptCount,1)
})


test('local extraction has an independent endpoint and local VAD uses measured defaults',async()=>{
 const {resolveEndpointingConfig}=await import('../dist/src/config/cascaded-realtime-config.js')
 const settings=loadSettings({NOVA_AUDIO_AGENT_LOCAL_SERVING:JSON.stringify({...profile,extraction:{baseUrl:'http://127.0.0.1:18106/v1',model:'Qwen/Qwen3.5-4B'}})})
 assert.equal(requirePersonalMemory(settings).extraction.baseUrl,'http://127.0.0.1:18106/v1')
 assert.equal(requireSelectedCascadedLlmConfig(settings).config.baseUrl,profile.llm.baseUrl)
 const config=resolveEndpointingConfig(settings)
 assert.equal(config.vadMinSpeechMs,100);assert.equal(config.vadSilenceEndMs,250);assert.equal(config.maxSilenceMs,1200)
})

test('local memory sends the actual schema to its serving backend',async()=>{
 const {OpenAIModelGateway}=await import('../dist/src/model/model-gateway.js')
 const {RealClock}=await import('../dist/src/core/clock.js')
 const schema={type:'object',properties:{status:{enum:['open',null]}},required:['status'],additionalProperties:false}
 let body
 const gateway=new OpenAIModelGateway({baseUrl:'http://127.0.0.1:18106/v1',apiKey:'local',clock:new RealClock(),structuredOutput:'json-schema',fetch:async(_url,init)=>{body=JSON.parse(init.body);return Response.json({choices:[{message:{content:'{"status":null}'},finish_reason:'stop'}]})}})
 await gateway.complete({model:'local',system:'extract',prompt:'synthetic',jsonSchema:schema})
 assert.deepEqual(body.response_format,{type:'json_schema',json_schema:{name:'response',strict:true,schema}})
})

test('local tool-enabled speech streams before terminal and rejects a later tool call',async()=>{
 for(const mixed of [false,true]){
 let source
 const body=new ReadableStream({start(c){source=c}})
 const {createQwenCascadedLlmFactory}=await import('../dist/src/realtime/cascaded/qwen-llm.js')
 const session=createQwenCascadedLlmFactory({baseUrl:'http://localhost',apiKey:'test',model:'local',instructions:'test',streamTextWithTools:true,fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})}).open()
 const received=[]
 const reading=(async()=>{for await(const e of session.stream({inputs:[],tools:[{name:'dispatch',parameters:{type:'object'}}],signal:AbortSignal.timeout(2000)}))received.push(e)})()
 const send=(delta,finish_reason)=>source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'r',choices:[{delta,finish_reason}]})}\n\n`))
 send({content:'你好。'})
 await new Promise(r=>setImmediate(r))
 const early=received.some(e=>e.kind==='text_delta')
 if(mixed)send({tool_calls:[{index:0,id:'c',function:{name:'dispatch',arguments:'{}'}}]},'tool_calls')
 else send({},'stop')
 source.close();await reading;await session.close()
 assert.equal(early,true,'speech was buffered until terminal')
 assert.equal(received.at(-1).kind,mixed?'response_failed':'response_completed')
 assert.ok(!received.some(e=>e.kind==='tool_call'))
 }
})

test('local Qwen template receives one initial system message across turns',async()=>{
 const {createQwenCascadedLlmFactory}=await import('../dist/src/realtime/cascaded/qwen-llm.js')
 const requests=[]
 const session=createQwenCascadedLlmFactory({provider:'openai-compatible',baseUrl:'http://localhost',apiKey:'test',model:'local',instructions:'rules',fetchImpl:async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response('data: {"id":"r","choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"id":"r","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',{headers:{'content-type':'text/event-stream'}})}}).open()
 const run=inputs=>Array.fromAsync(session.stream({inputs,tools:[],signal:AbortSignal.timeout(2000)}))
 await run([{kind:'user_text',text:'first'}])
 await run([{kind:'host_context',content:'current host fact'},{kind:'user_text',text:'second'}])
 await session.close()
 assert.equal(requests[1].messages.filter(m=>m.role==='system').length,1)
 assert.match(requests[1].messages[0].content,/current host fact/)
 assert.deepEqual(requests[1].messages.slice(1).map(m=>m.content),['first','hello','second'])
})

test('Breeze submits an already chunked clause without another text timer',async()=>{
 const {BreezeTtsClient}=await import('../dist/src/realtime/cascaded/http-speech.js')
 let calls=0
 const session=await new BreezeTtsClient({...profile.tts,apiKey:'',instruction:'clear',fetch:async()=>{calls++;return new Response(new Uint8Array([1,2]),{headers:{'content-type':'audio/pcm','x-sample-rate':'24000','x-sample-format':'s16le'}})}}).open()
 const audio=Array.fromAsync(session.events())
 await session.sendText('你好，')
 await new Promise(r=>setImmediate(r))
 const immediate=calls
 await session.finish();await audio;await session.close()
 assert.equal(immediate,1,'already chunked clause waited for a second text timer')
})

test('local streaming still delivers a complete tool call without speech',async()=>{
 const {createQwenCascadedLlmFactory}=await import('../dist/src/realtime/cascaded/qwen-llm.js')
 const events=[{id:'r',choices:[{delta:{tool_calls:[{index:0,id:'c',function:{name:'lookup',arguments:'{}'}}]}}]},{id:'r',choices:[{delta:{},finish_reason:'tool_calls'}]}]
 const session=createQwenCascadedLlmFactory({baseUrl:'http://localhost',apiKey:'test',model:'local',instructions:'test',streamTextWithTools:true,fetchImpl:async()=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})}).open()
 const result=await Array.fromAsync(session.stream({inputs:[],tools:[{name:'lookup',parameters:{type:'object'}}],signal:AbortSignal.timeout(2000)}))
 assert.deepEqual(result.map(e=>e.kind),['response_started','tool_call','response_completed'])
 await session.close()
})

test('local background gateways use the independent extraction service',async()=>{
 const {resolveSupportModelConnection}=await import('../dist/src/config/config.js')
 const extraction={baseUrl:'http://127.0.0.1:18106/v1',model:'background-4b',apiKey:'local'}
 const settings=loadSettings({NOVA_AUDIO_AGENT_LOCAL_SERVING:JSON.stringify({...profile,extraction})})
 assert.equal(settings.model_base_url,extraction.baseUrl)
 assert.equal(settings.planner_model,extraction.model)
 assert.equal(resolveSupportModelConnection(settings,profile.llm).baseUrl,extraction.baseUrl)
 assert.equal(requireSelectedCascadedLlmConfig(settings).config.baseUrl,profile.llm.baseUrl)
})
