import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings} from '../src/config/config.js'
import {VirtualClock} from '../src/core/clock.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import type {CascadedLlmInput} from '../src/realtime/cascaded/llm.js'

test('production text factory only validates and constructs selected LLM with no speech credentials',async()=>{
 const settings={...loadSettings({DASHSCOPE_API_KEY:'test',CASCADE_LLM_PROVIDER:'qwen',PROMPT_LANGUAGE:'en'},true),doubao_tts_endpoint:'invalid',doubao_asr_endpoint:'invalid',volcengine_vad_threshold:-1}
 let sequence=0,opened=0,recalled=0,consumed=0,metered=0
 let adaptation:string|null|undefined
 const received:CascadedLlmInput[][]=[]
 const forbidden=()=>{throw new Error('audio initialized')}
 const provider=buildCascadedTextProvider({settings,clock:new VirtualClock(),idFactory:()=>`text-${++sequence}`,onUsage:()=>{metered++},prerecall:query=>{assert.equal(query,'question');recalled++;return Promise.resolve(()=>{consumed++;return Promise.resolve('verified memory context')})}},{
  ...cascadedProviderRegistries,
  endpointing:{auto:forbidden},asr:{volcengine:forbidden},tts:{volcengine:forbidden},
  llm:{...cascadedProviderRegistries.llm,qwen:factoryInput=>({open:()=>{opened++;return {
    async *stream(input){assert.equal(input.language,'en');adaptation=input.responseAdaptation;factoryInput.onUsage?.({id:'usage',service:'llm',provider:'qwen',model:'test',status:'complete',inputTokens:3,outputTokens:2});received.push([...input.inputs]);await Promise.resolve();yield {kind:'response_started',response_id:'r'};yield {kind:'text_delta',text:'reply'};yield {kind:'response_completed',response_id:'r'}},
    abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),
  }}})},
 })
 const signal=new AbortController().signal
 try {
  await provider.connect({tools:[],signal})
  const done=(async()=>{for await(const raw of provider.events(signal)){const event=raw as {kind:string;item_id?:string};if(event.kind==='user_transcript_final')await provider.ensureResponse?.(signal,event.item_id);if(event.kind==='response_terminal')return}})()
  assert(typeof provider.submitText==='function');await provider.submitText('question',signal);await done
  assert.equal(opened,1);assert.equal(recalled,1);assert.equal(consumed,1);assert.equal(metered,1);assert.match(adaptation??'',/^verified memory context\n/u);assert.deepEqual(received,[[{kind:'user_text',text:'question'}]])
 }finally{await provider.close()}
})

test('voice provider factory constructs only lazy provider resources and restores its conversation seed',async()=>{
 const {buildCascadedVoiceProvider}=await import('../src/conversation-voice-provider.js')
 let audioOpens=0
 const history=[{user:'question',assistant:'answer'}]
 const settings=loadSettings({PIPELINE_MODE:'cascaded',DASHSCOPE_API_KEY:'test',DOUBAO_BIGMODEL_API_KEY:'speech-test',CASCADE_LLM_PROVIDER:'qwen'})
 let seeded:unknown
 const provider=buildCascadedVoiceProvider({settings,clock:new VirtualClock(),idFactory:()=>crypto.randomUUID(),history},{
  ...cascadedProviderRegistries,
  endpointing:{auto:()=>()=>{audioOpens++;return Promise.resolve({reset:()=>undefined,feed:()=>Promise.resolve([]),close:()=>Promise.resolve()})}},
  asr:{volcengine:()=>({openClient:()=>{audioOpens++;return {open:()=>Promise.reject(new Error('unused'))}}})},
  tts:{volcengine:()=>({openClient:()=>{audioOpens++;return {open:()=>Promise.reject(new Error('unused'))}}})},
  llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:input=>{seeded=input?.history;return {async *stream(){await Promise.resolve()},abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve()}}})},
 })
 try {assert.equal(audioOpens,0);await provider.connect({tools:[],signal:new AbortController().signal});assert.equal(audioOpens,3);assert.deepEqual(seeded,history)}finally{await provider.close()}
})

test('integrated voice keeps the explicitly selected text LLM and ledger path', async () => {
 const {requireSelectedCascadedLlmConfig}=await import('../src/config/cascaded-realtime-config.js')
 const settings=loadSettings({PIPELINE_MODE:'integrated',DASHSCOPE_API_KEY:'voice-key',
  CASCADE_LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'text-key',
  MEMORY_LEDGER_PATH:'/tmp/new-ledger.sqlite',WORKSPACE_GRAPH_PATH:'/tmp/legacy-ledger.sqlite'},true)
 assert.equal(settings.pipeline_mode,'integrated')
 assert.equal(settings.workspace_graph_path,'/tmp/new-ledger.sqlite')
 const selected=requireSelectedCascadedLlmConfig(settings)
 assert.equal(selected.provider,'deepseek');assert.equal(selected.config.apiKey,'text-key')
 assert.equal(loadSettings({WORKSPACE_GRAPH_PATH:'/tmp/legacy-ledger.sqlite'}).workspace_graph_path,'/tmp/legacy-ledger.sqlite')
})
