import assert from 'node:assert/strict'
import {test} from 'node:test'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {VirtualClock} from '../src/core/clock.js'
import {once} from 'node:events'
import {createServer, type Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {WebSocketServer} from 'ws'
import {loadSettings, describeMissingBlockingCredentials} from '../src/config/config.js'
import {requireSelectedCascadedRealtimeConfig, requireSelectedCascadedLlmConfig} from '../src/config/cascaded-realtime-config.js'
import {selfHostedEndpoint} from '../src/config/self-hosted.js'
import {SelfHostedAsrClient} from '../src/realtime/cascaded/self-hosted-asr.js'
import {SelfHostedTtsClient} from '../src/realtime/cascaded/self-hosted-tts.js'
import {createChatCompletionsLlmFactory} from '../src/realtime/cascaded/chat-completions-llm.js'
import {buildProductionRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js'

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> { const values:T[]=[]; for await(const item of items)values.push(item);return values }

const environment = {PIPELINE_MODE:'cascaded', CASCADE_ASR_PROVIDER:'self-hosted', CASCADE_LLM_PROVIDER:'self-hosted', CASCADE_TTS_PROVIDER:'self-hosted', CASCADE_LLM_MODEL:'served-model', SELF_HOSTED_ASR_URL:'ws://127.0.0.1:19101/asr', SELF_HOSTED_LLM_BASE_URL:'http://127.0.0.1:19102/v1', SELF_HOSTED_TTS_URL:'http://127.0.0.1:19103/tts'}

test('self-hosted selection uses only dedicated optional credentials and text starts without audio', async()=>{
  const settings=loadSettings({...environment,OPENAI_API_KEY:'cloud',GEMINI_API_KEY:'cloud',DOUBAO_BIGMODEL_API_KEY:'cloud',ARK_API_KEY:'cloud'})
  const selected=requireSelectedCascadedRealtimeConfig(settings)
  assert.equal(selected.asr.apiKey,'');assert.equal(selected.tts.apiKey,'');assert.equal(selected.llm.config.apiKey,'')
  assert.deepEqual(describeMissingBlockingCredentials(settings).missing,[])
  assert.throws(()=>requireSelectedCascadedLlmConfig(loadSettings({...environment,CASCADE_LLM_MODEL:''})),/CASCADE_LLM_MODEL/)
  const assembly=buildProductionRealtimeAssembly({settings:loadSettings({...environment,SELF_HOSTED_ASR_URL:'',SELF_HOSTED_TTS_URL:'',TAVILY_API_KEY:'test',CAMERA_MODULE_ENABLED:'false'}),textOnly:true})
  await assembly.provider.connect({tools:[],signal:new AbortController().signal})
  await assembly.stop()
})

test('endpoints reject remote cleartext and all embedded credentials, query, fragments',()=>{
  for(const value of ['http://localhost/v1','http://192.168.1.10/v1','http://2130706433/v1','https://user:secret@example.com/v1','https://example.com/v1?','https://example.com/v1#'])assert.throws(()=>selfHostedEndpoint(value,'http','TEST'))
  for(const value of ['http://127.0.0.1:8000/v1','http://[::1]:8000/v1','https://example.com/v1'])assert.equal(selfHostedEndpoint(value,'http','TEST'),value)
})

test('ASR negotiates 16 kHz, replaces partial hypotheses and final, bounds PCM, cancels',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening')
  const address=server.address();assert.notEqual(typeof address,'string');assert(address)
  const endpoint=`ws://127.0.0.1:${(address as {port:number}).port}/asr`
  const authorizations:(string|undefined)[]=[]
  server.on('connection',(socket,request)=>{
    authorizations.push(request.headers.authorization)
    socket.send(JSON.stringify({type:'ready',sampleRate:request.url === '/wrong' ? 24000 : 16000,format:'s16le'}))
    socket.on('message',(_data,binary)=>socket.send(JSON.stringify({text:binary?'par':'complete',final:!binary,replace:true})))
  })
  try{
    const session=await new SelfHostedAsrClient({endpoint,apiKey:''}).open()
    const transcripts=collect(session.events())
    await assert.rejects(()=>session.append(new Uint8Array(1)),/invalid ASR input/)
    await assert.rejects(()=>session.append(new Uint8Array(64002)),/invalid ASR input/)
    await session.append(new Uint8Array(320));await session.finish()
    assert.deepEqual(await transcripts,[{text:'par',final:false,replace:true},{text:'complete',final:true,replace:true}])
    await session.close();assert.deepEqual(authorizations,[undefined])
    const controller=new AbortController(),cancelled=await new SelfHostedAsrClient({endpoint,apiKey:'dedicated'}).open(controller.signal)
    const result=collect(cancelled.events());controller.abort()
    await assert.rejects(result);await cancelled.close();assert.equal(authorizations[1],'Bearer dedicated')
    await assert.rejects(()=>new SelfHostedAsrClient({endpoint:endpoint.replace('/asr','/wrong'),apiKey:''}).open(),/invalid ASR ready/)
  }finally{for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('ASR waits out a busy server for longer than one second, then gives up',async()=>{
  let connections=0,busyFor=12
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening')
  const address=server.address();assert.notEqual(typeof address,'string');assert(address)
  const endpoint=`ws://127.0.0.1:${(address as {port:number}).port}/asr`
  server.on('connection',socket=>{
    if(connections++<busyFor){socket.close(1013,'ASR busy');return}
    socket.send(JSON.stringify({type:'ready',sampleRate:16000,format:'s16le'}))
  })
  try{
    const session=await new SelfHostedAsrClient({endpoint,apiKey:''}).open()
    assert.equal(connections,busyFor+1);await session.close()
    connections=0;busyFor=Infinity
    const controller=new AbortController(),waiting=new SelfHostedAsrClient({endpoint,apiKey:''}).open(controller.signal)
    setTimeout(()=>controller.abort(),300);await assert.rejects(waiting)
  }finally{for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('TTS keeps Nova chunk boundaries, dedicated auth, redirects disabled, aligned bounded PCM',async()=>{
  const texts:string[]=[]
  const client=new SelfHostedTtsClient({endpoint:'http://127.0.0.1:19103/tts',apiKey:'dedicated',fetch:(_url,init)=>{
    const text=(init!.body as FormData).get('text');assert.equal(typeof text,'string');texts.push(text as string)
    assert.equal(new Headers(init!.headers).get('authorization'),'Bearer dedicated');assert.equal(init!.redirect,'error')
    return Promise.resolve(new Response(new Uint8Array([1,2,3,4]),{headers:{'content-type':'audio/pcm','x-sample-rate':'24000','x-sample-format':'s16le'}}))
  }})
  const session=await client.open(),audio=collect(session.events())
  const chunk='a'.repeat(300);await session.sendText(chunk);await session.finish()
  assert.deepEqual(texts,[chunk]);assert.deepEqual((await audio).map(x=>[...x.pcm]),[[1,2,3,4]])
  await session.close()
  const bad=await new SelfHostedTtsClient({endpoint:'http://127.0.0.1/tts',apiKey:'',fetch:()=>Promise.resolve(new Response(new Uint8Array([1]),{headers:{'content-type':'audio/pcm','x-sample-rate':'24000','x-sample-format':'s16le'}}))}).open()
  const error=assert.rejects(collect(bad.events()),/incomplete TTS audio/)
  await bad.sendText('bad');await assert.rejects(()=>bad.finish(),/incomplete TTS audio/);await error;await bad.close()
})

test('self-hosted LLM shares streaming protocol without cloud auth or provider-specific flags',async()=>{
  const session=createChatCompletionsLlmFactory({provider:'self-hosted',baseUrl:'http://127.0.0.1:19102/v1',apiKey:'',model:'served-model',instructions:'Be helpful',fetchImpl:(url,init)=>{
    assert.equal(url,'http://127.0.0.1:19102/v1/chat/completions');assert.equal(new Headers(init!.headers).get('authorization'),null);assert.equal(init!.redirect,'error')
    assert.equal(typeof init!.body,'string');const body=JSON.parse(init!.body as string) as {model:string;enable_thinking?:boolean;reasoning_effort?:string;messages:{role:string;content:string}[]};assert.equal(body.model,'served-model');assert.equal(body.enable_thinking,undefined);assert.equal(body.reasoning_effort,undefined);assert.equal(body.messages.filter((m:{role:string})=>m.role==='system').length,1);assert.match(body.messages[0]!.content,/host note/)
    return Promise.resolve(new Response('data: '+JSON.stringify({id:'r1',choices:[{delta:{content:'Hello'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'r1',choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}))
  }}).open()
  const events=await collect(session.stream({inputs:[{kind:'user_text',text:'Hi'},{kind:'host_context',content:'host note'}],tools:[],signal:new AbortController().signal}))
  assert(events.some(event=>event.kind==='text_delta'))
  await session.close()
})


test('self-hosted ASR, LLM and TTS refuse a redirect and never forward their bearer token', async()=>{
  const targetHits:string[]=[],originAuth:string[]=[]
  const listen=async(server:Server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as AddressInfo).port}
  const target=createServer((request,response)=>{targetHits.push(`${request.headers.authorization}`);response.writeHead(200).end()})
  const targetPort=await listen(target)
  const origin=createServer((request,response)=>{originAuth.push(`${request.headers.authorization}`);response.writeHead(302,{location:`http://127.0.0.1:${targetPort}/elsewhere`}).end()})
  const originPort=await listen(origin)
  try{
    const tts=await new SelfHostedTtsClient({endpoint:`http://127.0.0.1:${originPort}/tts`,apiKey:'tts-secret'}).open()
    const audio=assert.rejects(collect(tts.events()))
    await tts.sendText('hi');await assert.rejects(()=>tts.finish());await audio;await tts.close()
    const llm=createChatCompletionsLlmFactory({provider:'self-hosted',baseUrl:`http://127.0.0.1:${originPort}/v1`,apiKey:'llm-secret',model:'m',instructions:'x'}).open()
    const events=await collect(llm.stream({inputs:[{kind:'user_text',text:'Hi'}],tools:[],signal:new AbortController().signal})).catch(()=>[])
    assert(!events.some(event=>event.kind==='text_delta'))
    await llm.close()
    await assert.rejects(new SelfHostedAsrClient({endpoint:`ws://127.0.0.1:${originPort}/asr`,apiKey:'asr-secret'}).open())
    // Each client really reached the origin with its own token, and none of them followed it onward.
    assert.deepEqual([...new Set(originAuth)].sort(),['Bearer asr-secret','Bearer llm-secret','Bearer tts-secret'])
    assert.deepEqual(targetHits,[])
  }finally{origin.close();target.close()}
})

test('redirect rejection is scoped to self-hosted LLMs, cloud behavior is preserved', async()=>{
  for(const provider of ['qwen','self-hosted'] as const){
    const redirect=provider==='self-hosted'?'error':'follow'
    const session=createChatCompletionsLlmFactory({provider,baseUrl:'https://example.com/v1',apiKey:'test',model:'m',instructions:'Be helpful',fetchImpl:(_url,init)=>{
      assert.equal(init?.redirect,redirect)
      return Promise.resolve(new Response('data: '+JSON.stringify({id:'r',choices:[{delta:{content:'ok'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'r',choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}))
    }}).open()
    try{await collect(session.stream({inputs:[{kind:'user_text',text:'Hi'}],tools:[],signal:new AbortController().signal}))}finally{await session.close()}
    const gateway=new OpenAIModelGateway({baseUrl:'https://example.com/v1',apiKey:'test',clock:new VirtualClock(),...(provider==='self-hosted'?{redirect:'error' as const}:{}),fetch:(_url,init)=>{
      assert.equal(init?.redirect,redirect)
      return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}}))
    }})
    assert.equal((await gateway.complete({model:'m',system:'test',prompt:'hello'})).text,'ok')
  }
})
