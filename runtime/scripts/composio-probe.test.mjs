import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {requestJson,summarize,classify,effectiveKey,createBudget,executeRead,toolContract} from './composio-probe.mjs'

const path='/api/v3.1/tools/GMAIL_GET_PROFILE?version=20260915_00'
const options={method:'GET',apiKey:'fixture'}
test('probe admits only fixed connection routes and rejects write tools at transport boundary',async()=>{
 const fake=async()=>new Response('{}')
 await assert.doesNotReject(requestJson('/api/v3.1/connected_accounts?auth_config_ids=ac_fixture',options,fake))
 await assert.rejects(requestJson('/api/v3.1/connected_accounts?auth_config_ids=ac_fixture&extra=yes',options,fake),/route_denied/)
 await assert.doesNotReject(requestJson('/api/v3.1/auth_configs?toolkit_slug=gmail',options,fake))
 await assert.doesNotReject(requestJson('/api/v3.1/connected_accounts/link',{...options,method:'POST',body:{auth_config_id:'ac_fixture',user_id:'nova-fixture'}},fake))
 await assert.rejects(requestJson('/api/v3.1/tools/execute/GMAIL_SEND_EMAIL',{...options,method:'POST',body:{}},fake),/route_denied/)
 await assert.rejects(requestJson('/api/v3.1/connected_accounts/ca_x?redirect=https://evil.test',options,fake),/route_denied/)
})
test('catalog captures only pinned public schema and rejects misleading successful envelopes',()=>{
 const data={slug:'GMAIL_GET_PROFILE',version:'20260915_00',input_parameters:{type:'object'},output_parameters:{type:'object'},token:'private'}
 const contract=toolContract(data.slug,{status:200,data})
 assert.deepEqual(contract.input_parameters,{type:'object'});assert.equal(contract.schema_sha256.length,64)
 assert.equal('token' in contract,false)
 for(const result of [{status:200,data:{}},{status:200,data:{...data,version:'latest'}},{status:401,data}])assert.throws(()=>toolContract(data.slug,result),/invalid_tool_contract/)
})
test('probe report drops all raw private response fields',()=>{
 assert.deepEqual(summarize({caseId:'routing',status:'pass',layer:'live',checks:{identity_matches:true},raw:'private body',token:'secret'}),{caseId:'routing',status:'pass',layer:'live',checks:{identity_matches:true}})
 assert.throws(()=>summarize({caseId:'routing',status:'pass',layer:'live',checks:{body:'private'}}))
})
test('response cap works without Content-Length and request cannot follow redirects',async()=>{
 await assert.rejects(requestJson(path,options,async()=>new Response('x'.repeat(2*1024*1024+1))),/response_too_large/)
 await assert.rejects(requestJson(path,options,async(_url,init)=>{assert.equal(init.redirect,'error');return new Response(null,{status:302})}),/redirect_denied/)
 await assert.rejects(requestJson('https://evil.test/',options,async()=>{assert.fail('must not send key')}),/route_denied/)
})
test('HTML errors do not leak snippets and Retry-After survives',async()=>{
 assert.deepEqual(await requestJson(path,options,async()=>new Response('secret HTML',{status:500})),{status:500,data:null,retryAfter:null,error:'invalid_json'})
 const result=await requestJson(path,options,async()=>new Response('{}',{status:429,headers:{'Retry-After':'120'}}))
 assert.equal(result.retryAfter,'120');assert.equal(result.status,429)
})
test('cancel and round budgets stop requests before admission',async()=>{
 await assert.rejects(requestJson(path,{...options,signal:AbortSignal.abort()},async()=>assert.fail('aborted request sent')))
 const budget=createBudget();budget.requests=20
 await assert.rejects(requestJson(path,{...options,budget},async()=>assert.fail('budget request sent')),/budget_exhausted/)
})
test('write tools, dynamic versions and unverified scope never reach transport',async()=>{
 let calls=0;const fetch=async()=>{calls++;return new Response('{}')}
 for(const input of [{slug:'GMAIL_SEND_EMAIL',version:'20260915_00'},{slug:'GMAIL_GET_PROFILE',version:'latest'},{slug:'GMAIL_FETCH_EMAILS',version:'20260915_00'}])await assert.rejects(executeRead({...input,userId:'u',accountId:'a',arguments:{},apiKey:'fixture'},fetch))
 assert.equal(calls,0)
})
test('provider status classification separates cursor failure from absent object',()=>{
 assert.equal(classify('gmail-history',404),'cursor_expired')
 assert.equal(classify('gmail-message',404),'object_unavailable')
 assert.equal(classify('calendar-events',410),'cursor_expired')
 assert.equal(classify('calendar-events',403),'permission_denied')
 assert.equal(classify('calendar-events',429),'rate_limited')
 assert.equal(classify('calendar-events',undefined),'unknown')
})
test('explicit clear blocks stale parent key while unset preserves CLI inheritance',()=>{
 assert.equal(effectiveKey({kind:'cleared'},'fixture-old'),undefined)
 assert.equal(effectiveKey({kind:'unset'},'fixture-old'),'fixture-old')
 assert.equal(effectiveKey({kind:'saved',value:'fixture-new'},'fixture-old'),'fixture-new')
})
test('cancellation interrupts an open body stream',async()=>{
 const controller=new AbortController()
 const pending=requestJson(path,{...options,signal:controller.signal},async()=>new Response(new ReadableStream({start(){controller.abort()}})))
 await assert.rejects(pending)
})
test('spawn captures environment until a new process starts',async()=>{
 const child=spawn(process.execPath,['-e',"process.stdin.once('data',()=>console.log(JSON.stringify({matchesExpected:process.env.COMPOSIO_API_KEY==='fixture-old'})))"],{env:{...process.env,COMPOSIO_API_KEY:'fixture-old'},stdio:['pipe','pipe','pipe']})
 const nextEnv={...process.env,COMPOSIO_API_KEY:'fixture-new'}
 const collect=process=>new Promise((resolve,reject)=>{let out='';process.stdout.on('data',chunk=>out+=chunk);process.on('error',reject);process.on('close',code=>code===0?resolve(JSON.parse(out)):reject(Error('child_failed')))})
 const oldResult=collect(child);child.stdin.end('check')
 assert.deepEqual(await oldResult,{matchesExpected:true})
 const next=spawn(process.execPath,['-e',"console.log(JSON.stringify({matchesExpected:process.env.COMPOSIO_API_KEY==='fixture-new'}))"],{env:nextEnv,stdio:['ignore','pipe','pipe']})
 assert.deepEqual(await collect(next),{matchesExpected:true})
})

