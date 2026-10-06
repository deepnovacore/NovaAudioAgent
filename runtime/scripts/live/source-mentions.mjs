/** Real model and durable runtime; only remote connector responses are synthetic. */
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {loadSettings,resolveModelApiKey} from '../../dist/src/config/config.js'
import {OpenAIModelGateway} from '../../dist/src/model/model-gateway.js'
import {RealClock} from '../../dist/src/core/clock.js'
import {MemoryLedgerClient} from '../../dist/src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../../dist/src/memory-substrate/resource.js'
import {LifeService} from '../../dist/src/personal-agent/life.js'
import {FeishuConnector,FEISHU_SCOPES} from '../../dist/src/connectors/feishu/index.js'
if(process.env.NOVA_LIVE_ENV_FILE)process.loadEnvFile(process.env.NOVA_LIVE_ENV_FILE)
const settings=loadSettings(),key=resolveModelApiKey(settings)
assert.ok(key,'real configured model required')
await mkdir('/tmp/nova-source-live',{recursive:true})
const dir=await realpath(await mkdtemp('/tmp/nova-source-live/mentions-')),report={synthetic:true,model:settings.fast_model,status:'running',cases:[],calls:[],checks:[],limitations:['Synthetic connector responses; actual Feishu permissions and API are verified separately. No messages sent or tasks executed.']}
const persist=()=>writeFile(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n')
const gateway=new OpenAIModelGateway({baseUrl:settings.model_base_url,apiKey:key,clock:new RealClock()}),complete=gateway.complete.bind(gateway)
gateway.complete=async request=>{const start=Date.now(),response=await complete(request);report.calls.push({stage:request.system.startsWith('IM_ACTION')?'action':request.system.startsWith('IM_MATCH')?'match':'memory',input:JSON.parse(request.prompt),output:response.text,ms:Date.now()-start});await persist();return response}
console.log('Report:',join(dir,'report.json'))
try{
 for(let round=1;round<=3;round++){
  const path=join(dir,String(round));await mkdir(path,{mode:0o700})
  const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(path,'ledger.sqlite')),userId:'synthetic-mentions-'+round,gateway,model:settings.fast_model,inputConsent:true,consolidation:{enabled:false,timezone:'Asia/Shanghai'}})
  let life=new LifeService(join(path,'life.json'),()=>{},()=>memory.lifeBackend()),now=new Date(),batch=[]
  const inputRows=[
   {id:'request',text:'@_user_1 请你今天提交星图方案的评审材料，由你负责整理并发给我。',mentions:[{id:'ou_me',id_type:'open_id'}],expected:true},
   {id:'thanks',text:'@_user_1 谢谢，刚才你提交的材料已经收到了，不需要再处理。',mentions:[{id:'ou_me',id_type:'open_id'}],expected:false},
   {id:'fyi',text:'@_user_1 这份信息供你了解，不需要你做任何事情。',mentions:[{id:'ou_me',id_type:'open_id'}],expected:false},
   {id:'quoted',text:'@_user_1 给你看看旧记录，引用：“@小林 请今天提交材料”。这是上个月已完成的工作，你无需处理。',mentions:[{id:'ou_me',id_type:'open_id'}],expected:false},
   {id:'all',text:'@所有人 请提交材料。',mentions:[{id:'all'}],expected:false},
   {id:'other',text:'@小林 请提交材料。',mentions:[{id:'ou_other',id_type:'open_id'}],expected:false},
   {id:'unknown',text:'@我 请提交材料。',expected:false},
  ]
  const connector=new FeishuConnector({executable:'fixture',credentialRoot:join(path,'credentials'),statePath:join(path,'feishu.json'),now:()=>now,processingGrant:(...args)=>memory.processingGrant(...args),onProcessingConsent:async(ids,grant)=>{for(const id of ids)await memory.setProcessingConsent(id,grant)},ingest:async m=>{await memory.ingestEvidence({sourceId:m.source_id,locator:m.locator,text:m.raw_text,observedAt:m.observed_at,kind:'im',processingConsent:m.processing_consent,im:{sender_id:m.sender_id,account_id:m.account_id,provider:'feishu',message_id:m.message_id,chat_id:m.chat_id,recipient_id:m.recipient_id,mention:m.mention,auto_capture:m.auto_capture,sender_name:'测试同事'}})},deleteSource:id=>memory.forgetSource(id),onAction:async()=>{throw Error('no external action allowed')},run:async args=>{
   if(args[0]==='--version')return '1.0.69'
   if(args[1]==='status')return JSON.stringify({appId:'synthetic',identities:{user:{openId:'ou_me',status:'authenticated',scopes:FEISHU_SCOPES}}})
   if(args[1]==='login')return JSON.stringify({verification_url:'https://accounts.feishu.cn/device',device_code:'synthetic',expires_in:900})
   if(args[1]==='+chat-list')return JSON.stringify({items:[{chat_id:'oc_test',name:'Synthetic'}],has_more:false})
   if(args[1]==='+chat-messages-list')return JSON.stringify({items:batch,has_more:false})
   if(args[0]==='api')return JSON.stringify({items:[]})
   return '{}'
  }})
  try{
   await memory.open();await life.open();await connector.open();await connector.beginLogin();await connector.completeLogin();await connector.listChats();await connector.configure(['oc_test'],true);await connector.setProcessingConsent(true);now=new Date(now.getTime()+1000)
   for(const row of inputRows){
    batch=[{message_id:'om_'+row.id,msg_type:'text',content:row.text,create_time:now.toISOString(),sender:{open_id:'ou_sender'},...(row.mentions?{mentions:row.mentions}:{})}]
    await connector.sync();await memory.flush();await life.refresh()
    const todos=life.snapshot().todos,found=todos.filter(t=>t.sources?.some(s=>s.summary===row.text))
    report.cases.push({round,id:row.id,expected:row.expected,actual:found.length,todos:found});await persist()
    assert.equal(found.length,row.expected?1:0,row.id)
   }
   const first=life.snapshot().todos[0];assert.ok(first.sources[0].mentioned_me);assert.equal(first.due,now.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}));assert.equal(life.snapshot().todos.length,1)
   batch=[{message_id:'om_request',msg_type:'text',content:inputRows[0].text,mentions:inputRows[0].mentions,create_time:now.toISOString(),sender:{open_id:'ou_sender'}}]
   await connector.sync();await memory.flush();await life.refresh();assert.equal(life.snapshot().todos.length,1)
   await life.mutate({op:'update',kind:'todo',id:first.id,expected_version:first.version,status:'cancelled',title:'用户保留的标题'},'cancel')
   await life.close();life=new LifeService(join(path,'life.json'),()=>{},()=>memory.lifeBackend());await life.open();await connector.sync();await memory.flush();await life.refresh();assert.equal(life.snapshot().todos[0].status,'cancelled');assert.equal(life.snapshot().todos[0].title,'用户保留的标题')
   report.checks.push('round '+round+': tags/date/negative controls/replay/reopen/manual override passed');await persist();console.log(report.checks.at(-1))
  }finally{await connector.close();await life.close();await memory.close()}
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1}finally{await persist();console.log(report.status,join(dir,'report.json'))}
