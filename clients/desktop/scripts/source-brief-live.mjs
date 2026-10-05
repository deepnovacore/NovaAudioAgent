import {app,BrowserWindow} from 'electron'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,mkdir,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
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
import {buildCascadedTextProvider} from '../../../runtime/dist/src/cascaded-text-provider.js'
import {conversationRuntimeFactory} from '../../../runtime/dist/src/personal-agent/conversation-runtime.js'
import {configuredMemoryConsumer} from '../../../runtime/dist/src/composition/realtime-assembly.js'
import {DesktopRealtime} from '../../../runtime/dist/src/desktop/desktop-session.js'
import {createConversation} from '../../../runtime/dist/src/personal-agent/conversations.js'

import {GatewayPersonalWriter} from '../../../runtime/dist/src/model/personal-writer.js'
import {FeishuConnector,FEISHU_SCOPES} from '../../../runtime/dist/src/connectors/feishu/index.js'
import {emptyLifeState,applyLifeMutation} from '../../../runtime/dist/src/personal-agent/life.js'
app.on('window-all-closed',()=>{})

async function main(){
 await mkdir('/tmp/nova-source-live',{recursive:true})
 const restartDir=process.env.NOVA_SOURCE_BRIEF_RESTART_DIR,dir=restartDir??await realpath(await mkdtemp('/tmp/nova-source-live/brief-')),output=process.env.NOVA_LIVE_MODULE_REPORT??join(dir,'report.json')
 app.setPath('userData',join(dir,restartDir?'electron-restart':'electron'))
 assert.equal(Boolean(process.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT),false,'normal scheduler must remain enabled')
 const root=fileURLToPath(new URL('../../../',import.meta.url)),report=restartDir?JSON.parse(await readFile(output,'utf8')):{module:'daily-brief',synthetic:true,status:'running',started_at:new Date().toISOString(),checks:[],screenshots:[],model_calls:0,events:[],artifacts:{directory:dir},limitations:['Synthetic isolated source build; no OS notification banner or installed-release acceptance.','Synthetic Feishu transport responses; real connector ingestion and model inference. No external sending.']}
 const secrets=[];let handedOff=false,host,memory,connector,rootRuntime,desktop,window,unsubscribe=()=>{},settings,gateway,writer
 const safe=value=>secrets.reduce((text,secret)=>secret?text.replaceAll(secret,'[redacted]'):text,String(value))
 const persist=()=>writeFile(output,safe(JSON.stringify(report,null,2))+'\n',{mode:0o600})
 const check=async text=>{report.checks.push(text);report.checkpoint=text;await persist();console.log('PASS',text)}
 const telemetry={record(){},close(){}}
 const js=code=>window.webContents.executeJavaScript(code)
 const wait=async(predicate,label=predicate,timeout=240000)=>{const start=Date.now();while(Date.now()-start<timeout){if(await js(predicate))return;await new Promise(r=>setTimeout(r,200))}throw Error('UI wait: '+label)}
 async function shot(name){const path=output+'.'+name+'.png';await writeFile(path,(await window.webContents.capturePage()).toPNG(),{mode:0o600});report.screenshots.push(path);await persist()}
 const command=async(method,params={})=>{const r=await host.command({type:'personal.command',request_id:randomUUID(),method,params});assert.equal(r.ok,true,JSON.stringify(r));return r.data}
 async function open(){
  memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(dir,'ledger.sqlite')),userId:'synthetic-system',gateway,model:settings.fast_model,inputConsent:true,conversationProviders:[configuredMemoryConsumer(settings,'text')],consolidation:{enabled:false,timezone:'Asia/Shanghai'}});await memory.open();if(!restartDir){
   const old=new Date(Date.now()-7*86400000).toISOString(),date=offset=>new Date(Date.now()+offset*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});let state=emptyLifeState()
   for(const [id,title,due,status] of [['overdue','复核合成灯塔逾期待办',date(-1),'open'],['today','复核合成极光今日材料',date(0),'open'],['done','合成天穹已完成事项',date(0),'done'],['cancelled','合成云海已取消事项',date(0),'cancelled'],['future','合成银河未来事项',date(5),'open']]){const created=applyLifeMutation(state,{op:'create',kind:'todo',title,due},'synthetic-'+id,old);state=created.state;if(status!=='open')state=applyLifeMutation(state,{op:'update',kind:'todo',id:created.result.id,expected_version:1,status},'status-'+id,old).state}
   await memory.lifeBackend().load(state)
   const message='@_user_1 请你今天提交合成星图方案的评审材料，由你负责整理并发给我。'
   connector=new FeishuConnector({executable:'fixture',credentialRoot:join(dir,'credentials'),statePath:join(dir,'feishu.json'),processingGrant:(...args)=>memory.processingGrant(...args),onProcessingConsent:async(ids,grant)=>{for(const id of ids)await memory.setProcessingConsent(id,grant)},ingest:async m=>{await memory.ingestEvidence({sourceId:m.source_id,locator:m.locator,text:m.raw_text,observedAt:m.observed_at,kind:'im',processingConsent:m.processing_consent,im:{sender_id:m.sender_id,account_id:m.account_id,provider:'feishu',message_id:m.message_id,chat_id:m.chat_id,recipient_id:m.recipient_id,mention:m.mention,auto_capture:m.auto_capture,sender_name:'测试同事'}})},deleteSource:id=>memory.forgetSource(id),onAction:async()=>{throw Error('external actions forbidden')},run:async args=>{
    if(args[0]==='--version')return '1.0.69';if(args[1]==='status')return JSON.stringify({appId:'synthetic',identities:{user:{openId:'ou_me',status:'authenticated',scopes:FEISHU_SCOPES}}});if(args[1]==='login')return JSON.stringify({verification_url:'https://accounts.feishu.cn/device',device_code:'synthetic',expires_in:900});if(args[1]==='+chat-list')return JSON.stringify({items:[{chat_id:'oc_test',name:'Synthetic'}],has_more:false});if(args[1]==='+chat-messages-list')return JSON.stringify({items:[{message_id:'om_live_request',msg_type:'text',content:message,create_time:new Date().toISOString(),sender:{open_id:'ou_sender'},mentions:[{id:'ou_me',id_type:'open_id'}]}],has_more:false});if(args[0]==='api')return JSON.stringify({items:[]});return '{}'
   }})
   await connector.open();await connector.beginLogin();await connector.completeLogin();await connector.listChats();await connector.configure(['oc_test'],true);await connector.setProcessingConsent(true);await connector.sync();await memory.flush();await connector.close();connector=undefined
  }
  host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'synthetic-system',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,prepareBrief:async(snapshot,slot,signal)=>{report.model_calls++;report.brief_snapshot={memory:snapshot.memory.map(row=>({id:row.id,content:row.content,life:row.life,observed_at:row.observed_at})),daily:snapshot.daily};report.model_started_at=new Date().toISOString();await persist();try{return await writer.prepareBrief(snapshot,slot,signal)}catch(error){report.model_failure=safe(error.stack??error);await persist();throw error}}});await host.open()
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
 async function close(){unsubscribe();if(window)await js("window.socket?.close()").catch(()=>{});await desktop?.server.close();await host?.close();await rootRuntime?.close();await connector?.close();await memory?.close();desktop=host=rootRuntime=memory=undefined}
 try{
  if(process.env.NOVA_LIVE_ENV_FILE)process.loadEnvFile(process.env.NOVA_LIVE_ENV_FILE)
  const loaded=loadSettings();settings=settingsSchema.parse({...loaded,executors:[],camera_module_enabled:false,memory_prerecall_enabled:false,cascade_llm_provider:'qwen',cascade_llm_model:loaded.fast_model});const key=resolveModelApiKey(settings);secrets.push(key,settings.openrouter_api_key,settings.model_base_url,settings.dashscope_api_key,settings.ark_api_key,settings.deepseek_api_key);assert.ok(key,'configured model key required')
  report.model=settings.fast_model;gateway=new OpenAIModelGateway({baseUrl:settings.model_base_url,apiKey:key,clock:new RealClock()});const complete=gateway.complete.bind(gateway);gateway.complete=async request=>{const response=await complete(request);report.model_response=response.text;await persist();return response};writer=new GatewayPersonalWriter({gateway,model:settings.fast_model});await persist()
  await app.whenReady();await open()
  if(!restartDir){
   await host.life.refresh();assert.equal(host.life.snapshot().todos.length,6);const mentioned=host.life.snapshot().todos.find(row=>row.auto_recorded);assert.ok(mentioned?.sources.some(row=>row.mentioned_me));report.seeded_todos=host.life.snapshot().todos
   await command('state');await wait("document.body.innerText.includes('自动记录') && document.body.innerText.includes('@我') && document.body.innerText.includes('飞书')",'source metadata visible on Todos')
   await js("document.querySelector('[aria-label=\"飞书 · 查看来源\"]').click()");await wait("[...document.querySelectorAll('[role=dialog]')].some(node=>!node.hidden && node.innerText.includes('合成星图'))",'safe source popover visible');await shot('mention-source');await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
   await check('synthetic Feishu connector plus real model created one Todo with visible source and mention tags')
   const target=new Date(Math.ceil((Date.now()+1000)/60000)*60000),parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(target).map(row=>[row.type,row.value]));report.scheduled_at=target.toISOString()
   await command('discovery.configure',{enabled:false,timezone:'Asia/Shanghai',briefing_outlook_enabled:true,briefing_outlook_time:parts.hour+':'+parts.minute,briefing_review_enabled:false,briefing_weekdays:[1,2,3,4,5,6,7],quiet_start:'00:00',quiet_end:'00:00'})
   await check('normal production scheduler armed for real future wall-clock minute')
   await wait("window.view.controller.snapshot.feed.some(item=>item.title==='今日前瞻')",'real scheduled brief publication')
   assert.equal(report.model_calls,1);assert.ok(Date.parse(report.model_started_at)>=target.getTime());assert.equal(host.snapshot().feed.length,1);assert.equal(host.conversationSnapshot().unread_count,1);assert.match(host.snapshot().feed[0].prepared.text,/灯塔/);assert.match(host.snapshot().feed[0].prepared.text,/极光/);assert.match(host.snapshot().feed[0].prepared.text,/星图/);assert.doesNotMatch(host.snapshot().feed[0].prepared.text,/天穹|云海|银河/);assert.ok(report.brief_snapshot.memory.some(row=>row.content.includes('极光')));assert.ok(report.brief_snapshot.memory.some(row=>row.content.includes('星图')));assert.ok(report.brief_snapshot.memory.every(row=>!(/天穹|云海|银河/).test(row.content)));assert.ok(host.life.snapshot().todos.some(row=>Date.parse(row.created_at)<Date.now()-6*86400000&&row.status==='open'))
   report.feed=host.snapshot().feed;report.before_restart={feed_id:report.feed[0].id,parent_pid:process.pid};await check('real writer received older overdue Todo and published one grounded brief through authenticated WebSocket')
   await js("window.view.controller.command('conversations.select',{id:'chat:proactive'})");await wait("document.body.innerText.includes('灯塔')",'visible brief text');report.ui_text=await js('document.body.innerText');await shot('brief')
   await close();await persist();window.destroy();window=null
   const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,NOVA_SOURCE_BRIEF_RESTART_DIR:dir,NOVA_LIVE_MODULE_REPORT:output},stdio:'inherit'});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});handedOff=true;app.exit(code??1);return
  }
  assert.notEqual(process.pid,report.before_restart.parent_pid);report.child_pid=process.pid
  await new Promise(r=>setTimeout(r,65000));assert.equal(report.model_calls,1);assert.equal(host.snapshot().feed.length,1);assert.equal(host.snapshot().feed[0].id,report.before_restart.feed_id);await wait("document.body.innerText.includes('灯塔')",'restored brief text');await shot('restarted');await check('independent Electron process restart plus another normal timer tick did not republish')
  report.status='passed'
 }catch(error){report.status='failed';report.failure=safe(error.stack??error);console.error('FAIL',report.failure);if(window){report.ui_text=await js('document.body.innerText').catch(()=>null);await shot('failure').catch(()=>{})}}
 finally{if(handedOff)return;await close().catch(error=>{report.status='failed';report.cleanup_error=safe(error.message)});report.finished_at=new Date().toISOString();await persist();console.log('Brief report:',output);window?.destroy();app.exit(report.status==='passed'?0:1)}
}
await mkdir('/tmp/nova-source-live',{recursive:true})
void main().catch(error=>{console.error(error.name,error.message);app.exit(1)})