test('live probe gates source reads on unique route and actual provider identity',async()=>{
 const {runReadProbe}=await import('./composio-probe.mjs')
 const connection={toolkit:'gmail',userId:'nova-fixture',connectedAccountId:'ca_fixture',expectedIdentity:'fixture@example.test',scope:{kind:'gmail',label:'INBOX',pastDays:30}}
 let calls=[]
 const fake=async(url,options)=>{calls.push(url);return new Response(JSON.stringify(url.includes('connected_accounts?')?{items:[{id:'ca_fixture',toolkit:{slug:'gmail'}}]}:{successful:true,data:{emailAddress:'wrong@example.test'}}))}
 await assert.rejects(runReadProbe('gmail',connection,'fixture',fake),/identity_mismatch/)
 assert.equal(calls.length,2)
 calls=[]
 await assert.rejects(runReadProbe('gmail',connection,'fixture',async()=>{calls.push(1);return new Response(JSON.stringify({items:[]}))}),/routing_unverified/)
 assert.equal(calls.length,1)
})
test('live Gmail probe follows opaque pagination and returns only bounded summary',async()=>{
 const {runReadProbe}=await import('./composio-probe.mjs')
 const connection={toolkit:'gmail',userId:'nova-fixture',connectedAccountId:'ca_fixture',expectedIdentity:'fixture@example.test',scope:{kind:'gmail',label:'INBOX',pastDays:30}}
 let pages=0
 const fake=async(url,options)=>{
  if(url.includes('connected_accounts?'))return new Response(JSON.stringify({items:[{id:'ca_fixture',toolkit:{slug:'gmail'}}]}))
  const body=JSON.parse(options.body);assert.equal(body.version,'20260915_00');assert.equal(body.connected_account_id,'ca_fixture')
  let data
  if(url.endsWith('GMAIL_GET_PROFILE'))data={emailAddress:connection.expectedIdentity,historyId:'900719925474099300'}
  else if(url.endsWith('GMAIL_FETCH_EMAILS')){assert.deepEqual(body.arguments.label_ids,['INBOX']);assert.match(body.arguments.query,/^after:\d+ before:\d+$/);assert.equal(body.arguments.max_results,2);if(pages)assert.equal(body.arguments.page_token,'opaque');data={messages:[{messageId:String(++pages)}],nextPageToken:pages===1?'opaque':''}}
  else if(url.endsWith('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'))data={messageId:'1',labelIds:['INBOX'],messageTimestamp:new Date(Date.now()-1000).toISOString(),messageText:'secret'}
  else if(url.endsWith('GMAIL_LIST_HISTORY')){assert.equal(body.arguments.start_history_id,'900719925474099300');data={history:[],historyId:'900719925474099301'}}
  else assert.fail('unexpected tool')
  return new Response(JSON.stringify({successful:true,data}))
 }
 const report=await runReadProbe('gmail',connection,'fixture',fake)
 assert.equal(report.status,'pass');assert.equal(report.checks.pages,2);assert.equal(report.checks.objects,2)
 assert.equal(JSON.stringify(report).includes('secret'),false)
})

test('calendar probe treats HTTP 200 successful false as failure and empty calendars honestly',async()=>{
 const {runReadProbe}=await import('./composio-probe.mjs')
 const c={toolkit:'googlecalendar',userId:'nova-fixture',connectedAccountId:'ca_fixture',expectedIdentity:'fixture@example.test',scope:{kind:'calendar',calendar:'primary',pastDays:30,futureDays:90}}
 const transport=failed=>async(url)=>new Response(JSON.stringify(url.includes('connected_accounts?')?{items:[{id:c.connectedAccountId,toolkit:{slug:c.toolkit}}]}:url.endsWith('GET_CURRENT_USER')?{successful:true,data:{email:c.expectedIdentity}}:failed?{successful:false,data:{status_code:410},error:'private detail'}:{successful:true,data:{items:[],nextSyncToken:'private cursor'}}))
 await assert.rejects(runReadProbe('calendar',c,'fixture',transport(true)),/provider_read_failed/)
 const r=await runReadProbe('calendar',c,'fixture',transport(false))
 assert.equal(r.checks.objects,0);assert.equal(r.checks.sync_token_present,true)
 assert.equal(JSON.stringify(r).includes('private'),false)
})

test('missing or different approved scope fails before any network request',async()=>{
 const {runReadProbe}=await import('./composio-probe.mjs')
 const c={toolkit:'gmail',userId:'nova-fixture',connectedAccountId:'ca_fixture',expectedIdentity:'fixture@example.test'}
 for(const scope of [undefined,{kind:'gmail',label:'OTHER',pastDays:30}])await assert.rejects(runReadProbe('gmail',{...c,scope},'fixture',async()=>assert.fail('must not read')),/scope_unverified/)
})
