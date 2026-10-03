import {app,BrowserWindow} from 'electron'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,isAbsolute} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {loadSettings,settingsSchema,resolveModelApiKey} from '../../../runtime/dist/src/config/config.js'
import {parseCapabilityRegistry} from '../../../runtime/dist/src/config/capability-registry.js'
import {OpenAIModelGateway} from '../../../runtime/dist/src/model/model-gateway.js'
import {RealClock} from '../../../runtime/dist/src/core/clock.js'
import {MemoryLedgerClient} from '../../../runtime/dist/src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../../../runtime/dist/src/memory-substrate/resource.js'
import {PersonalAgentHost} from '../../../runtime/dist/src/personal-agent/host.js'
import {SuggestionPool} from '../../../runtime/dist/src/core/suggestions.js'
import {createUnderstandingPipeline} from '../../../runtime/dist/src/understanding/pipeline.js'
import {createJevJudge} from '../../../runtime/dist/src/understanding/jev.js'
import {buildCascadedTextProvider} from '../../../runtime/dist/src/cascaded-text-provider.js'
import {conversationRuntimeFactory} from '../../../runtime/dist/src/personal-agent/conversation-runtime.js'
import {configuredMemoryConsumer} from '../../../runtime/dist/src/composition/realtime-assembly.js'
import {DesktopRealtime} from '../../../runtime/dist/src/desktop/desktop-session.js'
import {createConversation} from '../../../runtime/dist/src/personal-agent/conversations.js'

