// Synthetic host + Substrate acceptance. This never resolves user storage paths.
import assert from 'node:assert/strict'
import {mkdtemp,realpath,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve,join,dirname} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {loadSettings,resolveModelApiKey} from '../../dist/src/config/config.js'
import {OpenAIModelGateway} from '../../dist/src/model/model-gateway.js'
import {RealClock} from '../../dist/src/core/clock.js'
import {MemoryLedgerClient} from '../../dist/src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../../dist/src/memory-substrate/resource.js'
import {createUnderstandingPipeline} from '../../dist/src/understanding/pipeline.js'
import {createJevJudge} from '../../dist/src/understanding/jev.js'
import {PersonalAgentHost} from '../../dist/src/personal-agent/host.js'
import {SuggestionPool} from '../../dist/src/core/suggestions.js'

const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-life-cross-turn-'))
const output=resolve(process.env.NOVA_LIVE_MODULE_REPORT??(process.argv[2]?join(process.argv[2],'report.json'):join(directory,'report.json')))
const anchor='2026-09-21T02:00:00.000Z',timezone='Asia/Shanghai'
let instant=Date.parse(anchor),host,memory,client,settings,gateway,pipeline,fingerprint
const secrets=[]
const sanitize=text=>secrets.reduce((value,secret)=>secret?value.replaceAll(secret,'[redacted]'):value,String(text))
const report={version:1,module:'personal-understanding',layer:'model-runtime',synthetic:true,status:'running',started_at:new Date().toISOString(),time_anchor:{observed_at:anchor,timezone,local_time:'2026-09-21 10:00:00',tomorrow:'2026-09-22',day_after_tomorrow:'2026-09-23'},data_directory:directory,coverage:['Real configured extraction/resolution model and Jev judgments','Production PersonalAgentHost, LifeService and Substrate SQLite/Markdown/Git in a fresh temporary directory','Conversation reply is a fixed acknowledgement; not a generated conversation, GUI, microphone, connector or release acceptance'],checks:[],turns:[],evaluations:[],calls:[],snapshots:[]}
const persist=async()=>{await mkdir(dirname(output),{recursive:true,mode:0o700});await writeFile(output,sanitize(JSON.stringify(report,null,2))+'\n',{mode:0o600})}
const pass=async label=>{report.checks.push(label);await persist();console.log('PASS',label)}
const command=async(method,params)=>{const result=await host.command({type:'personal.command',request_id:randomUUID(),method,params});assert.equal(result.ok,true,JSON.stringify(result));return result.data}
async function open(){
 client=new MemoryLedgerClient(join(directory,'synthetic.sqlite'))
 memory=new SubstrateMemoryResource({client,userId:'synthetic-life-cross-turn',gateway,model:settings.fast_model,extractionFingerprint:fingerprint,inputConsent:true,conversationProviders:[fingerprint],consolidation:{enabled:false}})
 await memory.open()
 host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'synthetic-life-cross-turn',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,now:()=>new Date(instant),understand:async(source,signal)=>{
  const start=Date.now(),evaluation={source,started_at:new Date().toISOString()};report.evaluations.push(evaluation);await persist()
  try{const rows=await pipeline(source,signal);evaluation.rows=rows;return rows}catch(error){evaluation.error=sanitize(error.message);throw error}finally{evaluation.elapsed_ms=Date.now()-start;await persist()}
 }})
 await host.open()
 await command('discovery.configure',{enabled:false,timezone,briefing_outlook_enabled:false,briefing_review_enabled:false})
 host.setConversationRuntime(async()=>({runTurn:async()=>({assistant:'收到。'}),close:async()=>{}}),()=>{})
}
async function snapshot(label){
 await memory.flush()
 const life=host.life.snapshot(),rows=await client.memory('list',{include_history:true})
 const evidence=[]
 for(const id of new Set(rows.flatMap(row=>row.evidence_refs))){const value=await client.memory('evidence',{id});if(value)evidence.push(value)}
 report.snapshots.push({label,life,rows,evidence});await persist();return life
}
async function turn(label,text){
 instant+=60000
 const item={label,text,observed_at:new Date(instant).toISOString(),timezone};report.turns.push(item);await persist()
 const start=Date.now();await host.submitConversationText('chat:main',text,randomUUID())
 while(host.understanding.snapshot().status==='working'&&Date.now()-start<75000)await new Promise(resolve=>setTimeout(resolve,100))
 item.understanding=host.understanding.snapshot();item.elapsed_ms=Date.now()-start
 const state=await snapshot(label)
 assert.equal(item.understanding.status,'ready',`${label}: understanding did not finish successfully`)
 assert.equal(report.evaluations.at(-1)?.source.observed_at,item.observed_at)
 assert.equal(report.evaluations.at(-1)?.source.timezone,timezone)
 return state
}
try{
 await persist();settings=loadSettings();const key=resolveModelApiKey(settings),jevKey=settings.openrouter_api_key
 secrets.push(key,jevKey,settings.model_base_url)
 assert.ok(key,'missing_model_credential');assert.ok(jevKey,'missing_jev_credential')
 report.extraction_model=settings.fast_model;report.judgment_model='typesafe/jev-1.13'
 fingerprint=createHash('sha256').update(settings.model_base_url+'\n'+settings.fast_model).digest('hex')
 const model=new OpenAIModelGateway({baseUrl:settings.model_base_url,apiKey:key,clock:new RealClock(),metrics:{record(){}}})
 gateway={stream:request=>model.stream(request),async complete(request){const call={model:request.model,input:JSON.parse(request.prompt),started_at:new Date().toISOString()},start=Date.now();report.calls.push(call);await persist();try{const response=await model.complete(request);call.output=response.text;return response}catch(error){call.error=sanitize(error.message);throw error}finally{call.elapsed_ms=Date.now()-start;await persist()}}}
 pipeline=createUnderstandingPipeline({gateway,model:settings.fast_model,judge:createJevJudge({apiKey:jevKey})})
 await open()
 const first=await turn('create','请记下一条待办：比较三门日语课程，明天完成。')
 assert.equal(first.todos.length,1);const initial=first.todos[0],id=initial.id
 assert.equal(initial.status,'open');assert.equal(initial.due,'2026-09-22');await pass('explicit todo uses the anchored Asia/Shanghai date')
 const repeated=await turn('paraphrase','请记下比较三门日语课程这项待办，也就是对比三个日语班，明天完成。')
 assert.equal(repeated.todos.length,1);assert.equal(repeated.todos[0].id,id);assert.equal(repeated.todos[0].version,initial.version);await pass('cross-turn paraphrase preserves one ID and version')
 const rescheduled=await turn('reschedule','请把比较三门日语课程这条待办的截止日期改成后天。')
 assert.equal(rescheduled.todos.length,1);assert.equal(rescheduled.todos[0].id,id);assert.equal(rescheduled.todos[0].due,'2026-09-23');assert.ok(rescheduled.todos[0].version>initial.version);await pass('explicit reschedule updates the same object with anchored due date')
 const completed=await turn('complete','比较三门日语课程已经做完了，请将这条待办标记为已完成。')
 assert.equal(completed.todos.length,1);assert.equal(completed.todos[0].id,id);assert.equal(completed.todos[0].status,'done');assert.ok(completed.todos[0].version>rescheduled.todos[0].version);await pass('explicit completion updates the same object')
 const second=await turn('create-cancellable','请记下一条待办：整理合成展览的摄影清单，明天完成。')
 assert.equal(second.todos.length,2);const cancellable=second.todos.find(todo=>todo.id!==id);assert.ok(cancellable);assert.equal(cancellable.status,'open')
 const cancelled=await turn('cancel','请取消整理合成展览的摄影清单这条待办。')
 assert.equal(cancelled.todos.length,2);const target=cancelled.todos.find(todo=>todo.id===cancellable.id);assert.equal(target?.status,'cancelled');assert.ok(target.version>cancellable.version);assert.equal(cancelled.todos.find(todo=>todo.id===id)?.status,'done');await pass('cancellation targets the second object without changing the completed one')
 const rows=report.snapshots.at(-1).rows,evidence=report.snapshots.at(-1).evidence
 for(const todo of cancelled.todos){const row=rows.find(row=>row.content.life_data?.id===todo.id&&row.content.life_data.version===todo.version);assert.ok(row,`missing substrate revision for ${todo.id}`);assert.ok(row.evidence_refs.length);assert.ok(row.evidence_refs.every(id=>evidence.some(item=>item.id===id)))}
 await pass('current Life versions have persisted Substrate revisions and resolvable synthetic evidence')
 await host.close();host=undefined;await memory.close();memory=undefined;await open()
 assert.deepEqual(await snapshot('restart'),cancelled);assert.equal(host.understanding.snapshot().items.length,0);await pass('new host and Substrate resource retain IDs, versions, dates and terminal states')
 const rerecorded=await turn('completed-paraphrase','请记下比较三门日语课程这项待办，就是之前对比三个日语班那件事。')
 assert.equal(rerecorded.todos.length,2);assert.deepEqual(rerecorded.todos.find(todo=>todo.id===id),completed.todos[0]);await pass('repeated mention after restart does not duplicate or reopen the completed todo')
 report.status='passed'
}catch(error){report.status='failed';report.failure=sanitize(error.message??error.name);process.exitCode=1;console.error('FAIL',report.failure)}finally{
 for(const resource of [host,memory])try{await resource?.close()}catch(error){report.status='failed';report.cleanup_error=sanitize(error.message??error.name);process.exitCode=1}
 report.finished_at=new Date().toISOString();await persist();console.log('Synthetic evidence:',output)
}
