import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {writeFile,readFile,lstat} from 'node:fs/promises'

export const VERSION = '20260915_00'
export const READ_TOOLS = ['GMAIL_GET_PROFILE','GMAIL_LIST_HISTORY','GMAIL_FETCH_EMAILS','GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID','GMAIL_LIST_LABELS','GOOGLECALENDAR_GET_CURRENT_USER','GOOGLECALENDAR_LIST_CALENDARS','GOOGLECALENDAR_EVENTS_LIST','GOOGLECALENDAR_EVENTS_GET','GOOGLECALENDAR_EVENTS_INSTANCES']
export const createBudget = () => ({requests:0,bytes:0,started:Date.now()})
export const effectiveKey = (setting,parent) => setting.kind==='cleared'?undefined:setting.kind==='saved'?setting.value:parent
export function toolContract(slug,{status,data}) {
  const schema=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&value.type==='object'
  if(status!==200||!READ_TOOLS.includes(slug)||data?.slug!==slug||data.version!==VERSION||!schema(data.input_parameters)||!schema(data.output_parameters))throw Error('invalid_tool_contract')
  const contract={slug,version:VERSION,input_parameters:data.input_parameters,output_parameters:data.output_parameters}
  return {...contract,schema_sha256:createHash('sha256').update(JSON.stringify(contract)).digest('hex')}
}
export function summarize({caseId,status,layer,checks={}}) {
  if (!/^[a-z-]{1,60}$/.test(caseId)||!['pass','fail','unobserved'].includes(status)||!['offline','live','catalog'].includes(layer)) throw Error('invalid_summary')
  for (const [key,value] of Object.entries(checks)) if(!/^[a-z_]{1,60}$/.test(key)||!(typeof value==='boolean'||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)) throw Error('invalid_check')
  return {caseId,status,layer,checks}
}
export function classify(kind,status) {
  if(status===429)return 'rate_limited'
  if(status===403)return 'permission_denied'
  if(status===401)return 'authorization_required'
  if(kind==='gmail-history'&&status===404||kind==='calendar-events'&&status===410)return 'cursor_expired'
  if(kind==='gmail-message'&&status===404)return 'object_unavailable'
  return status>=200&&status<300?'ok':'unknown'
}
export async function requestJson(path,{method='GET',apiKey,signal,budget=createBudget(),body},fetcher=fetch) {
  const read=method==='GET'&&(READ_TOOLS.some(slug=>path===`/api/v3.1/tools/${slug}?version=${VERSION}`)||/^\/api\/v3\.1\/auth_configs\?toolkit_slug=(gmail|googlecalendar)$/.test(path)||/^\/api\/v3\.1\/connected_accounts(?:\/[a-zA-Z0-9_-]{1,128}|\?user_ids=[a-zA-Z0-9_-]{1,128}&statuses=ACTIVE|\?auth_config_ids=[a-zA-Z0-9_-]{1,128})$/.test(path))
  const write=method==='POST'&&(path==='/api/v3.1/connected_accounts/link'||path==='/api/v3.1/auth_configs'||READ_TOOLS.some(slug=>path===`/api/v3.1/tools/execute/${slug}`&&body?.version===VERSION))
  if(!read&&!write)throw Error('route_denied')
  if(body&&Buffer.byteLength(JSON.stringify(body))>65536)throw Error('request_too_large')
  const abort=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)])
  abort.throwIfAborted()
  if(budget.requests>=20||budget.bytes>=5*1024*1024||Date.now()-budget.started>=30000)throw Error('budget_exhausted')
  budget.requests++
  let reader
  try {
    const response=await fetcher(`https://backend.composio.dev${path}`,{method,redirect:'error',signal:abort,headers:{'x-api-key':apiKey,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
    if(response.status>=300&&response.status<400)throw Error('redirect_denied')
    if(Number(response.headers.get('Content-Length'))>2*1024*1024)throw Error('response_too_large')
    reader=response.body?.getReader()
    const parts=[];let size=0
    if(reader)for(;;){
      abort.throwIfAborted()
      let onAbort
      const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(Error('request_aborted'));abort.addEventListener('abort',onAbort,{once:true})})
      let chunk
      try {chunk=await Promise.race([reader.read(),cancelled])}finally{abort.removeEventListener('abort',onAbort)}
      if(chunk.done)break
      size+=chunk.value.byteLength;budget.bytes+=chunk.value.byteLength
      if(size>2*1024*1024)throw Error('response_too_large')
      if(budget.bytes>5*1024*1024||Date.now()-budget.started>=30000)throw Error('budget_exhausted')
      parts.push(Buffer.from(chunk.value))
    }
    const result={status:response.status,data:null,retryAfter:response.headers.get('Retry-After')}
    try{return {...result,data:JSON.parse(Buffer.concat(parts).toString('utf8'))}}catch{return {...result,error:'invalid_json'}}
  }finally{if(reader)await reader.cancel().catch(()=>{})}
}
export async function executeRead(input,fetcher=fetch) {
  if(!READ_TOOLS.includes(input.slug))throw Error('tool_denied')
  if(input.version!==VERSION)throw Error('version_unpinned')
  // Live schemas and selected account/scope must be reviewed before enabling execution.
  // This probe deliberately cannot read mailbox contents before that gate is met.
  throw Error('live_contract_unverified')
}
export async function runReadProbe(mode,connection,apiKey,fetcher=fetch) {
  const toolkit=mode==='calendar'?'googlecalendar':mode==='gmail'?'gmail':null
  if(!toolkit||connection?.toolkit!==toolkit||!apiKey||![connection.userId,connection.connectedAccountId].every(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(x))||typeof connection.expectedIdentity!=='string'||!connection.expectedIdentity.includes('@'))throw Error('invalid_probe_connection')
  const scope=connection.scope
  if(!scope||scope.kind!==mode||scope.pastDays!==30||(mode==='gmail'?scope.label!=='INBOX':scope.calendar!=='primary'||scope.futureDays!==90))throw Error('scope_unverified')
  const budget=createBudget(), options={apiKey,budget}
  const account=await requestJson(`/api/v3.1/connected_accounts?user_ids=${connection.userId}&statuses=ACTIVE`,options,fetcher)
  const items=account.data?.items
  if(account.status!==200||items?.length!==1||account.data.next_cursor||items[0].id!==connection.connectedAccountId||items[0].toolkit?.slug!==toolkit||items[0].is_disabled===true)throw Error('routing_unverified')
  const call=async(slug,args)=>{
    const r=await requestJson(`/api/v3.1/tools/execute/${slug}`,{...options,method:'POST',body:{version:VERSION,user_id:connection.userId,connected_account_id:connection.connectedAccountId,arguments:args}},fetcher)
    if(r.status!==200||r.data?.successful!==true||!r.data.data||typeof r.data.data!=='object')throw Error('provider_read_failed')
    return r.data.data
  }
  const profile=await call(mode==='gmail'?'GMAIL_GET_PROFILE':'GOOGLECALENDAR_GET_CURRENT_USER',mode==='gmail'?{user_id:'me'}:{})
  if((mode==='gmail'?profile.emailAddress:profile.email)!==connection.expectedIdentity)throw Error('identity_mismatch')
  const now=Date.now(),lower=now-30*86400000,upper=now+90*86400000
  const base=mode==='gmail'?{user_id:'me',label_ids:['INBOX'],query:`after:${Math.floor(lower/1000)} before:${Math.floor(now/1000)}`,max_results:2,ids_only:true,include_payload:false}:{calendarId:'primary',timeMin:new Date(lower).toISOString(),timeMax:new Date(upper).toISOString(),singleEvents:true,showDeleted:true,maxResults:2}
  let token='',pages=0,objects=[],syncToken
  const tokens=new Set()
  do {
    const d=await call(mode==='gmail'?'GMAIL_FETCH_EMAILS':'GOOGLECALENDAR_EVENTS_LIST',{...base,...(token?{[mode==='gmail'?'page_token':'pageToken']:token}:{})})
    const page=mode==='gmail'?d.messages:d.items
    if(!Array.isArray(page)||page.length>2)throw Error('invalid_page')
    const ids=page.map(x=>mode==='gmail'?x.messageId:x.id)
    if(ids.some(x=>typeof x!=='string'||!x))throw Error('invalid_object_id')
    objects.push(...ids);token=d.nextPageToken;syncToken=d.nextSyncToken;pages++
    if(token&&(typeof token!=='string'||token.length>16384||tokens.has(token)))throw Error('invalid_page_token')
    if(token)tokens.add(token)
  }while(token&&pages<3)
  const checks={identity_matches:true,unique_active_route:true,pages,objects:objects.length,distinct_objects:new Set(objects).size,has_more:!!token}
  if(mode==='gmail'){
    if(objects[0]){
      const d=await call('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',{user_id:'me',message_id:objects[0],format:'full'})
      if(d.messageId!==objects[0])throw Error('object_mismatch')
      const timestamp=Date.parse(d.messageTimestamp)
      checks.message_in_scope=Array.isArray(d.labelIds)&&d.labelIds.includes('INBOX')&&Number.isFinite(timestamp)&&timestamp>=lower&&timestamp<=now
      checks.message_text_present=typeof d.messageText==='string'
    }
    if(typeof profile.historyId!=='string'||!/^\d+$/.test(profile.historyId))throw Error('invalid_history_cursor')
    const h=await call('GMAIL_LIST_HISTORY',{user_id:'me',start_history_id:profile.historyId,label_id:'INBOX',max_results:2})
    checks.history_cursor_present=typeof h.historyId==='string'&&/^\d+$/.test(h.historyId)
    checks.history_records=Array.isArray(h.history)?h.history.length:0
  }else checks.sync_token_present=typeof syncToken==='string'&&syncToken.length>0
  return summarize({caseId:`${mode}-read`,status:checks.message_in_scope===false||checks.history_cursor_present===false?'fail':'pass',layer:'live',checks})
}
async function main() {
  const mode=process.argv[2]
  if(mode==='gmail'||mode==='calendar'){
    const path=process.argv[3]
    if(!path)throw Error('private_state_required')
    const info=await lstat(path)
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.size>65536)throw Error('private_state_required')
    const state=JSON.parse(await readFile(path,'utf8'))
    const connections=state.connections?.filter(x=>x.toolkit===(mode==='gmail'?'gmail':'googlecalendar'))
    if(connections?.length!==1)throw Error('ambiguous_connection')
    console.log(JSON.stringify(await runReadProbe(mode,connections[0],process.env.COMPOSIO_API_KEY)))
    return
  }
  if(mode!=='catalog')throw Error('usage: composio-probe.mjs catalog [output] | gmail|calendar private-state')
  if(!process.env.COMPOSIO_API_KEY){console.log(JSON.stringify(summarize({caseId:'catalog',status:'unobserved',layer:'live',checks:{key_present:false}})));return}
  const budget=createBudget()
  const contracts=[]
  for(const slug of READ_TOOLS){
    const result=await requestJson(`/api/v3.1/tools/${slug}?version=${VERSION}`,{apiKey:process.env.COMPOSIO_API_KEY,budget})
    contracts.push(toolContract(slug,result))
    console.log(JSON.stringify(summarize({caseId:'catalog',status:'pass',layer:'live',checks:{http_status:result.status,schema_present:true}})))
  }
  if(process.argv[3])await writeFile(process.argv[3],JSON.stringify({checked_at:new Date().toISOString(),tool_version:VERSION,contracts},null,2)+'\n',{flag:'wx',mode:0o600})
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('composio_probe_failed');process.exitCode=1})
