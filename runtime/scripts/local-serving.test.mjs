import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings, requirePersonalMemory} from '../dist/src/config/config.js'
import {requireSelectedCascadedLlmConfig} from '../dist/src/config/cascaded-realtime-config.js'
const profile = {llm:{baseUrl:'http://127.0.0.1:18101/v1',model:'Qwen/Qwen3.5-4B'},asr:{endpoint:'http://127.0.0.1:18102/v1/audio/transcriptions',referenceAudio:'/tmp/reference.wav'},tts:{endpoint:'http://127.0.0.1:18103/v1/audio/speech'},embedding:{baseUrl:'http://127.0.0.1:18104/v1',model:'Qwen/Qwen3-Embedding-0.6B'}}
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

test('HTTP adapters preserve final ASR and streaming PCM across odd chunks',async()=>{
 const {CocktailAsrClient,BreezeTtsClient}=await import('../dist/src/realtime/cascaded/http-speech.js')
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises')
 const path=await mkdtemp('/tmp/nova-speech-test-')
 try{
  await writeFile(`${path}/reference.wav`,Buffer.alloc(48))
  const asr=await new CocktailAsrClient({...profile.asr,referenceAudio:`${path}/reference.wav`,apiKey:'',fetch:async(_url,init)=>{
   assert.equal(init.redirect,'error'); assert.ok(init.body.get('reference_audio'))
   const wav=Buffer.from(await init.body.get('file').arrayBuffer()); assert.equal(wav.toString('ascii',0,4),'RIFF')
   return Response.json({text:''})
  }}).open()
  const reading=Array.fromAsync(asr.events())
  await asr.append(new Uint8Array(320));await asr.finish()
  assert.deepEqual(await reading,[{text:'',final:true}]);await asr.close()
  let calls=0
  const tts=await new BreezeTtsClient({...profile.tts,instruction:'clear',apiKey:'',fetch:async()=>{
   calls++;return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.enqueue(new Uint8Array([4]));c.close()}}),{headers:{'content-type':'audio/pcm','x-sample-rate':'24000','x-sample-format':'s16le'}})
  }}).open()
  const audio=Array.fromAsync(tts.events());await tts.sendText('你好。');await tts.finish()
  assert.deepEqual([...Buffer.concat((await audio).map(x=>Buffer.from(x.pcm)))],[1,2,3,4]);assert.equal(calls,1);await tts.close()
 }finally{await rm(path,{recursive:true,force:true})}
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

test('ASR finish submits without blocking the next speech admission',async()=>{
 const {CocktailAsrClient}=await import('../dist/src/realtime/cascaded/http-speech.js')
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises')
 const path=await mkdtemp('/tmp/nova-asr-admission-')
 let release
 const pending=new Promise(resolve=>{release=resolve})
 let session
 try{
  await writeFile(`${path}/ref.wav`,Buffer.alloc(48))
  session=await new CocktailAsrClient({...profile.asr,referenceAudio:`${path}/ref.wav`,apiKey:'',fetch:async()=>{await pending;return Response.json({text:'late'})}}).open()
  await session.append(new Uint8Array(320))
  const submitted=await Promise.race([session.finish().then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),30))])
  assert.equal(submitted,true,'finish must not wait for model inference')
 }finally{release();await session?.close();await rm(path,{recursive:true,force:true})}
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
