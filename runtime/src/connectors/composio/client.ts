import {z} from 'zod'
import {abortable} from '../../core/camera-session.js'
import {readBoundedResponse} from '../../http/bounded-response.js'

export const COMPOSIO_VERSION='20260915_00'
export const toolkitSchema=z.enum(['gmail','googlecalendar'])
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u)
const opaque=z.string().min(1).max(16384)
export const googleScopeSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('gmail'),labels:z.array(z.string().min(1).max(256)).min(1).max(20),pastDays:z.number().int().min(1).max(365)}).strict(),
 z.object({kind:z.literal('calendar'),calendars:z.array(z.string().min(1).max(1024)).min(1).max(20),pastDays:z.number().int().min(1).max(365),futureDays:z.number().int().min(1).max(365)}).strict(),
])
export type GoogleScope=z.infer<typeof googleScopeSchema>
export const bindingSchema=z.object({toolkit:toolkitSchema,userId:id,accountId:id,authConfigId:id,identity:z.string().email().max(320)}).strict()
export type GoogleBinding=z.infer<typeof bindingSchema>
export interface VerifiedConnection {readonly identity:string;readonly scope:GoogleScope}
export interface ComposioBudget {requests:number;bytes:number;deadline:number;scopeAnchor:number;signal:AbortSignal}
export function createComposioBudget(signal?:AbortSignal,scopeAnchor=Date.now()):ComposioBudget{
 const now=Date.now()
 if(!Number.isFinite(scopeAnchor)||scopeAnchor<now-86400000||scopeAnchor>now+60000)throw new ComposioFailure('snapshot_expired')
 return {requests:0,bytes:0,deadline:now+30000,scopeAnchor,signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])])}
}

