/** Interactive live driver for the unmodified production conversation/Task graph.
 * JSON lines on stdin: {text}, {method,params}, {backend}, {snapshot:true}, {stop:true}.
 * No implicit approval or fabricated successful outcome. Reports are evidence, not verdicts.
 */
import {mkdir,writeFile,readFile,rename,appendFile} from 'node:fs/promises'
import {accessSync,chmodSync,constants,realpathSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {createInterface} from 'node:readline'
import {execFileSync} from 'node:child_process'
import {buildProductionComposition} from '../../dist/src/composition/production-composition.js'

function resolveCodexBin(configured) {
  const candidates = []
  if (configured && configured !== 'codex') candidates.push(configured)
  try {
    const which = execFileSync('which', ['codex'], {encoding: 'utf8'}).trim()
    if (which) candidates.push(which)
  } catch {/* fall through */}
  candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex')
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {/* try next */}
  }
  throw new Error('codex_not_found')
}

if(process.env.NOVA_LIVE_PROJECT_EXECUTE!=='1')throw Error('explicit opt-in required')
if(!process.argv[2])throw Error('isolated output directory required')
const directory=resolve(process.argv[2])
const reportName=process.env.NOVA_LIVE_CONVERSATION_ID?'report-recovery.json':'report.json'
await mkdir(directory,{recursive:true,mode:0o700})
await mkdir(join(directory,'initial'),{recursive:true,mode:0o700})
await mkdir(join(directory,'workspaces'),{recursive:true,mode:0o700})
// umask can clear mkdir mode bits; project roots require owner-only directories.
for (const path of [directory, join(directory,'initial'), join(directory,'workspaces')]) chmodSync(path, 0o700)
await writeFile(join(directory,'capabilities.json'),JSON.stringify({version:1,modules:{coding:{enabled:true},camera:{enabled:false},search:{enabled:false},knowledge:{enabled:false}}}))
const redactCaptured=value=>{
  if(typeof value==='string')return value.replace(/(Bearer\s+)\S+/gi,'$1[redacted]').replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,'$1=[redacted]').slice(0,8000)
  if(Array.isArray(value))return value.map(redactCaptured)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/key|token|secret|password|authorization/i.test(k)?'[redacted]':redactCaptured(v)]))
  return value
}
// Explicit local diagnostics only; excludes HTTP headers and credentials.
if(process.env.NOVA_LIVE_CAPTURE_MODEL_REQUESTS==='1'){
  const originalFetch=globalThis.fetch
  globalThis.fetch=async(input,init)=>{
    let requestModel=null,streaming=false
    if(typeof init?.body==='string'){
      try {const body=JSON.parse(init.body)
        if(Array.isArray(body.messages)){
          requestModel=body.model
          streaming=body.stream===true
          await appendFile(join(directory,'model-requests.jsonl'),JSON.stringify({at:new Date().toISOString(),model:body.model,messages:redactCaptured(body.messages),tools:body.tools?.map(t=>({type:t.type,function:t.function?{name:t.function.name}:undefined}))})+'\n',{mode:0o600})
        }
      }catch{/* diagnostics must not change the request */}
    }
    try {
      const response=await originalFetch(input,init)
      if(response.ok&&requestModel&&!streaming){
        try{const body=await response.clone().json();await appendFile(join(directory,'model-responses.jsonl'),JSON.stringify({at:new Date().toISOString(),model:requestModel,text:body.choices?.[0]?.message?.content})+'\n',{mode:0o600})}catch{/* diagnostics are advisory */}
      }
      if(!response.ok)event('http_failure',{model:requestModel,status:response.status})
      return response
    }catch(error){event('fetch_failure',{model:requestModel,name:error.name,code:error.code,cause:error.cause?.code});throw error}
  }
}
const backend=process.env.CODING_BACKEND??'codex'
const transportSource=new URL('../../src/executors/acp/transport.ts',import.meta.url)
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().split('\n').filter(Boolean),
  backend,permissionMode:process.env.CODEX_APPROVAL_MODE??'ask',
  transportHash:createHash('sha256').update(await readFile(transportSource)).digest('hex'),
  transportSource:transportSource.pathname,
  startedAt:new Date().toISOString(),status:'running',scope:'Production composition, text conversation, real Task and coding backend. UI/audio and game acceptance are separate.',events:[]}