async function main(){
 const restartDir=process.env.NOVA_SYSTEM_LIFE_RESTART_DIR,dir=restartDir??await mkdtemp(join(await realpath(tmpdir()),'nova-system-life-')),output=process.env.NOVA_LIVE_MODULE_REPORT??join(dir,'report.json')
 assert.ok(isAbsolute(output));await mkdir(dirname(output),{recursive:true});app.setPath('userData',join(dir,'electron'))
 const root=fileURLToPath(new URL('../../../',import.meta.url)),report=restartDir?JSON.parse(await readFile(output,'utf8')):{version:1,module:'system-life',layer:'system-live',synthetic:true,status:'running',started_at:new Date().toISOString(),checks:[],checkpoint:'start',turns:[],events:[],screenshots:[],artifacts:{directory:dir},coverage:['Visible production renderer → authenticated WebSocket/DesktopRealtime → host → production conversationRuntimeFactory/CascadedRealtimeAdapter → configured real LLM','Real Understanding/Jev → Life → SQLite/Markdown/Git → memory recall → generated and durable answer','UI correction/status, fresh conversations, independent Electron process restart and input retry'],limitations:['Source Electron and isolated synthetic stores; no installed release, physical audio, external accounts or executor tasks.','No stub dialogue model or direct answer injection; fixture configuration disables external action capabilities.']}
 const secrets=[];let handedOff=false,host,memory,rootRuntime,desktop,window,unsubscribe=()=>{},settings,gateway,pipeline
 const safe=value=>secrets.reduce((text,secret)=>secret?text.replaceAll(secret,'[redacted]'):text,String(value))
 const persist=()=>writeFile(output,safe(JSON.stringify(report,null,2))+'\n',{mode:0o600})
 const check=async text=>{report.checks.push(text);report.checkpoint=text;await persist();console.log('PASS',text)}
 const telemetry={record(kind,payload){if(['tool.call','tool.admission','tool.finished','cascaded.llm.tool_call'].includes(kind))report.events.push({kind,payload})},close(){}}
 const js=code=>window.webContents.executeJavaScript(code)
 const wait=async(predicate,label=predicate)=>{const start=Date.now();while(Date.now()-start<120000){if(await js(predicate))return;await new Promise(r=>setTimeout(r,100))}throw Error('UI wait: '+label)}
 const click=label=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(n=>n.textContent===${JSON.stringify(label)});if(!b)throw Error('missing button');b.click();b.blur()})()`)
 const field=(label,value,event='input')=>js(`(()=>{const n=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');if(!n)throw Error('missing field');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}))})()`)
 async function shot(name){await new Promise(r=>setTimeout(r,200));const path=output+'.'+name+'.png';await writeFile(path,(await window.webContents.capturePage()).toPNG(),{mode:0o600});report.screenshots.push(path);await persist()}
 const command=async(method,params={})=>{const r=await host.command({type:'personal.command',request_id:randomUUID(),method,params});assert.equal(r.ok,true,JSON.stringify(r));return r.data}
 async function open(){
  memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(dir,'ledger.sqlite')),userId:'synthetic-system',gateway,model:settings.fast_model,inputConsent:true,conversationProviders:[configuredMemoryConsumer(settings,'text')],consolidation:{enabled:false}});await memory.open()
  host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'synthetic-system',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,understand:pipeline});await host.open()
  await command('discovery.configure',{enabled:false,timezone:'Asia/Shanghai',briefing_outlook_enabled:false,briefing_review_enabled:false})
  const factory=conversationRuntimeFactory({settings,host,memory:()=>memory,gateway,telemetry,createTextProvider:options=>{const provider=buildCascadedTextProvider(options),events=provider.events.bind(provider),inject=provider.injectHostItem.bind(provider);provider.events=async function*(signal){for await(const event of events(signal)){if(event.kind==='tool_call_ready')report.events.push({kind:'provider.tool_call',name:event.name,arguments:event.arguments});yield event}};provider.injectHostItem=async(item,options)=>{if(item.kind==='tool_output')report.events.push({kind:'provider.tool_result',item});return inject(item,options)};return provider},capabilities:parseCapabilityRegistry({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:false}}},{}),searchTransport:{search:()=>Promise.reject(Error('unexpected external search'))}})
  rootRuntime=await factory(createConversation('chat','Transport owner',null,'synthetic-bridge-home'),()=>{})
  const stop=new AbortController()
  desktop=new DesktopRealtime({token:randomUUID().replaceAll('-',''),service:rootRuntime.bridgeService,stop,transportFailure:'disconnect',submitConversationText:(id,text,request)=>host.submitConversationText(id,text,request),conversationService:id=>host.conversationService(id),personalCommand:value=>host.command(value),personalSnapshot:()=>host.snapshot()})
  host.setConversationRuntime(factory,frame=>desktop.bridge.onPersonalFrame(frame));unsubscribe=host.subscribe(()=>desktop.bridge.onPersonalFrame(host.snapshot()))
  const ready=await desktop.server.start()
  const module=pathToFileURL(join(root,'clients/desktop/src/renderer/personal-view.mjs')).href,css=pathToFileURL(join(root,'clients/desktop/src/renderer/workbench.css')).href
  const html=join(dir,'index.html');await writeFile(html,`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${css}"><div id="shell"></div><script type="module">import {mountPersonalView} from '${module}';const socket=new WebSocket('ws://127.0.0.1:${ready.port}');window.sent=[];window.received=[];window.view=mountPersonalView({send:f=>{if(socket.readyState!==1)return false;window.sent.push(f);socket.send(JSON.stringify(f));return true},start:async()=>{throw Error('audio forbidden')},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction:()=>{},results:()=>[],openResults:()=>{},api:{personal:{setUnread(){},openArticle(){throw Error('external navigation forbidden')}},orbMenu:{openSettings(){}}}});window.socket=socket;socket.onopen=()=>socket.send(JSON.stringify({type:'hello',token:${JSON.stringify(desktop.serverOptions.token)}}));socket.onmessage=e=>{const f=JSON.parse(e.data);window.received.push(f);if(f.type==='desktop.ready'){window.view.controller.connect();window.view.controller.command('state').catch(e=>window.failure=e.message)}window.view.receive(f)};socket.onclose=()=>window.view.controller.disconnect();</script>`)
  if(!window){window=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})}
  await window.loadFile(html);await wait("window.view?.controller.snapshot && window.view.controller.capabilities.includes('text_input')",'authenticated production UI bootstrap')
 }
 async function close(){unsubscribe();if(window)await js("window.socket?.close()").catch(()=>{});await desktop?.server.close();await host?.close();await rootRuntime?.close();await memory?.close();desktop=host=rootRuntime=memory=undefined}
 async function turn(label,text){
  report.checkpoint=label;await persist();const id=host.conversationSnapshot().selected_id,before=host.conversationSnapshot().messages.length,start=Date.now(),eventStart=report.events.length
  await field('消息草稿',text);await js("document.querySelector('[aria-label=\"发送消息\"]').click()")
  await wait(`window.view.controller.snapshot.conversations.messages.length>${before} && window.view.controller.snapshot.conversations.messages.at(-1)?.role==='assistant' && window.view.controller.snapshot.conversations.messages.at(-2)?.generation_status==='completed'`,label)
  await host.waitConversation(id);await memory.flush();const messages=host.conversationSnapshot().messages,reply=messages.at(-1)
  assert.equal(reply.role,'assistant');assert.ok(reply.reply_to);assert.equal(messages.filter(m=>m.id===reply.reply_to&&m.role==='user').length,1)
  report.turns.push({label,conversation_id:id,text,reply:reply.text,elapsed_ms:Date.now()-start,events:report.events.slice(eventStart)});await persist();if(label.includes('recall')){assert.ok(report.turns.at(-1).events.some(e=>e.kind==='provider.tool_result'&&JSON.parse(e.item.content).entries?.some(entry=>entry.life?.due_precision==='date'&&entry.life.due_time===null)),'real tool output must state date precision');assert.doesNotMatch(reply.text,/\d{1,2}[:：]\d{2}|\d{1,2}(?:点|时)\d{1,2}分/,'date-only due must not acquire an invented time')}return reply.text
 }
 async function fresh(){const old=host.conversationSnapshot().selected_id;await click('新对话');await wait(`window.view.controller.selectedId!==${JSON.stringify(old)}`)}
 try{
  await persist();const loaded=loadSettings();settings=settingsSchema.parse({...loaded,executors:[],camera_module_enabled:false,memory_prerecall_enabled:false,cascade_llm_provider:'qwen',cascade_llm_model:loaded.fast_model});const key=resolveModelApiKey(settings);secrets.push(key,settings.openrouter_api_key,settings.model_base_url,settings.dashscope_api_key,settings.ark_api_key,settings.deepseek_api_key)
  assert.ok(key&&settings.openrouter_api_key,'configured model/Jev credentials required');report.configuration='Fixture selects Qwen text using the already configured DashScope key; configured default DeepSeek key is absent. No saved settings are changed.';report.models={extraction:settings.fast_model,conversation:settings.cascade_llm_model,judge:'typesafe/jev-1.13'}
  gateway=new OpenAIModelGateway({baseUrl:settings.model_base_url,apiKey:key,clock:new RealClock()});pipeline=createUnderstandingPipeline({gateway,model:settings.fast_model,judge:createJevJudge({apiKey:settings.openrouter_api_key})})
  await app.whenReady();await open();if(!restartDir){await check('real authenticated WebSocket and production renderer bootstrap')
  await turn('create','请记下一条待办：校对合成灯塔报告，截止日期是2026年10月3日。')
  await wait("window.view.controller.snapshot.life.todos.some(t=>t.title.includes('灯塔')) && window.view.controller.snapshot.understanding.status!=='working'",'Life automatic persistence')
  let todo=host.life.snapshot().todos.find(t=>t.title.includes('灯塔'));assert.ok(todo);const id=todo.id;assert.equal(todo.due,'2026-10-03');assert.equal(host.life.snapshot().todos.length,1)
  const sent=await js("window.sent.filter(f=>f.type==='input.text').at(-1)");await js(`window.socket.send(JSON.stringify(${JSON.stringify(sent)}))`);await new Promise(r=>setTimeout(r,300));assert.equal(host.conversationSnapshot().messages.filter(m=>m.request_id===sent.request_id).length,1)
  await check('UI input reaches real conversation model and Understanding; durable todo and duplicate transport receipt agree')
  await fresh();let answer=await turn('recall','请调用个人记忆检索，查询之前记录的校对合成灯塔报告这条待办，告诉我标题和完整截止日期。只查询，不新增或修改。');assert.match(answer,/灯塔/);assert.match(answer,/2026.{0,4}10.{0,4}3/);assert.ok(report.turns.at(-1).events.some(e=>e.kind==='provider.tool_call'&&String(e.name).includes('recall')))
  await check('fresh conversation uses production memory recall tool and generates a persisted date answer')
  await click('Todos');await click('编辑');await field('到期日期','2026-10-05');await click('保存修改');await wait("window.view.controller.snapshot.life.todos[0].due==='2026-10-05'");todo=host.life.snapshot().todos[0]
  await field(todo.title+'状态','done','change');await wait("window.view.controller.snapshot.life.todos[0].status==='done'");assert.equal((await host.discoverySnapshot()).memory.some(e=>e.life?.id===id),false);await check('UI date correction and completion update the same persisted object and exclude it from discovery')
  report.restart={life:host.life.snapshot(),messages:host.conversationSnapshot().messages,object_id:id,parent_pid:process.pid};await close();await persist();window.destroy();window=null
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,NOVA_SYSTEM_LIFE_RESTART_DIR:dir,NOVA_LIVE_MODULE_REPORT:output},stdio:'inherit'});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});handedOff=true;app.exit(code??1);return
  }
  assert.notEqual(process.pid,report.restart.parent_pid);report.restart.child_pid=process.pid;assert.deepEqual(host.life.snapshot(),report.restart.life);assert.deepEqual(host.conversationSnapshot().messages,report.restart.messages);const id=report.restart.object_id;let answer
  await fresh();answer=await turn('restarted-recall','请调用个人记忆检索，查询校对合成灯塔报告这条待办目前的状态和完整截止日期。只查询，不新增或修改。');assert.match(answer,/2026.{0,4}10.{0,4}5/);assert.match(answer,/完成|done/);assert.equal(host.life.snapshot().todos[0].id,id);assert.equal(host.life.snapshot().todos.length,1)
  await shot('restarted-answer');await check('independent Electron process restart and new UI conversation read corrected date and terminal status through the real model')
  report.status='passed'
 }catch(error){report.status='failed';report.failure={checkpoint:report.checkpoint,message:safe(error.stack??error)};console.error('FAIL',report.failure.message);if(window)report.ui=await js('({text:document.body.innerText,sent:window.sent.slice(-8),received:window.received.slice(-8)})').catch(()=>null);await persist();if(window)await shot('failure').catch(()=>{});process.exitCode=1}
 finally{if(handedOff)return;await close().catch(error=>{report.status='failed';report.cleanup_error=safe(error.message)});report.finished_at=new Date().toISOString();await persist();console.log('System report:',output);window?.destroy();app.exit(report.status==='passed'?0:1)}
}
void main().catch(error=>{console.error(error.name,error.message);app.exit(1)})
