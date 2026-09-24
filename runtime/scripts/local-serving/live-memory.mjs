// Uses real serving endpoints and an isolated ledger; never reads the user's memories.
import assert from 'node:assert/strict'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SubstrateMemoryResource} from '../../dist/src/memory-substrate/resource.js'
import {WorkspaceGraphStoreClient} from '../../dist/src/workspace-graph/store-client.js'
import {OpenAIModelGateway} from '../../dist/src/model/model-gateway.js'
import {DashScopeEmbeddingProvider} from '../../dist/src/knowledge/embeddings.js'
import {RealClock} from '../../dist/src/core/clock.js'
const directory=await mkdtemp(join(tmpdir(),'nova-local-memory-live-'))
const llm=process.env.LLM_BASE_URL??'http://127.0.0.1:18101/v1'
const embedding=new DashScopeEmbeddingProvider({baseUrl:process.env.EMBEDDING_BASE_URL??'http://127.0.0.1:18104/v1',apiKey:'local',model:'Qwen/Qwen3-Embedding-0.6B',dims:1024})
const metrics=[]
const gateway=new OpenAIModelGateway({baseUrl:llm,apiKey:'local',clock:new RealClock(),thinkingControl:'chat-template',metrics:{record:m=>metrics.push(m)}})
const create=()=>new SubstrateMemoryResource({client:new WorkspaceGraphStoreClient(join(directory,'ledger.sqlite')),userId:'synthetic-live-acceptance',gateway,model:'Qwen/Qwen3.5-4B',embedding,embeddingFingerprint:'local-embedding-live',extractionFingerprint:'local-extraction-live',conversationProviders:['local-conversation-live'],inputConsent:true,personalMemoryEnabled:true,consolidation:{enabled:false}})
let memory=create()
const result={directory,startedAt:new Date().toISOString(),metrics}
try{
 await memory.open()
 const vectors=await embedding.embed(['我喜欢茉莉花茶。','我偏爱茉莉茶。','量子计算使用量子比特。'])
 const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0)
 result.embedding={dimensions:vectors[0].length,similar:dot(vectors[0],vectors[1]),unrelated:dot(vectors[0],vectors[2])}
 assert.equal(vectors[0].length,1024);assert.ok(result.embedding.similar>result.embedding.unrelated)
 await memory.remember({sourceId:'synthetic-preference-1',sessionId:'live',sequence:1,text:'请记住，我最喜欢喝茉莉花茶。',confirmed:true,occurredAt:new Date().toISOString()})
 await memory.flush()
 result.extracted=(await memory.list()).entries
 assert.ok(result.extracted.some(e=>e.content.includes('茉莉')),'real extraction did not produce tea preference')
 result.recall=await memory.recall('我喜欢喝什么茶？',{scope:'any'})
 assert.equal(result.recall.degraded,false);assert.ok(result.recall.hits.some(h=>h.text.includes('茉莉')))
 await memory.close();memory=create();await memory.open()
 const entry=(await memory.list()).entries.find(e=>e.content.includes('茉莉'));assert.ok(entry,'ledger persistence')
 result.corrected=await memory.correct(entry.id,entry.version,'我最喜欢喝乌龙茶。',{type:'conversation',ref:'synthetic-correction',observed_at:new Date().toISOString()})
 assert.ok(result.corrected.entry.content.includes('乌龙'))
 await memory.forgetEntry(entry.id,result.corrected.entry.version)
 await memory.flush()
 result.afterForget=await memory.recall('喜欢喝什么茶',{scope:'any'})
 assert.ok(!result.afterForget.hits.some(h=>h.memoryId===entry.id),'forgotten memory still recalled')
 result.passed=true
}finally{
 await memory.close();await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}