const cleanups=[],stop=new AbortController()
let composition,host,coding,conversation,closing=false
let saving=Promise.resolve()
const save=()=>{
  if(host)report.snapshot=host.snapshot()
  const body=JSON.stringify(report,null,2)
  saving=saving.then(async()=>{
    await writeFile(join(directory,reportName+'.tmp'),body,{mode:0o600})
    await rename(join(directory,reportName+'.tmp'),join(directory,reportName))
  })
  return saving
}
const event=(kind,data)=>{report.events.push({at:new Date().toISOString(),kind,data});console.log(JSON.stringify({kind,data:kind==='state'?{tasks:data.tasks.map(t=>({id:t.id,phase:t.phase,reason:t.waiting_reason})),confirmations:data.pending_confirmations,approvals:data.pending_approvals}:data}))}
const environment={...process.env,PIPELINE_MODE:'cascaded',EXECUTOR:'codex',CODEX_PREWARM:'false',
  CODEX_BIN:resolveCodexBin(process.env.CODEX_BIN),
  CODEX_WORKSPACE:join(directory,'initial'),CODEX_MANAGED_ROOT:join(directory,'workspaces'),CODEX_PROJECT_STATE_ROOT:directory,
  BLACKBOARD_PATH:join(directory,'blackboard.sqlite'),MEMORY_LEDGER_PATH:join(directory,'memory.sqlite'),
  MEMORY_PATH:join(directory,'personal-memory.sqlite'),CAPABILITIES_CONFIG:join(directory,'capabilities.json'),
  MEMORY_CONNECTION:'disabled',CAMERA_MODULE_ENABLED:'false',
  CONVERSATION_VISION_ENABLED:'false',CODEX_RESOURCES_PATH:resolve('clients/desktop/build')}
delete environment.MEMORY_PROVIDER
const command=async(method,params={})=>{
  const result=await host.command({type:'personal.command',request_id:randomUUID(),method,params},{client_id:'live-acceptance',can_takeover:true})
  event('command',{method,params,result});await save();return result
}
async function close(){
  if(closing)return;closing=true;stop.abort()
  try{await composition?.realtime.stop();await composition?.desktop.server.close();await composition?.closeAuxiliary()}
  finally{for(const entry of cleanups.reverse())if(entry.active)await entry.cleanup().catch(()=>{})
    report.status='stopped';report.finishedAt=new Date().toISOString();await save();process.exit()}
}
process.on('SIGTERM',()=>void close())
try{
  composition=await buildProductionComposition({environment,token:randomUUID().replaceAll('-',''),stop,
    ownership:{own(cleanup){const entry={cleanup:async()=>cleanup(),active:true};cleanups.push(entry);return()=>{entry.active=false}}},
    onDiagnostic:code=>event('diagnostic',code),onCoding:resource=>{coding=resource}})
  await composition.realtime.start()
  host=composition.realtime.personalAgent
  if(process.env.NOVA_LIVE_CONVERSATION_ID)await command('conversations.select',{id:process.env.NOVA_LIVE_CONVERSATION_ID})
  else await command('conversations.create',{title:`${backend} Tetris live acceptance`})
  conversation=host.conversationSnapshot().selected_id
  let last=''
  const timer=setInterval(async()=>{
    if(closing)return
    const s=host.snapshot(),brief={tasks:s.tasks,pending_confirmations:s.pending_confirmations,pending_approvals:s.pending_approvals,messages:s.conversations.messages}
    const current=JSON.stringify(brief)
    if(current!==last){last=current;event('state',brief);await save()}
  },1000)
  timer.unref()
  event('ready',{directory,backend,conversation});await save()
  const input=createInterface({input:process.stdin})
  for await(const line of input){
    try{
      const request=JSON.parse(line)
      if(request.stop){await close();break}
      if(request.text){event('input',{conversation,text:request.text});await host.submitConversationText(conversation,request.text,randomUUID())}
      else if(request.method)await command(request.method,request.params)
      else if(request.backend){coding.updateDefaultBackend(request.backend);event('default_backend',request.backend)}
      else if(request.snapshot)event('snapshot',host.snapshot())
      await save()
    }catch(error){event('input_error',String(error.message));await save()}
  }
  await close()
}catch(error){
  report.status='failed';event('failure',{message:error.message,stack:error.stack});await save()
  stop.abort()
  for(const entry of cleanups.reverse())if(entry.active)await entry.cleanup().catch(()=>{})
  process.exit(1)
}
