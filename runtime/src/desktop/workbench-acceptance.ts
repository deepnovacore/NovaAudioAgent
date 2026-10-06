/** Opt-in diagnostics for the normal desktop. No profile writes or grant changes. */
import {createHash} from 'node:crypto'
import {appendFileSync, realpathSync, readFileSync} from 'node:fs'
import {dirname, isAbsolute, relative, resolve} from 'node:path'
import {Socket} from 'node:net'
import {AsyncLocalStorage} from 'node:async_hooks'
import http from 'node:http'
import https from 'node:https'
import {syncBuiltinESMExports} from 'node:module'
import {z} from 'zod'
import {currentModelPurpose} from '../model/model-purpose.js'
import type {CapabilityRegistry} from '../config/capability-registry.js'
import {Dispatcher,getGlobalDispatcher,setGlobalDispatcher} from 'undici'
import {FEED_HEADERS,NEWS_SOURCES} from '../news/feeds.js'

const manifestSchema=z.object({version:z.literal(1),originalUserData:z.string(),originalBlackboardPath:z.string(),repository:z.string(),outputDirectory:z.string(),buildCommit:z.string().regex(/^[a-f0-9]{40}$/u),providers:z.array(z.object({identity:z.string().min(1),origin:z.string().url(),models:z.array(z.string()).min(1)}).strict()).min(1),allowedIdentities:z.array(z.string()).min(1),runCapSeconds:z.number().int().min(10).max(3600).default(300),profileGeneration:z.boolean().default(false),news:z.boolean().default(false)}).strict()
export type AcceptanceManifest=z.infer<typeof manifestSchema>
let active:AcceptanceManifest|undefined
let calls=0,blocked=0,probeVerified=false
const fetchOrigin=new AsyncLocalStorage<string>()
const loopback=new Set<string>()
export function allowAcceptanceLoopback(endpoint:string):void{if(!active)return;const url=new URL(endpoint.includes('://')?endpoint:'tcp://'+endpoint);if(url.hostname!=='127.0.0.1'||!url.port)throw Error('acceptance_loopback_endpoint_invalid');loopback.add(url.host)}
const canonical=(path:string):string=>{if(!isAbsolute(path))throw Error('acceptance_absolute_path_required');return realpathSync(path)}
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel))}
export function assertOriginalProfilePaths(actual:{userData?:string;blackboardPath:string},expected:{userData:string;blackboardPath:string}):void{
 if(actual.userData!==undefined&&canonical(actual.userData)!==canonical(expected.userData))throw Error('acceptance_wrong_user_data')
 if(canonical(actual.blackboardPath)!==canonical(expected.blackboardPath))throw Error('acceptance_wrong_blackboard')
}
export function acceptanceEnabled():boolean{return !!process.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT}
export function acceptanceProfileGenerationEnabled():boolean{return active?.profileGeneration===true}
/** Public RSS reads are allowed only when the manifest turns news on, and only as plain GETs to the built-in feed origins. */
export function acceptanceNewsEnabled():boolean{return active?.news===true}
const newsOrigins=new Set(NEWS_SOURCES.map(source=>new URL(source.url).origin)),newsUrls=new Set(NEWS_SOURCES.map(source=>new URL(source.url).href))
const newsOrigin=(origin:string)=>active?.news===true&&newsOrigins.has(origin)
export function acceptanceManifest():AcceptanceManifest|undefined{return active}
export function loadAcceptanceManifest(environment:NodeJS.ProcessEnv=process.env):AcceptanceManifest|undefined{
 if(!environment.NOVA_WORKBENCH_ACCEPTANCE_REPORT)return undefined
 if(!environment.NOVA_WORKBENCH_ACCEPTANCE_MANIFEST)throw Error('acceptance_manifest_required')
 const value=manifestSchema.parse(JSON.parse(readFileSync(environment.NOVA_WORKBENCH_ACCEPTANCE_MANIFEST,'utf8')))
 const output=canonical(value.outputDirectory),report=resolve(environment.NOVA_WORKBENCH_ACCEPTANCE_REPORT)
 for(const root of [value.originalUserData,dirname(value.originalBlackboardPath),value.repository])if(inside(canonical(root),output))throw Error('acceptance_output_inside_profile_or_repository')
 if(canonical(dirname(report))!==output)throw Error('acceptance_report_outside_output')
 const identityOrigins=new Map<string,string>()
 for(const provider of value.providers){if(identityOrigins.has(provider.identity)&&identityOrigins.get(provider.identity)!==provider.origin)throw Error('acceptance_provider_identity_multiple_origins');identityOrigins.set(provider.identity,provider.origin);if(!value.allowedIdentities.includes(provider.identity))throw Error('acceptance_provider_not_authorized');const url=new URL(provider.origin);if(url.protocol!=='https:'||url.origin!==provider.origin||url.username||url.password)throw Error('acceptance_provider_origin_invalid')}
 return value
}
function rejectEgress(code:string):never{blocked++;appendAcceptanceCounts('egress_blocked',{blocked_calls:blocked});throw Error(code)}
export function acceptanceCounts():{model_calls:number;blocked_calls:number}{return {model_calls:calls,blocked_calls:blocked}}
export function appendAcceptanceCounts(kind:string,counts:Record<string,number>):void{
 if(!active)return
 if(!/^[a-z_]+$/u.test(kind)||Object.entries(counts).some(([key,value])=>!/^\w+$/u.test(key)||!Number.isFinite(value)||value<0))throw Error('acceptance_count_shape')
 appendFileSync(process.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT!,JSON.stringify({kind,at:Date.now(),counts})+'\n',{mode:0o600})
}
export function assertAcceptanceUrl(input:string,allowProvider=false):void{
 if(!active)throw Error('acceptance_gate_missing')
 const url=new URL(input)
 if(['file:','nova:','devtools:'].includes(url.protocol))return
 if(url.protocol==='ws:'&&loopback.has(url.host))return
 if(allowProvider&&url.protocol==='https:'&&active.providers.some(provider=>provider.origin===url.origin))return
 if(allowProvider&&url.protocol==='https:'&&newsOrigin(url.origin))return
 blocked++;appendAcceptanceCounts('egress_blocked',{blocked_calls:blocked});throw Error('acceptance_unknown_outbound')
}
/** Install in EACH process before opening any profile. Socket guard also covers undici/ws. */
export function installAcceptanceGate(environment:NodeJS.ProcessEnv=process.env):AcceptanceManifest|undefined{
 if(active)return active
 const manifest=loadAcceptanceManifest(environment);if(!manifest)return undefined
 active=manifest
 if(environment.DESKTOP_READY_ENDPOINT)allowAcceptanceLoopback(environment.DESKTOP_READY_ENDPOINT)
 assertOriginalProfilePaths({blackboardPath:environment.BLACKBOARD_PATH??''},{userData:manifest.originalUserData,blackboardPath:manifest.originalBlackboardPath})
 const source=JSON.parse(readFileSync(manifest.originalBlackboardPath+'.personal.json.sources.json','utf8')) as {sources?:{deleting?:boolean;view?:{state?:string};processing_consent?:{extraction_provider?:string|null;embedding_provider?:string|null}}[]}
 const grants=source.sources?.filter(record=>!record.deleting&&['connected','error'].includes(record.view?.state??''))??[]
 if(!grants.length)throw Error('acceptance_no_active_sources')
 const sourceIdentities=new Set(grants.flatMap(record=>[record.processing_consent?.extraction_provider,record.processing_consent?.embedding_provider]).filter((id):id is string=>typeof id==='string'))
 if(manifest.providers.some(provider=>!sourceIdentities.has(provider.identity))||manifest.allowedIdentities.some(identity=>!sourceIdentities.has(identity)))throw Error('acceptance_provider_outside_source_grant')
 for(const record of grants)for(const identity of [record.processing_consent?.extraction_provider,record.processing_consent?.embedding_provider])if(!identity||!manifest.allowedIdentities.includes(identity))throw Error('acceptance_processing_grant_mismatch')
 // Preserve the method for Reflect.apply with the calling socket below.
 // eslint-disable-next-line @typescript-eslint/unbound-method
 const originalConnect=Socket.prototype.connect
 Socket.prototype.connect=function(this:Socket,...args:Parameters<Socket['connect']>):Socket{
  const first=args[0] as unknown
  const options=(Array.isArray(first)?first[0]:first) as {host?:string;port?:number;path?:string}|number|string
  const host=typeof options==='object'?options.host:typeof args[1]==='string'?args[1]:undefined
  const port=typeof options==='object'?options.port:options
  // Unix sockets and arbitrary local proxies could bypass provider enforcement.
  const permitted=host!==undefined&&(loopback.has(host+':'+String(port))||manifest.providers.some(provider=>{const url=new URL(provider.origin);return fetchOrigin.getStore()===provider.origin&&url.hostname===host&&String(port)===String(url.port||443)})||[...newsOrigins].some(origin=>{const url=new URL(origin);return newsOrigin(origin)&&fetchOrigin.getStore()===origin&&url.hostname===host&&String(port)==='443'}))
  if(!permitted){blocked++;appendAcceptanceCounts('egress_blocked',{blocked_calls:blocked});throw Error('acceptance_unknown_socket')}
  return Reflect.apply(originalConnect,this,args)
 } as Socket['connect']
 for(const transport of [http,https]){
  const originalRequest=transport.request
  transport.request=function(...args:unknown[]){
   const input=args[0]
   const url=typeof input==='string'||input instanceof URL?new URL(input):undefined
   const rawOptions=url?args[1]:input
   const options=rawOptions&&typeof rawOptions==='object'?rawOptions as {hostname?:string;host?:string;port?:string|number;protocol?:string;socketPath?:string}:undefined
   const host=options?.hostname??options?.host??url?.hostname
   const protocol=options?.protocol??url?.protocol??(transport===https?'https:':'http:')
   const urlPort=url?.port===''?undefined:url?.port
   const port=options?.port??urlPort??(protocol==='https:'?443:80)
   if(options?.socketPath||protocol!=='http:'||host!=='127.0.0.1'||!loopback.has(host+':'+String(port))){blocked++;appendAcceptanceCounts('egress_blocked',{blocked_calls:blocked});throw Error('acceptance_unapproved_http_transport')}
   return Reflect.apply(originalRequest,transport,args) as http.ClientRequest
  }
 }
 syncBuiltinESMExports()
 const dispatcher=getGlobalDispatcher()
 class AcceptanceDispatcher extends Dispatcher{
  override dispatch(options:Dispatcher.DispatchOptions,handler:Dispatcher.DispatchHandler):boolean{
   const origin=String(options.origin)
   if(fetchOrigin.getStore()!==new URL(origin).origin)rejectEgress('acceptance_unapproved_dispatcher')
   return dispatcher.dispatch(options,handler)
  }
 }
 setGlobalDispatcher(new AcceptanceDispatcher())
 const originalFetch=globalThis.fetch
 globalThis.fetch=async(input,init)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url
  assertAcceptanceUrl(url,true)
  const provider=manifest.providers.find(item=>item.origin===new URL(url).origin)
  if(provider){
   // Refuse opaque bodies, redirects, and an unknown model before transmitting.
   const body=init?.body
   if(typeof body!=='string')rejectEgress('acceptance_model_body_required')
   let model:unknown;try{model=(JSON.parse(body) as {model?:unknown}).model}catch{rejectEgress('acceptance_model_body_invalid')}
   if(typeof model!=='string'||!manifest.providers.some(item=>item.origin===new URL(url).origin&&item.models.includes(model)))rejectEgress('acceptance_unknown_model')
   calls++
   // One row per call, written when the response headers settle: purpose, endpoint, and time to first byte.
   const purpose=currentModelPurpose(),labels={model_calls:calls,['purpose_'+purpose]:1,[new URL(url).pathname.endsWith('/embeddings')?'endpoint_embeddings':'endpoint_chat']:1},started=performance.now()
   try{const response=await fetchOrigin.run(new URL(url).origin,()=>originalFetch(input,{...init,redirect:'error'}));appendAcceptanceCounts('model_call',{...labels,latency_ms:Math.round(performance.now()-started),ok:Number(response.ok),status:response.status})
    // Token counts only, read from a copy so the caller's body is untouched.
    if(response.ok&&!new URL(url).pathname.endsWith('/embeddings'))void response.clone().json().then((reply:unknown)=>{const usage=(reply as {usage?:{prompt_tokens?:unknown;completion_tokens?:unknown}}|null)?.usage;if(typeof usage?.completion_tokens==='number'&&typeof usage.prompt_tokens==='number')appendAcceptanceCounts('model_usage',{['purpose_'+purpose]:1,input_tokens:usage.prompt_tokens,output_tokens:usage.completion_tokens,body_ms:Math.round(performance.now()-started)})}).catch(()=>undefined)
    return response}
   catch(error){appendAcceptanceCounts('model_call',{...labels,latency_ms:Math.round(performance.now()-started),ok:0,[error instanceof Error&&error.name==='AbortError'||error instanceof Error&&error.name==='TimeoutError'?'aborted':'network_error']:1});throw error}
  }
  if(newsOrigin(new URL(url).origin)){
   // A feed read sends nothing: exactly a built-in feed URL, GET with no body, and fixed public headers in place of the caller's.
   if(typeof input!=='string'&&!(input instanceof URL)||!newsUrls.has(new URL(url).href)||init?.body!==undefined&&init.body!==null||(init?.method??'GET').toUpperCase()!=='GET')rejectEgress('acceptance_news_get_only')
   const started=performance.now(),href=new URL(url).href
   try{const response=await fetchOrigin.run(new URL(url).origin,()=>originalFetch(href,{method:'GET',headers:FEED_HEADERS,redirect:'error',...(init?.signal?{signal:init.signal}:{})}));appendAcceptanceCounts('news_fetch',{fetches:1,latency_ms:Math.round(performance.now()-started),ok:Number(response.ok),status:response.status});return response}
   catch(error){appendAcceptanceCounts('news_fetch',{fetches:1,latency_ms:Math.round(performance.now()-started),ok:0,network_error:1});throw error}
  }
  return fetchOrigin.run(new URL(url).origin,()=>originalFetch(input,{...init,redirect:'error'}))
 }
 appendAcceptanceCounts('disabled_modules',{news:Number(!manifest.news),proactive:1,connectors:1,phone:1,external_mcp:1,coding:1,voice_activation:1,profile_generation:Number(!manifest.profileGeneration),understanding:1,memory_overview:1,search:1,camera_capability:1,wake_word:1})
 return manifest
}
export function acceptanceProfileHash(path:string):string{return createHash('sha256').update(canonical(path)).digest('hex')}
export function assertAcceptanceGrant(expected:{extraction_provider:string|null;embedding_provider:string|null}|undefined,grants:readonly {extraction_provider:string|null;embedding_provider:string|null}[]):void{
 if(!active)return
 if(!expected?.extraction_provider||!expected.embedding_provider)throw Error('acceptance_embedding_provider_disabled')
 for(const id of [expected.extraction_provider,expected.embedding_provider])if(!active.allowedIdentities.includes(id))throw Error('acceptance_provider_not_authorized')
 if(!grants.length||grants.some(grant=>grant.extraction_provider!==expected.extraction_provider||grant.embedding_provider!==expected.embedding_provider))throw Error('acceptance_processing_grant_mismatch')
}

