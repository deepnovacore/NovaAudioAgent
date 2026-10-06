/* eslint-disable @typescript-eslint/require-await -- Fetch doubles implement the asynchronous network boundary. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createGeminiAsrFactory, createGeminiTtsFactory} from '../src/realtime/cascaded/gemini-speech.js'
const config={endpoint:'https://generativelanguage.googleapis.com/v1beta',apiKey:'synthetic-secret',model:'test-model',voice:'Kore'}
const response=(parts:unknown[])=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts}}]}))

test('Gemini ASR sends buffered audio only at finish and returns a final transcript',async()=>{
 let calls=0
 const session=await createGeminiAsrFactory({...config,fetchImpl:async(_url,init)=>{
  calls++;assert.equal(typeof init?.body,'string');const body=JSON.parse(init!.body as string) as {contents:{parts:{text?:string;inlineData:{data:string}}[]}[];generationConfig:{speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:string}}}}}
  assert.equal(new Headers(init?.headers).get('x-goog-api-key'),'synthetic-secret')
  const wav=Buffer.from(body.contents[0]!.parts[1]!.inlineData.data,'base64')
  assert.equal(wav.readUInt32LE(24),16000);assert.deepEqual([...wav.subarray(44)],[1,0,2,0])
  return response([{text:'private thought',thought:true},{text:'你好'}])
 }}).openClient().open()
 await session.append(Uint8Array.of(1,0));await session.append(Uint8Array.of(2,0));assert.equal(calls,0)
 const read=collect(session.events());await session.finish()
 assert.deepEqual(await read,[{text:'你好',final:true}]);await session.close()
})
test('Gemini ASR treats a candidate without parts as silence instead of a provider error',async()=>{
 const session=await createGeminiAsrFactory({...config,fetchImpl:async()=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{role:'model'}}]}))}).openClient().open()
 await session.append(Uint8Array.of(1,0));const read=collect(session.events());await session.finish()
 assert.deepEqual(await read,[{text:'',final:true}]);await session.close()
})
test('Gemini TTS sends only host text segments and decodes PCM without speaking control prompts',async()=>{
 const session=await createGeminiTtsFactory({...config,fetchImpl:async(_url,init)=>{
  assert.equal(typeof init?.body,'string');const body=JSON.parse(init!.body as string) as {contents:{parts:{text?:string;inlineData:{data:string}}[]}[];generationConfig:{speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:string}}}}};assert.equal(body.contents[0]!.parts[0]!.text,'Hello world.')
  assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Kore')
  return response([{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AQACAA=='}}])
 }}).openClient().open()
 await session.sendText('Hello world.');const read=collect(session.events());await session.finish()
 assert.deepEqual((await read).map(e=>[...e.pcm]),[[1,0,2,0]])
 await session.close()
})
test('Gemini TTS cancellation aborts an in-flight request and emits no late audio',async()=>{
 let release!:(r:Response)=>void;let started!:()=>void;const began=new Promise<void>(r=>started=r);let requestSignal:AbortSignal|undefined|null
 const session=await createGeminiTtsFactory({...config,fetchImpl:async(_url,init)=>{requestSignal=init?.signal;started();return new Promise<Response>(r=>release=r)}}).openClient().open()
 const read=collect(session.events());const finish=session.sendText('hello').catch(()=>undefined)
 await began;await session.cancel();release(response([{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AQACAA=='}}]))
 await finish;assert.equal(requestSignal?.aborted,true);assert.deepEqual(await read,[])
})
test('Gemini speech rejects malformed audio and redacts provider failure bodies',async()=>{
 const session=await createGeminiAsrFactory({...config,fetchImpl:async()=>new Response('synthetic-secret',{status:403})}).openClient().open()
 await assert.rejects(session.append(Uint8Array.of(1)))
 await session.append(Uint8Array.of(1,0));await assert.rejects(session.finish(),e=>e instanceof Error&&!e.message.includes('synthetic-secret'))
 await assert.rejects(collect(session.events()));await session.close()
 const tts=await createGeminiTtsFactory({...config,fetchImpl:async()=>response([{inlineData:{mimeType:'audio/pcm;rate=16000',data:'AQACAA=='}}])}).openClient().open()
 await assert.rejects(tts.sendText('test'));await tts.close()
})

async function collect<T>(events:AsyncIterable<T>):Promise<T[]> {const result:T[]=[];for await(const event of events)result.push(event);return result}

test('Gemini TTS strips WAV headers and reports usage for the actual synthesis',async()=>{
 const reports:unknown[]=[]
 const wav=Buffer.from('524946462800000057415645666d74201000000001000100c05d000080bb000002001000646174610400000001000200','hex')
 const session=await createGeminiTtsFactory({...config,onUsage:r=>reports.push(r),fetchImpl:async()=>response([{inlineData:{mimeType:'audio/wav',data:wav.toString('base64')}}])}).openClient().open()
 await session.sendText('Hello');const read=collect(session.events());await session.finish()
 assert.deepEqual((await read).map(e=>[...e.pcm]),[[1,0,2,0]])
 assert.equal(reports.length,1);assert.equal((reports[0] as {service:string}).service,'tts')
 await session.close()
})

test('Gemini ASR close releases an event reader before finish without making a request',async()=>{
 const session=await createGeminiAsrFactory({...config,fetchImpl:async()=>{throw Error('unexpected network')}}).openClient().open()
 await session.append(Uint8Array.of(1,0));const read=collect(session.events());await session.close();assert.deepEqual(await read,[])
 await assert.rejects(session.finish())
})

test('Gemini TTS produces the first host text segment before response finish',async()=>{
 const session=await createGeminiTtsFactory({...config,fetchImpl:async()=>response([{inlineData:{mimeType:'audio/L16;codec=pcm;rate=24000',data:'AQACAA=='}}])}).openClient().open()
 const events=session.events()[Symbol.asyncIterator]();const next=events.next()
 try {
  await session.sendText('Hello world.')
  const first=await Promise.race([next,new Promise<undefined>(r=>setTimeout(()=>r(undefined),100))])
  assert.deepEqual(first && !first.done ? [...first.value.pcm] : undefined,[1,0,2,0])
 }finally{await session.close();await next.catch(()=>undefined)}
})

test('Gemini ASR empty audio still completes with an empty final instead of a provider fault',async()=>{
 const session=await createGeminiAsrFactory({...config,fetchImpl:async()=>{throw Error('unexpected network')}}).openClient().open()
 const read=collect(session.events());await session.finish()
 assert.deepEqual(await read,[{text:'',final:true}]);await session.close()
})
