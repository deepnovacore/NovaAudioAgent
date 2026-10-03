import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings} from '../src/config/config.js'
import {buildProductionRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'

test('desktop text graph connects without speech credentials or initializing audio or model requests',async()=>{
 let opens=0,audio=0,requests=0
 const unavailable=()=>{audio++;throw Error('audio factory must remain lazy')}
 const settings=loadSettings({PIPELINE_MODE:'integrated',CASCADE_LLM_PROVIDER:'qwen',DASHSCOPE_API_KEY:'test-only',TAVILY_API_KEY:'test-only'},true)
 const assembly=buildProductionRealtimeAssembly({settings,textOnly:true,registries:{...cascadedProviderRegistries,asr:{volcengine:unavailable},tts:{volcengine:unavailable},endpointing:{auto:unavailable},llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>{opens++;return {stream:()=>{requests++;throw Error('unexpected model request')},abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve()}}})}}})
 assert.equal(audio,0);assert.equal(requests,0)
 const signal=new AbortController().signal
 await assembly.provider.connect({tools:[],signal})
 assert(opens>0);assert.equal(audio,0);assert.equal(requests,0)
 assert.equal(typeof assembly.provider.transcribeDraft,'function')
 await assert.rejects(async()=>assembly.provider.transcribeDraft!(new Uint8Array(320),signal),/DOUBAO_ASR_API_KEY/)
 assert.equal(audio,0)
 await assembly.stop()
})

test('actual desktop production composition starts with text credentials only and canonical private storage',async()=>{
 const {mkdtemp,realpath,writeFile,rm}=await import('node:fs/promises')
 const os=await import('node:os')
 const path=await import('node:path')
 const {buildProductionComposition}=await import('../src/composition/production-composition.js')
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'nova-text-composition-'))
 const stop=new AbortController(),cleanups=new Set<()=>void|Promise<void>>()
 let composition:Awaited<ReturnType<typeof buildProductionComposition>>|undefined
 try{
  const capabilities=path.join(dir,'capabilities.json')
  await writeFile(capabilities,JSON.stringify({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:false}}}))
  composition=await buildProductionComposition({token:'00000000000000000000000000000000',stop,ownership:{own:cleanup=>{cleanups.add(cleanup);return()=>{cleanups.delete(cleanup)}}},onDiagnostic:()=>{/* no external logging */},environment:{
   DASHSCOPE_API_KEY:'synthetic-text-key',PIPELINE_MODE:'integrated',CAPABILITIES_CONFIG:capabilities,
   REALTIME_TELEMETRY:path.join(dir,'telemetry.jsonl'),BLACKBOARD_PATH:path.join(dir,'blackboard.sqlite'),MEMORY_PATH:path.join(dir,'memory.sqlite'),WORKSPACE_GRAPH_PATH:path.join(dir,'workspace.sqlite'),
  }})
  await composition.realtime.start()
  assert.equal(composition.realtime.provider.constructor.name,'CascadedRealtimeAdapter')
  assert.equal(composition.realtime.personalAgent.conversationSnapshot().voice_id,null)
 }finally{stop.abort();await composition?.realtime.stop();for(const cleanup of [...cleanups].reverse())await cleanup();await rm(dir,{recursive:true,force:true})}
})