export function assertPersistedAcceptanceGrant(expected:{extraction_provider:string|null;embedding_provider:string|null}|undefined,hostPath?:string):void{
 if(!active){if(acceptanceEnabled())throw Error('acceptance_gate_missing');return}
 if(!probeVerified)throw Error('acceptance_gate_probe_missing')
 if(hostPath!==undefined&&canonical(hostPath)!==canonical(active.originalBlackboardPath+'.personal.json'))throw Error('acceptance_wrong_host_path')
 const state=JSON.parse(readFileSync(active.originalBlackboardPath+'.personal.json.sources.json','utf8')) as {sources?:{deleting?:boolean;view?:{state?:string};processing_consent?:{extraction_provider:string|null;embedding_provider:string|null}}[]}
 assertAcceptanceGrant(expected,(state.sources??[]).filter(record=>!record.deleting&&['connected','error'].includes(record.view?.state??'')).map(record=>record.processing_consent??{extraction_provider:null,embedding_provider:null}))
}

export async function probeAcceptanceGate():Promise<{probeBlocked:true;probeTransport:'fetch';blockedAttempts:1}>{
 if(!active)throw Error('acceptance_gate_missing')
 if(!probeVerified){
  const before=blocked
  try{await globalThis.fetch('https://acceptance-blocked.invalid/probe',{method:'POST',body:'{}'});throw Error('acceptance_gate_probe_failed')}
  catch(error){if(!(error instanceof Error)||error.message!=='acceptance_unknown_outbound'||blocked!==before+1)throw Error('acceptance_gate_probe_failed')}
  probeVerified=true
  appendAcceptanceCounts('gate_installed',{installed:1,fetch_probe_blocked:1})
 }
 return {probeBlocked:true,probeTransport:'fetch',blockedAttempts:1}
}
export function acceptanceRuntimeHash(entry:string):string{
 return createHash('sha256').update(readFileSync(entry)).update(readFileSync(new URL('./workbench-acceptance.js',import.meta.url))).digest('hex')
}
export function acceptanceCapabilityRegistry(configured:CapabilityRegistry,enabled=acceptanceEnabled()):CapabilityRegistry{
 return enabled?{...configured,mcpServers:{},modules:{...configured.modules,coding:{enabled:false},search:{...configured.modules.search,enabled:false},camera:{enabled:false}}}:configured
}
