import {type MacMailClient,macMailScopeSchema} from '../macos/mail.js'
import {hostname,userInfo} from 'node:os'
import type {MacCalendarClient} from '../macos/calendar.js'
import {randomUUID,createHash} from 'node:crypto'
import {z} from 'zod'
import {ComposioClient,ComposioFailure,createComposioBudget,toolkitSchema,googleScopeSchema,bindingSchema,type GoogleBinding} from './client.js'
import {GoogleProvider,type GooglePage,type GoogleObject} from './google.js'
import type {SubstrateMemoryResource} from '../../memory-substrate/resource.js'
import {connectionSchema,sourceObjectSchema,connectorSourceId,processingGrantSchema,type SourceConnection,type ProcessingGrant} from '../../memory-substrate/source-state.js'
import {EvidenceRecordSchema} from '../../memory-substrate/store.js'
import type {ApplyPage} from '../../memory-substrate/source-operations.js'
import {canonicalJson} from '../../text/canonical-json.js'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const configSchema=z.object({provider:z.enum(['composio','macos_calendar','macos_mail']),toolkit:z.union([toolkitSchema,z.enum(['macos_calendar','macos_mail'])]),userId:z.string(),authConfigId:z.string(),accountId:z.string(),identity:z.string().nullable(),selection:z.union([googleScopeSchema,macMailScopeSchema]).nullable()}).strict()
const stateSchema=z.object({providerCursor:z.json().nullable(),anchor:z.number(),snapshot:z.boolean(),reconciling:z.boolean(),after:z.string().nullable(),nextCheckpoint:z.json().nullable()}).strict()
const checkpointSchema=z.object({historyId:z.string().optional(),fullAt:z.number(),limited:z.boolean().optional()})
const inventorySchema=z.object({connections:z.array(connectionSchema),next:z.string().nullable()})
type Client=Pick<ComposioClient,'createAuthConfig'|'link'|'inspect'|'verify'>&Partial<Pick<ComposioClient,'scopes'>>
type Provider=Pick<GoogleProvider,'page'>
interface Options {memory:()=>SubstrateMemoryResource|undefined;client:Client|null;provider?:Provider;onChange:()=>void;automatic?:boolean;local?:MacCalendarClient;mail?:MacMailClient}
/** One host owns this manager; the existing personal host lock owns its SQLite namespace. */
export class ComposioConnector {
 #timer:ReturnType<typeof setTimeout>|undefined
 #closed=true
 #active=new Map<string,{abort:AbortController;promise:Promise<void>}>()
 #commands:Promise<unknown>=Promise.resolve()
 #rows:Record<string,unknown>[]=[]
 readonly #provider:Provider|null
 constructor(readonly options:Options){this.#provider=options.provider??(options.client instanceof ComposioClient?new GoogleProvider(options.client):null)}
 snapshot(){return {available:!!this.options.client,memory_available:!!this.options.memory(),local_available:!!this.options.local,mail_available:!!this.options.mail,connections:structuredClone(this.#rows)}}
 #memory():SubstrateMemoryResource{const m=this.options.memory();if(!m)throw new ComposioFailure('memory_unavailable');return m}
 async #get(id:string):Promise<SourceConnection>{
  const m=this.#memory();if(!id.startsWith(m.prefix+'connector:'))throw new ComposioFailure('connection_unverified')
  const c=connectionSchema.parse(await m.options.client.memory('source_connection',{action:'get',id}));configSchema.parse(c.scope);return c
 }
 async #list():Promise<SourceConnection[]>{
  const m=this.#memory(),result:SourceConnection[]=[];let after:string|null=null
  do{const p=inventorySchema.parse(await m.options.client.memory('source_connection',{action:'list',prefix:m.prefix+'connector:',after,limit:100}));result.push(...p.connections.filter(c=>configSchema.safeParse(c.scope).success));after=p.next}while(after&&result.length<100)
  return result
 }
 async #refresh():Promise<void>{
  const rows:Record<string,unknown>[]=[]
  for(const c of await this.#list()){
   const conf=configSchema.parse(c.scope),grant=await this.#grant(c),expected=this.#memory().processingGrant(true,grant.revision,c.fence.scope_revision)
   rows.push({id:c.fence.connection_id,toolkit:conf.toolkit,identity:conf.identity,state:conf.identity?c.state:'authorizing',scope:conf.selection,mode:conf.toolkit==='gmail'?'history':'window_snapshot',processing_allowed:!!grant.extraction_provider&&grant.extraction_provider===expected.extraction_provider&&grant.embedding_provider===expected.embedding_provider,has_pending:!!c.continuation||c.deleting.length>0,error:c.sync_status?.error??null,last_attempt:c.sync_status?.attempt_at??null,last_complete:c.sync_status?.complete_at??null,scan_limited:c.checkpoint!==null&&checkpointSchema.parse(c.checkpoint).limited===true,checkpoint_present:!!c.checkpoint})
  }
  this.#rows=rows
  this.options.onChange()
 }
 async open():Promise<void>{this.#closed=false;if(this.options.memory()){for(const c of await this.#list())if(c.deleting.length)await this.#deleteStep(c.fence.connection_id);await this.#refresh();}this.#schedule(1000)}
 async close():Promise<void>{this.#closed=true;clearTimeout(this.#timer);for(const a of this.#active.values())a.abort.abort();await Promise.allSettled([...this.#active.values()].map(x=>x.promise));await this.#commands}
 #schedule(delay:number):void{if(this.#closed||this.options.automatic===false)return;clearTimeout(this.#timer);this.#timer=setTimeout(()=>{void this.#tick()},delay);this.#timer.unref()}
 async #tick():Promise<void>{
  try{for(const c of await this.#list()){if(this.#closed)break;if(c.deleting.length){await this.#deleteStep(c.fence.connection_id);await this.#refresh();continue}if(c.state==='connected'&&(c.sync_status?.retry_at??0)<=Date.now())await this.#run(c.fence.connection_id)}}catch{ /* unavailable memory retries at the next tick */ }
  this.#schedule(this.#rows.some(r=>r.has_pending)?1000:60000)
 }
 async #deleteStep(id:string):Promise<void>{await this.#memory().options.client.memory('source_connection',{action:'delete_step',id,limit:200})}
 command(method:string,params:unknown={}):Promise<unknown>{
  const result=this.#commands.then(()=>this.#command(method,params));this.#commands=result.catch(()=>undefined);return result
 }
 syncOnce(id:string):Promise<void>{if(this.#closed)return Promise.reject(new ComposioFailure('connector_closed'));return this.#run(id)}
 async #command(method:string,params:unknown):Promise<unknown>{
  if(this.#closed)throw new ComposioFailure('connector_closed')
  if(method==='connector.status'){await this.#refresh();return this.snapshot()}
  const m=this.#memory(),client=this.options.client
  if(['connector.mail_status','connector.mail_access','connector.mail_connect'].includes(method)){
   z.object({}).strict().parse(params)
   const mail=this.options.mail;if(!mail)throw new ComposioFailure('native_unavailable')
   if(method!=='connector.mail_connect')return mail.request({command:method==='connector.mail_access'?'request_access':'status'})
   if((await mail.request({command:'status'})).status!=='granted')throw new ComposioFailure('permission_denied')
   const identity=hash(hostname()+':'+userInfo().uid),id=m.prefix+'connector:macos-mail:'+identity.slice(0,16)
   if(await m.options.client.memory('source_connection',{action:'get',id})===null){const c=connectionSchema.parse(await m.options.client.memory('source_connection',{action:'create',id,namespace:id}));await m.options.client.memory('source_connection',{action:'scope',id,expected_scope_revision:c.fence.scope_revision,scope:{provider:'macos_mail',toolkit:'macos_mail',userId:identity,authConfigId:'local',accountId:'local',identity:'Apple Mail',selection:null}})}
   await this.#refresh();return {id}
  }
  if(method==='connector.local_status'||method==='connector.local_access'){
   z.object({}).strict().parse(params)
   if(!this.options.local)throw new ComposioFailure('native_unavailable')
   return this.options.local.request({command:method==='connector.local_status'?'status':'request_access'})
  }
  if(method==='connector.local_connect'){
   z.object({}).strict().parse(params)
   if(!this.options.local||(await this.options.local.request({command:'status'})).status!=='granted')throw new ComposioFailure('permission_denied')
   const identity=hash(hostname()+':'+userInfo().uid),id=m.prefix+'connector:macos-calendar:'+identity.slice(0,16)
   let c=await m.options.client.memory('source_connection',{action:'get',id})
   if(c===null){c=await m.options.client.memory('source_connection',{action:'create',id,namespace:id});await m.options.client.memory('source_connection',{action:'scope',id,expected_scope_revision:connectionSchema.parse(c).fence.scope_revision,scope:{provider:'macos_calendar',toolkit:'macos_calendar',userId:identity,authConfigId:'local',accountId:'local',identity:'本机日历',selection:null}})}
   await this.#refresh();return {id}
  }
  if(method==='connector.link'){
   if(!client)throw new ComposioFailure('key_required')
   const {toolkit}=z.object({toolkit:toolkitSchema}).strict().parse(params)
   if((await this.#list()).length>=20)throw new ComposioFailure('connection_limit')
   const budget=createComposioBudget(),userId='nova-'+randomUUID(),authConfigId=await client.createAuthConfig(toolkit,budget),link=await client.link(authConfigId,userId,budget),id=m.prefix+'connector:'+randomUUID()
   const c=connectionSchema.parse(await m.options.client.memory('source_connection',{action:'create',id,namespace:id}))
   await m.options.client.memory('source_connection',{action:'scope',id,expected_scope_revision:c.fence.scope_revision,scope:{provider:'composio',toolkit,userId,authConfigId,accountId:link.accountId,identity:null,selection:null}})
   await this.#refresh();return {id,url:link.url,expiresAt:link.expiresAt}
  }
  const p=z.object({id:z.string().min(1).max(256)}).passthrough().parse(params),c=await this.#get(p.id),config=configSchema.parse(c.scope)
  if(method==='connector.scopes'){
   const q=z.object({id:z.string(),pageToken:z.string().max(16384).optional()}).strict().parse(params)
   if(config.provider==='macos_mail'){if(!this.options.mail)throw new ComposioFailure('native_unavailable');const r=await this.options.mail.request({command:'list_mailboxes'});if(r.complete!==true)throw new ComposioFailure('snapshot_incomplete');return {items:r.items,next:null}}
   if(config.provider==='macos_calendar'){if(!this.options.local)throw new ComposioFailure('native_unavailable');const r=await this.options.local.request({command:'list_calendars'});return {items:r.items,next:null}}
   if(!config.identity||!client?.scopes)throw new ComposioFailure('connection_unverified')
   return client.scopes(bindingSchema.parse({toolkit:config.toolkit,userId:config.userId,accountId:config.accountId,authConfigId:config.authConfigId,identity:config.identity}),q.pageToken)
  }
  if(method==='connector.complete'){
   z.object({id:z.string()}).strict().parse(params)
   if(!client||config.toolkit==='macos_calendar'||config.toolkit==='macos_mail')throw new ComposioFailure('key_required')
   const identity=await client.inspect(config.toolkit,config.userId,config.accountId,config.authConfigId,createComposioBudget())
   await m.options.client.memory('source_connection',{action:'scope',id:p.id,expected_scope_revision:c.fence.scope_revision,scope:{...config,identity:identity.identity}})
  }else if(method==='connector.configure'){
   const q=z.object({id:z.string(),scope:z.union([googleScopeSchema,macMailScopeSchema]),processingConsent:z.boolean()}).strict().parse(params)
   if(!config.identity||(config.toolkit==='gmail')!==(q.scope.kind==='gmail')||(config.toolkit==='macos_mail')!==(q.scope.kind==='macos_mail'))throw new ComposioFailure('scope_denied')
   this.#active.get(p.id)?.abort.abort()
   const next=connectionSchema.parse(await m.options.client.memory('source_connection',{action:'scope',id:p.id,expected_scope_revision:c.fence.scope_revision,scope:{...config,selection:q.scope}}))
   await this.#setGrant(next,q.processingConsent)
   await m.options.client.memory('source_connection',{action:'fence',id:p.id,expected_epoch:next.fence.epoch,state:'connected'})
  }else if(method==='connector.consent'){
   const q=z.object({id:z.string(),processingConsent:z.boolean()}).strict().parse(params)
   this.#active.get(p.id)?.abort.abort()
   const paused=connectionSchema.parse(await m.options.client.memory('source_connection',{action:'fence',id:p.id,expected_epoch:c.fence.epoch,state:'paused'}))
   await this.#setGrant(paused,q.processingConsent)
   await m.options.client.memory('source_connection',{action:'fence',id:p.id,expected_epoch:paused.fence.epoch,state:c.state})
  }else if(method==='connector.sync'){
   z.object({id:z.string()}).strict().parse(params);void this.#run(p.id).catch(()=>{ /* durable error or closed storage; tick retries */ })
  }else if(['connector.pause','connector.resume','connector.disconnect','connector.delete'].includes(method)){
   z.object({id:z.string()}).strict().parse(params);this.#active.get(p.id)?.abort.abort()
   if(method==='connector.resume'&&(c.deleting.length>0||!config.selection||!config.identity))throw new ComposioFailure('scope_denied')
   if(method==='connector.delete'){
    if(!c.deleting.length)await m.options.client.memory('source_connection',{action:'delete_begin',id:p.id,expected_epoch:c.fence.epoch})
    while((await m.options.client.memory('source_connection',{action:'delete_step',id:p.id,limit:200}) as {remaining:boolean}).remaining){ /* bounded worker transactions, old generation only */ }
   }else await m.options.client.memory('source_connection',{action:'fence',id:p.id,expected_epoch:c.fence.epoch,state:method==='connector.resume'?'connected':method==='connector.disconnect'?'disconnected':'paused'})
  }else throw new ComposioFailure('unsupported_command')
  await this.#refresh();this.#schedule(1000);return this.snapshot()
 }
 async #grant(c:SourceConnection):Promise<ProcessingGrant>{
  const m=this.#memory(),raw=await m.options.client.memory('source_grant',{source_id:c.fence.connection_id,action:'get'})
  return raw===null?m.processingGrant(false,0,c.fence.scope_revision):processingGrantSchema.parse(raw)
 }
 async #setGrant(c:SourceConnection,allowed:boolean):Promise<void>{
  const m=this.#memory(),old=await this.#grant(c),grant=m.processingGrant(allowed,old.revision+1,c.fence.scope_revision)
  await m.setProcessingConsent(c.fence.connection_id,grant)
  let after:string|null=null
  do{const page=await this.#objects(c,after);for(const o of page.objects)await m.setProcessingConsent(o.source_id,grant);after=page.next}while(after)
 }
 async #objects(c:SourceConnection,after:string|null){return z.object({objects:z.array(sourceObjectSchema),next:z.string().nullable()}).parse(await this.#memory().options.client.memory('source_pending',{id:c.fence.connection_id,...(after?{after}:{}),limit:200}))}
 #run(id:string):Promise<void>{
  const active=this.#active.get(id);if(active)return active.promise
  const abort=new AbortController(),promise=this.#sync(id,abort.signal).catch(async(error:unknown)=>{
   if(abort.signal.aborted)return
   let c=await this.#get(id)
   if(error instanceof ComposioFailure&&['permission_denied','authorization_required','identity_mismatch','connection_unverified'].includes(error.code)&&c.state==='connected')c=connectionSchema.parse(await this.#memory().options.client.memory('source_connection',{action:'fence',id,expected_epoch:c.fence.epoch,state:'paused'}))
   const failures=(c.sync_status?.failures??0)+1,seconds=Math.max(Math.min(60*2**Math.min(failures-1,4),900),error instanceof ComposioFailure?error.retryAfter??0:0)
   await this.#memory().options.client.memory('source_connection',{action:'sync_status',id,expected_epoch:c.fence.epoch,status:{attempt_at:c.sync_status?.attempt_at??Date.now(),complete_at:c.sync_status?.complete_at??null,error:error instanceof ComposioFailure?error.code:'sync_failed',failures,retry_at:Date.now()+seconds*1000+Math.floor(Math.random()*1000)}})
  }).finally(async()=>{this.#active.delete(id);if(!this.#closed)await this.#refresh()})
  this.#active.set(id,{abort,promise});return promise
 }
 async #sync(id:string,signal:AbortSignal):Promise<void>{
  const m=this.#memory(),client=this.options.client,provider=this.#provider,c=await this.#get(id),config=configSchema.parse(c.scope)
  if(!config.identity||!config.selection||c.state!=='connected')return
  if(config.provider==='composio'&&(!client||!provider))throw new ComposioFailure('key_required')
  if((c.continuation!==null&&Date.now()-stateSchema.parse(c.continuation).anchor>=86400000)||(c.continuation===null&&c.checkpoint!==null&&Date.now()-checkpointSchema.parse(c.checkpoint).fullAt>=86400000)){
   await m.options.client.memory('source_connection',{action:'reset_sync',id,expected_epoch:c.fence.epoch});return
  }
  await m.options.client.memory('source_connection',{action:'sync_status',id,expected_epoch:c.fence.epoch,status:{attempt_at:Date.now(),complete_at:c.sync_status?.complete_at??null,error:null,failures:c.sync_status?.failures??0,retry_at:0}})
  const old=c.continuation===null?null:stateSchema.parse(c.continuation),state=old??{providerCursor:null,anchor:Date.now(),snapshot:!c.checkpoint||config.toolkit!=='gmail',reconciling:false,after:null,nextCheckpoint:null}
  const batch=c.batch>c.completed_batch?c.batch:c.completed_batch+1,changes:ApplyPage['changes']=[]
  let complete=false
  if(state.reconciling){
   const rows=await this.#objects(c,state.after)
   for(const o of rows.objects)if(o.status==='current'&&o.metadata.scan_batch!==batch)changes.push({object_key:o.object_key,source_id:o.source_id,semantic_hash:hash('coverage_removed'),metadata:o.metadata,evidence:[],status:'coverage_removed'})
   state.after=rows.next;complete=rows.next===null
  }else{
   const checkpoint=state.snapshot?null:checkpointSchema.parse(c.checkpoint)
   let page:Omit<GooglePage,'continuation'>&{continuation:z.infer<typeof stateSchema>['providerCursor'];scanLimited?:boolean}
   if(config.provider==='macos_mail'){
    if(!this.options.mail)throw new ComposioFailure('native_unavailable')
    page=await this.options.mail.page(macMailScopeSchema.parse(config.selection),state.providerCursor,state.anchor,signal).catch(async(error:unknown)=>{if(error instanceof ComposioFailure&&error.code==='snapshot_expired'&&!signal.aborted)await m.options.client.memory('source_connection',{action:'reset_sync',id,expected_epoch:c.fence.epoch});throw error})
   }else if(config.provider==='macos_calendar'){
    if(!this.options.local)throw new ComposioFailure('native_unavailable')
    page=await this.options.local.page(googleScopeSchema.parse(config.selection),signal)
   }else{
    if(!client||!provider)throw new ComposioFailure('key_required')
    const budget=createComposioBudget(signal,state.anchor),binding:GoogleBinding=bindingSchema.parse({toolkit:config.toolkit,userId:config.userId,accountId:config.accountId,authConfigId:config.authConfigId,identity:config.identity}),verified=await client.verify(binding,googleScopeSchema.parse(config.selection),budget)
    page=await provider.page(verified,state.providerCursor,budget,checkpoint?.historyId?{historyId:checkpoint.historyId}:null).catch(async(error:unknown)=>{if(error instanceof ComposioFailure&&['cursor_expired','snapshot_expired','history_too_large'].includes(error.code)&&!signal.aborted)await m.options.client.memory('source_connection',{action:'reset_sync',id,expected_epoch:c.fence.epoch});throw error})
   }
   if(!page.complete&&!page.objects.length&&canonicalJson(page.continuation)===canonicalJson(state.providerCursor))throw new ComposioFailure('no_progress')
   const grant=await this.#grant(c)
   for(const o of page.objects){const change=this.#change(c,o,batch);await m.setProcessingConsent(change.source_id,grant);changes.push(change)}
   state.providerCursor=page.continuation;state.nextCheckpoint={...page.checkpoint,fullAt:state.snapshot?state.anchor:checkpoint?.fullAt??state.anchor,...(config.provider==='macos_mail'?{limited:page.scanLimited===true}:{})}
   if(page.complete){if(state.snapshot&&!(config.provider==='macos_mail'&&!page.snapshot)){state.reconciling=true;state.after=null}else complete=true}
  }
  signal.throwIfAborted()
  await m.applySourcePage({fence:c.fence,batch_id:String(batch),page_id:hash(canonicalJson(c.continuation)),changes,pending_ids:state.providerCursor&&typeof state.providerCursor==='object'&&!Array.isArray(state.providerCursor)&&Array.isArray(state.providerCursor.pending)?state.providerCursor.pending.map(item=>hash('mail::'+z.object({id:z.string()}).parse(item).id)):[],continuation:complete?null:state,checkpoint:complete?state.nextCheckpoint:c.checkpoint,complete})
  await m.options.client.memory('source_connection',{action:'sync_status',id,expected_epoch:c.fence.epoch,status:{attempt_at:Date.now(),complete_at:complete?Date.now():c.sync_status?.complete_at??null,error:null,failures:0,retry_at:complete?Date.now()+60000:0}})
 }
 #change(c:SourceConnection,o:GoogleObject,batch:number):ApplyPage['changes'][number]{
  const m=this.#memory(),source_id=connectorSourceId(c.namespace,c.fence.generation,o.key)
  const evidence=o.status==='current'?[EvidenceRecordSchema.parse({id:m.prefix+'e:'+hash(source_id+':'+o.semanticHash),source_id,source_kind:o.kind,locator:o.locator,raw_text:o.text,hash:hash(o.text),observed_at:o.observedAt,recorded_at:new Date().toISOString(),retention_until:o.retentionUntil,trust:'untrusted_external'})]:[]
  return {object_key:o.key,source_id,semantic_hash:o.semanticHash,metadata:{...o.metadata,scan_batch:batch},evidence,status:o.status}
 }
}
