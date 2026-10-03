import assert from 'node:assert/strict'
import {mkdtemp,realpath,writeFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import {parseArgs} from 'node:util'
import {createHash} from 'node:crypto'
import {loadSettings,resolveModelApiKey} from '../../dist/src/config/config.js'
import {OpenAIModelGateway} from '../../dist/src/model/model-gateway.js'
import {RealClock} from '../../dist/src/core/clock.js'
import {MemoryLedgerClient} from '../../dist/src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../../dist/src/memory-substrate/resource.js'
import {UnifiedRetrieval} from '../../dist/src/memory/retrieval.js'

const {values}=parseArgs({options:{module:{type:'string',default:'architecture'}}})
assert.ok(['architecture','daily','reading'].includes(values.module),'Unknown memory module')
// Every module owns a new synthetic ledger; never resolve a user's data paths from settings.
const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-memory-'+values.module+'-'))
const path=join(directory,'synthetic.sqlite'),output=resolve(process.env.NOVA_LIVE_MODULE_REPORT??join(directory,'result.json'))
const report={version:1,module:'memory-'+values.module,layer:'model-runtime',synthetic:true,started_at:new Date().toISOString(),status:'running',coverage:['Temporary synthetic SQLite/Markdown/Git','Real configured model','No GUI, physical voice, personal data, connectors or release acceptance'],checks:[],turns:[],calls:[],snapshots:[],data_directory:directory}
const persist=async()=>{await mkdir(dirname(output),{recursive:true,mode:0o700});await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600})}
const pass=async name=>{report.checks.push(name);console.log('PASS',name);await persist()}
let client,memory,settings,fingerprint,gateway
const open=async daily=>{client=new MemoryLedgerClient(path);memory=new SubstrateMemoryResource({client,userId:'synthetic-architecture',gateway,model:settings.fast_model,extractionFingerprint:fingerprint,inputConsent:true,conversationProviders:[fingerprint],consolidation:{enabled:daily}});await memory.open();await memory.flush()}
const restart=async daily=>{await memory.close();await open(daily)}
const snapshot=async label=>{const entries=(await memory.list()).entries;report.snapshots.push({label,entries,rows:await client.memory('list',{include_history:true}),reading:(await memory.prepareResponseAdaptation(fingerprint)).memoryContext});await persist();return entries}
const remember=async(id,text)=>{report.turns.push({id,text});await memory.remember({sourceId:id,sessionId:'synthetic',sequence:report.turns.length,text,occurredAt:new Date().toISOString(),confirmed:true});await memory.flush()}
async function seed(text){
 const at=new Date().toISOString(),id=memory.prefix+'seed',evidenceId=memory.prefix+'e:seed',sourceId=memory.prefix+'s:seed'
 await client.memory('append_evidence',{id:evidenceId,source_id:sourceId,source_kind:'conversation',locator:'synthetic:seed',observed_at:at,recorded_at:at,raw_text:text,hash:createHash('sha256').update(text).digest('hex'),trust:'trusted_user'})
 await memory.setProcessingConsent(sourceId,memory.processingGrant(true))
 await client.memory('record_extraction',{evidence_id:evidenceId,attempt_id:'synthetic-fixture',extracted:{synthetic_seed:true}})
 await client.memory('merge',{entry_id:id,kind:'preference',origin:'stated',written_by:'merge',evidence_refs:[evidenceId],content:{text,topic:'饮食偏好'},recorded_at:at})
 report.seed='Explicit synthetic fixture through the production worker merge; not model extraction'
 return id
}
async function architecture(){
 await open(false)
 await remember('first','我的饮食偏好是：我不吃辣。')
 const initial=await snapshot('initial');assert.equal(initial.length,1,'Expected one extracted dietary preference');const id=initial[0].id;await pass('initial preference admitted with evidence')
 await remember('paraphrase','换个说法，我平时会避开辣味的菜，饮食不放辣椒。')
 const paraphrase=await snapshot('paraphrase');assert.equal(paraphrase.length,1,'Paraphrase duplicated the entry');assert.equal(paraphrase[0].id,id);assert.equal(paraphrase[0].version,initial[0].version,'Equivalent paraphrase should be a no-change decision');await pass('paraphrase resolves same ID without revision')
 await remember('temporal','我的饮食偏好有一个暂时变化：接下来七天可以吃一点辣。')
 const temporal=await snapshot('temporal');assert.equal(temporal.length,1);assert.equal(temporal[0].id,id);assert.ok(temporal[0].version>paraphrase[0].version);const current=(await client.memory('list',{})).find(row=>row.entry_id===id);assert.ok(current.valid_until);await pass('temporal change updates same ID with bounded validity')
 await memory.correct(id,temporal[0].version,'医生要求：不吃辣。',{type:'conversation',ref:'synthetic-correction',observed_at:new Date().toISOString()})
 const corrected=await snapshot('correction');assert.equal(corrected[0].origin,'stated')
 await remember('contradiction','我的饮食偏好是喜欢吃辣，辣味食物都喜欢。')
 const protectedRows=await snapshot('correction-priority');assert.equal(protectedRows.length,1);assert.equal(protectedRows[0].content,'医生要求：不吃辣。');assert.equal(protectedRows[0].version,corrected[0].version);await pass('automatic key drift cannot bypass user correction')
 await restart(false)
 const restarted=await snapshot('restart');assert.equal(restarted[0].id,id);assert.equal(restarted[0].version,corrected[0].version);assert.equal(restarted[0].content,'医生要求：不吃辣。');await pass('restart retains corrected ID and version')
 await restart(true)
 const daily=(await client.memory('list',{})).filter(row=>row.kind==='memory_summary');assert.equal(daily.length,1);assert.equal(daily[0].origin,'inferred');assert.ok(daily[0].content.basis.some(ref=>ref.id===id&&ref.revision===corrected[0].version));await snapshot('daily');await pass('daily derived summary cites current corrected revision')
}
async function daily(){
 await open(false);const id=await seed('我的饮食偏好：不吃辣。');await restart(true)
 const rows=await client.memory('list',{}),summary=rows.find(row=>row.kind==='memory_summary'),explicit=rows.find(row=>row.entry_id===id)
 assert.ok(summary,'Real daily synthesis failed');assert.equal(summary.origin,'inferred');assert.equal(explicit.origin,'stated');assert.equal(explicit.content.text,'我的饮食偏好：不吃辣。');assert.ok(summary.content.basis.some(ref=>ref.id===id&&ref.revision===1));await pass('real synthesis references explicit facts without rewriting them')
 const before=report.calls.length;await restart(true);assert.equal(report.calls.length,before);await pass('same-day restart does not regenerate a successful daily summary')
 await memory.correct(id,1,'纠正：现在可以吃一点辣。',{type:'conversation',ref:'daily-correction',observed_at:new Date().toISOString()})
 const current=await snapshot('daily-invalidated');assert.equal(current.find(row=>row.id===id).version,2)
 const reading=await memory.prepareResponseAdaptation(fingerprint);assert.ok(reading.memoryContext.voice.includes('现在可以吃一点辣'));assert.ok(!reading.memoryContext.voice.includes('One-page summary (inferred)'));assert.equal(report.calls.length,before);await pass('correction immediately invalidates old derived summary and uses current facts')
}
async function reading(){
 await open(false);const id=await seed('我的饮食偏好：不吃辣。')
 const retrieval=new UnifiedRetrieval({memory:()=>memory})
 async function answer(expected){
  const adaptation=await memory.prepareResponseAdaptation(fingerprint)
  assert.ok(adaptation.memoryContext.text.includes('Use memory__recall'));assert.ok(adaptation.memoryContext.voice.length<=4000)
  const recalled=await retrieval.recall('饮食偏好',{consumer:fingerprint});assert.equal(recalled.state,'ok');assert.ok(recalled.entries.some(row=>row.entry_id===id))
  const response=await gateway.complete({model:settings.fast_model,system:'这是合成记忆验收。只根据给定最新资料判断吃辣偏好，none=不吃辣，small=可吃一点辣。返回JSON {spicy:"none"|"small",entry_id:string}，entry_id必须逐字复制recalled数组中的entry_id字段，不是reference字段，不得追加@revision。不得编造。',prompt:JSON.stringify({voice:adaptation.memoryContext.voice,recalled:recalled.entries}),jsonSchema:{type:'object',properties:{spicy:{type:'string',enum:['none','small']},entry_id:{type:'string',enum:recalled.entries.map(row=>row.entry_id)}},required:['spicy','entry_id'],additionalProperties:false},signal:AbortSignal.timeout(30000)})
  const result=JSON.parse(response.text);assert.equal(result.spicy,expected);assert.equal(result.entry_id,id);return recalled
 }
 await answer('none');await pass('real model reads current authorized text recall and bounded voice facts')
 await memory.correct(id,1,'纠正：现在可以吃一点辣。',{type:'conversation',ref:'reading-correction',observed_at:new Date().toISOString()});await restart(false)
 const cached=await answer('small');await pass('new resource session answers from the correction with stable object identity')
 const calls=report.calls.length;assert.equal((await memory.prepareResponseAdaptation('wrong-recipient')).memoryContext.voice,'');assert.equal((await retrieval.recall('饮食偏好',{consumer:'wrong-recipient'})).entries.length,0)
 const current=(await client.memory('list',{})).find(row=>row.entry_id===id)
 for(const ref of current.evidence_refs){const e=await client.memory('evidence',{id:ref});await memory.setProcessingConsent(e.source_id,memory.processingGrant(false,2))}
 assert.equal((await memory.prepareResponseAdaptation(fingerprint)).memoryContext.voice,'');assert.equal((await retrieval.revalidate(cached,new AbortController().signal)).entries.length,0);assert.equal(report.calls.length,calls);await pass('wrong recipient and revocation block model-facing memory without another model call')
 await snapshot('revoked')
}
try{
 await persist();settings=loadSettings();const key=resolveModelApiKey(settings)
 if(!key){report.status='blocked';report.reason='missing_model_credential';process.exitCode=2}
 else{
  report.model=settings.fast_model
  const model=new OpenAIModelGateway({baseUrl:settings.model_base_url,apiKey:key,clock:new RealClock(),metrics:{record(){}}})
  gateway={stream:request=>model.stream(request),async complete(request){const start=Date.now();try{const response=await model.complete(request);report.calls.push({input:JSON.parse(request.prompt),output:response.text,elapsed_ms:Date.now()-start});await persist();return response}catch(error){report.calls.push({elapsed_ms:Date.now()-start,error:error.name});await persist();throw error}}}
  fingerprint=createHash('sha256').update(settings.model_base_url+'\n'+settings.fast_model).digest('hex')
  await ({architecture,daily,reading})[values.module]();report.status='passed'
 }
}catch(error){report.status='failed';report.failure=error instanceof assert.AssertionError?error.message:error.name;process.exitCode=1;console.error('FAIL',report.failure)}finally{
 try{await memory?.close()}catch{report.status='failed';report.failure='cleanup_failed';process.exitCode=1}
 report.finished_at=new Date().toISOString();await persist();console.log('Synthetic evidence:',output)
}
