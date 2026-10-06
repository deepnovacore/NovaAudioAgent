import assert from 'node:assert/strict'
import {mkdtemp, realpath, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {loadSettings, resolveModelApiKey} from '../../dist/src/config/config.js'
import {OpenAIModelGateway} from '../../dist/src/model/model-gateway.js'
import {RealClock} from '../../dist/src/core/clock.js'
import {DashScopeEmbeddingProvider} from '../../dist/src/knowledge/embeddings.js'
import {MemoryLedgerClient} from '../../dist/src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../../dist/src/memory-substrate/resource.js'

// Only synthetic facts leave this process. Never opens the user's memory database.
const settings=loadSettings(), apiKey=resolveModelApiKey(settings)
assert.ok(apiKey,'Configured model API key required')
const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-memory-live-'))
const path=join(directory,'memory.sqlite'), metrics=[]
const gateway=new OpenAIModelGateway({baseUrl:settings.model_base_url,apiKey,clock:new RealClock(),metrics:{record:m=>metrics.push(m)}})
const embedding=new DashScopeEmbeddingProvider({baseUrl:settings.model_base_url,apiKey,model:settings.embedding_model})
let shutdown
async function create() {
 if(!process.argv.includes('--production'))return new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId:'synthetic-live',gateway,model:settings.fast_model,embedding})
 const {buildProductionComposition}=await import('../../dist/src/composition/production-composition.js')
 const capabilities=join(directory,'capabilities.json')
 await writeFile(capabilities,JSON.stringify({version:1,modules:{search:{enabled:false},coding:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}}))
 const cleanup=new Set(),stop=new AbortController()
 const composition=await buildProductionComposition({token:'a'.repeat(32),stop,ownership:{own:fn=>{cleanup.add(fn);return ()=>cleanup.delete(fn)}},onDiagnostic:()=>{},environment:{...process.env,PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'deepseek',MEMORY_CONNECTION:'local',MEMORY_LEDGER_PATH:path,MEMORY_PATH:join(directory,'legacy.sqlite'),MEMORY_USER_ID:'synthetic-live',BLACKBOARD_PATH:join(directory,'blackboard.sqlite'),CAPABILITIES_CONFIG:capabilities,REALTIME_TELEMETRY:'',CODEX_WORKSPACE:directory,CODEX_MANAGED_ROOT:directory,CODEX_PROJECT_STATE_ROOT:directory,COMPOSIO_API_KEY:""}})
 await composition.realtime.start()
 shutdown=async()=>{stop.abort();await composition.realtime.stop();for(const fn of [...cleanup].reverse())await fn()}
 assert.ok(composition.realtime.personalMemory instanceof SubstrateMemoryResource)
 return composition.realtime.personalMemory
}
let memory=await create()
const close=async()=>{if(shutdown){const stop=shutdown;shutdown=null;await stop()}else await memory.close()}
const report={mode:process.argv.includes('--production')?'production-composition':'resource',model:settings.fast_model,embedding:settings.embedding_model,checks:[]}
const pass=name=>{report.checks.push(name);console.log('PASS',name)}
try {
 await memory.open()
 const input={sourceId:'synthetic-mail',locator:'synthetic://mail/one',kind:'mail',observedAt:new Date().toISOString(),text:'我负责虚构的青瓷海鸥项目。该项目的验收暗号是紫色风铃7319。请长期记住：我希望项目周报先列风险，再列进展。'}
 await memory.ingestEvidence(input);await memory.flush()
 assert.equal(metrics.length,0);assert.equal((await memory.list()).entries.length,0)
 pass('consent_off_no_extraction')
 await memory.ingestEvidence({...input,embeddingConsent:true,processingConsent:memory.processingGrant(true)})
 await memory.flush()
 const entries=(await memory.list()).entries
 assert.ok(entries.length>0,'Real extraction produced no entries')
 pass('real_model_extraction')
 const recall=await memory.recall('那个虚构项目的验证口令是什么？',{scope:'any'})
 assert.equal(recall.degraded,false,'Vector retrieval degraded')
 assert.ok(recall.hits.some(h=>h.text.includes('7319')),'Semantic recall missed synthetic fact')
 const evidence=await memory.readEvidence(recall.hits.find(h=>h.text.includes('7319')).evidenceIds[0])
 assert.equal(evidence.text,input.text)
 pass('real_embedding_semantic_recall_and_evidence')
 const response=await gateway.complete({model:settings.fast_model,system:'仅根据给定检索证据回答问题。返回 JSON，字段 answer 和 evidence_id。evidence_id 必须取自给定证据；没有证据就说不知道。',prompt:JSON.stringify({question:'青瓷海鸥的验收暗号是什么？',evidence}),jsonSchema:{type:'object',properties:{answer:{type:'string'},evidence_id:{type:'string'}},required:['answer','evidence_id'],additionalProperties:false},signal:AbortSignal.timeout(20000)})
 const answer=JSON.parse(response.text)
 assert.ok(answer.answer.includes('7319'));assert.equal(answer.evidence_id,evidence.evidence_id)
 pass('real_model_answer_with_valid_evidence_id')
 await close()
 const db=new DatabaseSync(path,{readOnly:true})
 report.vectors=db.prepare('SELECT count(*) n FROM memory_vectors').get().n
 report.extractions=db.prepare('SELECT count(*) n FROM memory_extractions').get().n
 db.close();assert.ok(report.vectors>0);assert.ok(report.extractions>0)
 memory=await create();await memory.open()
 assert.ok((await memory.recall('青瓷海鸥验收暗号',{scope:'any'})).hits.some(h=>h.text.includes('7319')))
 pass('restart_persistence')
 await memory.forgetSource(input.sourceId)
 assert.equal((await memory.recall('青瓷海鸥验收暗号',{scope:'any'})).hits.length,0)
 assert.equal(await memory.readEvidence(evidence.evidence_id),null)
 pass('source_deletion_invalidates_recall_and_evidence')
} catch(error) {
 report.failure=error instanceof assert.AssertionError?error.message:error.name
 process.exitCode=1;console.error('FAIL',report.failure)
} finally {
 await close()
 report.directGatewayCalls=metrics.length
 await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2),{mode:0o600})
 console.log('Evidence:',join(directory,'result.json'))
}