export class ComposioFailure extends Error {
 constructor(readonly code:string,readonly retryAfter:number|null=null){super(code);this.name='ComposioFailure'}
}
const record=z.record(z.string(),z.unknown())
const pageToken={pageToken:opaque.optional()}
const readSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('gmail.labels')}).strict(),
 z.object({kind:z.literal('gmail.profile')}).strict(),
 z.object({kind:z.literal('gmail.list'),after:z.number().int().nonnegative(),before:z.number().int().positive(),...pageToken}).strict(),
 z.object({kind:z.literal('gmail.message'),messageId:z.string().regex(/^[a-fA-F0-9]{1,128}$/u),format:z.enum(['minimal','metadata','full'])}).strict(),
 z.object({kind:z.literal('gmail.history'),historyId:z.string().regex(/^\d{1,100}$/u),...pageToken}).strict(),
 z.object({kind:z.literal('calendar.calendars'),...pageToken}).strict(),
 z.object({kind:z.literal('calendar.list'),calendarId:opaque,timeMin:z.iso.datetime({offset:true}),timeMax:z.iso.datetime({offset:true}),...pageToken}).strict(),
])
export type GoogleRead=z.infer<typeof readSchema>
const failure=(code:string)=>new ComposioFailure(code)
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const r=schema.safeParse(value);if(!r.success)throw failure('invalid_contract');return r.data}
function statusFailure(status:number,retryAfter:number|null=null):ComposioFailure{
 return new ComposioFailure(status===401?'authorization_required':status===403?'permission_denied':status===429?'rate_limited':status===410?'cursor_expired':status===404?'not_found':status>=300&&status<400?'redirect_denied':'provider_failed',retryAfter)
}
/** Credentials and the arbitrary tool execution endpoint stay private to this host-owned client. */
export class ComposioClient {
 readonly #verified=new WeakMap<object,{binding:GoogleBinding;scope:GoogleScope;budget:ComposioBudget}>()
 readonly #key:string
 constructor(key:string,readonly fetcher:typeof fetch=fetch){if(!key||key.length>4096)throw failure('key_required');this.#key=key}
 async #request(path:string,method:'GET'|'POST',budget:ComposioBudget,body?:unknown):Promise<Record<string,unknown>>{
  budget.signal.throwIfAborted()
  if(budget.requests>=20||budget.bytes>=5*1024*1024||Date.now()>=budget.deadline)throw failure('budget_exhausted')
  const json=body===undefined?undefined:JSON.stringify(body)
  if(json&&Buffer.byteLength(json)>65536)throw failure('request_too_large')
  budget.requests++
  const signal=AbortSignal.any([budget.signal,AbortSignal.timeout(15000)])
  try{
   const response=await abortable(this.fetcher('https://backend.composio.dev/api/v3.1'+path,{method,redirect:'error',signal,headers:{'x-api-key':this.#key,'Content-Type':'application/json'},...(json?{body:json}:{})}),signal)
   if(!response.ok){void response.body?.cancel().catch(()=>{ /* abandoned error response */ });const header=response.headers.get('Retry-After');throw statusFailure(response.status,header&&/^\d+$/u.test(header)?Math.min(Number(header),86400):null)}
   const bytes=await readBoundedResponse(response,{limit:2*1024*1024,signal,failure,consume:n=>{budget.bytes+=n;if(budget.bytes>5*1024*1024||Date.now()>=budget.deadline)throw failure('budget_exhausted')}})
   return parse(record,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))
  }catch(error){if(error instanceof ComposioFailure)throw error;throw failure(signal.aborted?'cancelled':'transport_failed')}
 }
 async createAuthConfig(toolkit:z.infer<typeof toolkitSchema>,budget:ComposioBudget):Promise<string>{
  toolkit=parse(toolkitSchema,toolkit)
  const d=await this.#request('/auth_configs','POST',budget,{toolkit:{slug:toolkit},auth_config:{type:'use_composio_managed_auth',name:'Nova readonly connector'}})
  return parse(z.object({auth_config:z.object({id})}),d).auth_config.id
 }
 async link(authConfigId:string,userId:string,budget:ComposioBudget):Promise<{accountId:string;url:string;expiresAt:string}>{
  const d=await this.#request('/connected_accounts/link','POST',budget,{auth_config_id:parse(id,authConfigId),user_id:parse(id,userId)})
  const r=parse(z.object({connected_account_id:id,redirect_url:z.string().url().max(4096),expires_at:z.string().max(100)}),d)
  const url=new URL(r.redirect_url)
  if(url.origin!=='https://connect.composio.dev'||url.username||url.password||!url.pathname.startsWith('/link/'))throw failure('redirect_denied')
  return {accountId:r.connected_account_id,url:r.redirect_url,expiresAt:r.expires_at}
 }
 async #execute(binding:GoogleBinding,slug:string,args:Record<string,unknown>,budget:ComposioBudget):Promise<Record<string,unknown>>{
  const r=await this.#request('/tools/execute/'+slug,'POST',budget,{version:COMPOSIO_VERSION,user_id:binding.userId,connected_account_id:binding.accountId,arguments:args})
  if(r.successful!==true){const nested=record.safeParse(r.data);const status=nested.success?Number(nested.data.status_code):NaN;throw Number.isInteger(status)&&status>=400&&status<600?statusFailure(status):failure('provider_failed')}
  return parse(record,r.data)
 }
 async inspect(toolkit:z.infer<typeof toolkitSchema>,userId:string,accountId:string,authConfigId:string,budget:ComposioBudget):Promise<{identity:string;requestedScopes:string[]}>{
  toolkit=parse(toolkitSchema,toolkit);userId=parse(id,userId);accountId=parse(id,accountId);authConfigId=parse(id,authConfigId)
  const list=await this.#request(`/connected_accounts?user_ids=${userId}&statuses=ACTIVE`,'GET',budget)
  const accounts=parse(z.array(z.object({id,toolkit:z.object({slug:toolkitSchema}),auth_config:z.object({id}),is_disabled:z.boolean().optional()})).max(100),list.items)
  const c=accounts[0]
  if(accounts.length!==1||list.next_cursor||c?.id!==accountId||c.toolkit.slug!==toolkit||c.auth_config.id!==authConfigId||c.is_disabled)throw failure('connection_unverified')
  const p=await this.#execute({toolkit,userId,accountId,authConfigId,identity:''},toolkit==='gmail'?'GMAIL_GET_PROFILE':'GOOGLECALENDAR_GET_CURRENT_USER',toolkit==='gmail'?{user_id:'me'}:{},budget)
  const identity=parse(z.string().email().max(320),p[toolkit==='gmail'?'emailAddress':'email'])
  // Requested scopes are unknown unless actually returned; never infer a read-only grant.
  return {identity,requestedScopes:[]}
 }
 async verify(binding:GoogleBinding,scope:GoogleScope,budget:ComposioBudget):Promise<VerifiedConnection>{
  binding=parse(bindingSchema,binding);scope=parse(googleScopeSchema,scope)
  if((binding.toolkit==='gmail')!==(scope.kind==='gmail'))throw failure('scope_denied')
  const p=await this.inspect(binding.toolkit,binding.userId,binding.accountId,binding.authConfigId,budget)
  if(p.identity!==binding.identity)throw failure('identity_mismatch')
  const handle={identity:p.identity,scope:structuredClone(scope)}
  this.#verified.set(handle,{binding:structuredClone(binding),scope:structuredClone(scope),budget})
  return handle
 }
 async scopes(binding:GoogleBinding,pageToken?:string):Promise<{items:{id:string;name:string}[];next:string|null}>{
  const budget=createComposioBudget(),scope:GoogleScope=binding.toolkit==='gmail'?{kind:'gmail',labels:['INBOX'],pastDays:30}:{kind:'calendar',calendars:['primary'],pastDays:30,futureDays:90}
  const verified=await this.verify(binding,scope,budget)
  const d=await this.read(verified,binding.toolkit==='gmail'?{kind:'gmail.labels'}:{kind:'calendar.calendars',...(pageToken?{pageToken}:{})},budget)
  const items=parse(z.array(z.object({id:z.string().min(1).max(1024),name:z.string().max(1000).optional(),summary:z.string().max(1000).optional()})).max(1000),d[binding.toolkit==='gmail'?'labels':'calendars'])
  return {items:items.map(i=>({id:i.id,name:i.name??i.summary??i.id})),next:parse(opaque.nullable(),d.next_page_token??null)}
 }
 async read(handle:VerifiedConnection,input:GoogleRead,budget:ComposioBudget):Promise<Record<string,unknown>>{
  const verified=this.#verified.get(handle);if(verified?.budget!==budget)throw failure('connection_unverified')
  const request=parse(readSchema,input),{binding,scope}=verified
  if(request.kind.startsWith('gmail.')!==(scope.kind==='gmail'))throw failure('scope_denied')
  const now=budget.scopeAnchor
  let slug:string,args:Record<string,unknown>
  switch(request.kind){
   case 'gmail.profile':slug='GMAIL_GET_PROFILE';args={user_id:'me'};break
   case 'gmail.labels':slug='GMAIL_LIST_LABELS';args={user_id:'me'};break
   case 'gmail.list':{
    if(request.after*1000<now-scope.pastDays*86400000-60000||request.before*1000>now+60000||request.before<=request.after||request.before-request.after>(scope.pastDays+1)*86400)throw failure('scope_denied')
    slug='GMAIL_FETCH_EMAILS';args={user_id:'me',label_ids:scope.kind==='gmail'?scope.labels:[],query:`after:${request.after} before:${request.before}`,max_results:100,ids_only:true,include_payload:false,...(request.pageToken?{page_token:request.pageToken}:{})};break
   }
   case 'gmail.message':slug='GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID';args={user_id:'me',message_id:request.messageId,format:request.format};break
   // Read all history metadata so label removals are not lost; the provider scopes message bodies.
   case 'gmail.history':slug='GMAIL_LIST_HISTORY';args={user_id:'me',start_history_id:request.historyId,max_results:100,...(request.pageToken?{page_token:request.pageToken}:{})};break
   case 'calendar.calendars':slug='GOOGLECALENDAR_LIST_CALENDARS';args={max_results:100,...(request.pageToken?{page_token:request.pageToken}:{})};break
   case 'calendar.list':{
    if(scope.kind!=='calendar'||!scope.calendars.includes(request.calendarId)||Date.parse(request.timeMin)<now-scope.pastDays*86400000-60000||Date.parse(request.timeMax)>now+scope.futureDays*86400000+60000||Date.parse(request.timeMax)<=Date.parse(request.timeMin)||Date.parse(request.timeMax)-Date.parse(request.timeMin)>(scope.pastDays+scope.futureDays+1)*86400000)throw failure('scope_denied')
    slug='GOOGLECALENDAR_EVENTS_LIST';args={calendarId:request.calendarId,timeMin:request.timeMin,timeMax:request.timeMax,singleEvents:true,showDeleted:true,maxResults:100,...(request.pageToken?{pageToken:request.pageToken}:{})};break
   }
  }
  try{return await this.#execute(binding,slug,args,budget)}catch(error){if(request.kind==='gmail.history'&&error instanceof ComposioFailure&&error.code==='not_found')throw failure('cursor_expired');throw error}
 }
}
