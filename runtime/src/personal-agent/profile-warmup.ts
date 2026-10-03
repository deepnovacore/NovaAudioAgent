import {createHash} from 'node:crypto'
import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {versionSchema} from './contracts.js'
import type {MemoryEntry} from '../memory/entry.js'
const refs=z.array(z.object({entry_id:z.string().min(1).max(256),version:versionSchema}).strict()).min(1).max(8)
export const profileDraftSchema=z.object({
 about:z.object({text:z.string().trim().min(1).max(800),refs}).strict().nullable(),
 work:z.array(z.object({title:z.string().trim().min(1).max(80),text:z.string().trim().min(1).max(500),refs}).strict()).max(6).default([]),
 interests:z.array(z.object({text:z.string().trim().min(1).max(100),refs}).strict()).max(8),
}).strict()
export type ProfileDraft=z.infer<typeof profileDraftSchema>
export type ProfileInput=Pick<MemoryEntry,'id'|'version'|'content'|'origin'> & {source?:{project:string;document:string}}
export type ProfileGenerator=(entries:readonly ProfileInput[],signal:AbortSignal)=>Promise<z.input<typeof profileDraftSchema>>
export interface ProfileOutcome {outcome:'ok'|'timeout'|'aborted'|'schema'|'evidence'|'consent'|'provider'|'persist';latency_ms:number;items:number}
export interface ProfileWarmupOptions {report?:(outcome:ProfileOutcome)=>void;timeoutMs?:number;backoffMs?:readonly number[];minIntervalMs?:number}
const diskSchema=z.object({key:z.string(),draft:profileDraftSchema.nullable()})
interface Ref {entry_id:string;version:ProfileInput['version']}
const inputKey=(entries:readonly ProfileInput[])=>entries.length?createHash('sha256').update(JSON.stringify(entries)).digest('hex'):''
const factCount=(draft:ProfileDraft)=>(draft.about?1:0)+draft.work.length+draft.interests.length
const classify=(error:unknown,signal:AbortSignal,controller:AbortController):ProfileOutcome['outcome']=>{
 if(controller.signal.aborted)return 'aborted'
 if(signal.aborted)return 'timeout'
 if(error instanceof z.ZodError)return 'schema'
 const message=error instanceof Error?error.message:''
 return message==='invalid_profile_evidence'?'evidence':message==='processing_consent_required'?'consent':message==='profile_persist_failed'?'persist':'provider'
}
/** Disposable suggestions only: never writes profile facts, news preferences, or consent. */
export class ProfileWarmup{
 #store:BoundedJsonStore<z.infer<typeof diskSchema>>;#cache:z.infer<typeof diskSchema>={key:'',draft:null}
 #entries:ProfileInput[]=[];#key='';#opened=false
 #abort=new AbortController();#run:Promise<void>|undefined;#runEntries:ProfileInput[]=[];#writes:Promise<void>=Promise.resolve()
 #timer:ReturnType<typeof setTimeout>|undefined;#firstChangeAt=0;#lastRunAt=0;#failures=0;#failedKey='';#withdrawals=0;#withdrawnDuringRun=new Set<string>()
 readonly #timeoutMs:number;readonly #backoffMs:readonly number[];readonly #minIntervalMs:number;readonly #report:((outcome:ProfileOutcome)=>void)|undefined
 constructor(path:string,readonly generate:ProfileGenerator|undefined,readonly changed:()=>void,options:ProfileWarmupOptions={}){
  this.#store=new BoundedJsonStore(path,diskSchema);this.#report=options.report
  this.#timeoutMs=options.timeoutMs??60_000;this.#backoffMs=options.backoffMs??[30_000,120_000,600_000];this.#minIntervalMs=options.minIntervalMs??300_000
 }
 async open(){this.#cache=await this.#store.read(this.#cache);this.#opened=true}
 async close(){this.#opened=false;clearTimeout(this.#timer);this.#abort.abort();await this.#run;await this.#writes}
 #persist(cache:z.infer<typeof diskSchema>){const write=this.#writes.then(()=>this.#store.write(cache));this.#writes=write.catch(()=>{/* The caller reports a failed persistence attempt. */});return write}
 async clear(){this.invalidate();this.#cache={key:'',draft:null};await this.#run;await this.#persist(this.#cache)}
 // A source file keeps its facts while it is re-read (its version moves); a stated memory must match exactly because a correction replaces it.
 #grounded(ref:Ref,entries:readonly ProfileInput[]){return entries.some(e=>e.id===ref.entry_id&&(e.source?true:e.origin==='stated'&&e.version===ref.version))}
 #prune(draft:ProfileDraft,entries:readonly ProfileInput[]):ProfileDraft|null{
  const keep=(fact:{refs:Ref[]})=>fact.refs.every(ref=>this.#grounded(ref,entries))
  const pruned={about:draft.about&&keep(draft.about)?draft.about:null,work:draft.work.filter(keep),interests:draft.interests.filter(keep)}
  return factCount(pruned)?pruned:null
 }
 /** Only consent withdrawal and explicit clearing discard the draft wholesale; source churn goes through update(). */
 invalidate(){clearTimeout(this.#timer);this.#timer=undefined;this.#firstChangeAt=0;this.#abort.abort();this.#entries=[];this.#key='';this.#failures=0;this.#failedKey=''}
 snapshot(){
  const draft=this.#cache.draft&&this.#prune(this.#cache.draft,this.#entries)
  // A visible draft reads as ready even while a background refresh runs or fails; the renderer never blanks it.
  const status=this.#run?'working' as const:draft?'ready' as const:this.#failures&&this.#failedKey===this.#key?'failed' as const:'idle' as const
  return {status,draft:draft?structuredClone(draft):null,sources:this.#entries.map(e=>({id:e.id,version:e.version,label:e.source?e.source.document?`${e.source.project}/${e.source.document}`:e.source.project:'你提供的信息'}))}}
 update(entries:readonly ProfileInput[]){
  const usable=entries.filter(e=>e.version!==null&&e.content.trim())
  const selected=[...usable.filter(e=>!e.source).slice(-16),...usable.filter(e=>e.source).slice(0,24)]
   .map(e=>({id:e.id,version:e.version,content:e.content.slice(0,1500),origin:e.origin,...(e.source?{source:e.source}:{})})).sort((a,b)=>a.id.localeCompare(b.id))
  const key=inputKey(selected)
  if(key!==this.#key){
   this.#key=key;this.#entries=selected
   // Nothing the running call can cite is still eligible, so its answer would be discarded anyway.
   if(this.#run&&!this.#runEntries.some(entry=>this.#grounded({entry_id:entry.id,version:entry.version},selected)))this.#abort.abort()
  }
  // Facts whose evidence is momentarily absent (a root still warming up, a file mid re-read) are hidden by snapshot(), not deleted.
  this.#schedule()
 }
 /**
  * Called after the user withdraws a source, with every source id that is still eligible (read synchronously, so a
  * superseded memory refresh cannot leave stale eligibility). Facts it grounded leave disk as well as the view.
  */
 async forgetUnavailable(eligibleSources:ReadonlySet<string>){
  const withdrawn=this.#entries.filter(entry=>entry.source&&!eligibleSources.has(entry.id))
  for(const entry of [...withdrawn,...this.#runEntries.filter(entry=>entry.source&&!eligibleSources.has(entry.id))])this.#withdrawnDuringRun.add(entry.id)
  this.#entries=this.#entries.filter(entry=>!withdrawn.includes(entry));this.#key=inputKey(this.#entries);this.#withdrawals++
  const draft=this.#cache.draft
  const pruned=draft&&this.#prune(draft,this.#entries)
  if(draft&&(!pruned||factCount(pruned)!==factCount(draft)))this.#cache={key:pruned?this.#cache.key:'',draft:pruned}
  // Queued behind any in-flight draft write, so the pruned cache is what stays on disk.
  await this.#persist(this.#cache);this.changed()
 }
 #schedule(){
  clearTimeout(this.#timer);this.#timer=undefined
  if(!this.#key||this.#run||this.#cache.key===this.#key||!this.generate)return
  const now=Date.now(),sourced=this.#entries.some(entry=>entry.source)
  if(sourced&&!this.#firstChangeAt)this.#firstChangeAt=now
  // Scans move the key often: batch the churn, and once a draft is showing refresh it at most every few minutes.
  let due=sourced?Math.min(this.#firstChangeAt+20_000,now+5_000):now
  if(this.#cache.draft)due=Math.max(due,this.#lastRunAt+this.#minIntervalMs)
  if(this.#failures){
   // Retries back off; once the ladder is spent the same inputs wait for an explicit retry, while new inputs retry at the slowest step.
   if(this.#failures>this.#backoffMs.length&&this.#failedKey===this.#key)return
   due=Math.max(due,this.#lastRunAt+this.#backoffMs[Math.min(this.#failures,this.#backoffMs.length)-1]!)
  }
  if(due<=now){void this.refresh();return}
  this.#timer=setTimeout(()=>{this.#timer=undefined;this.#firstChangeAt=0;void this.refresh()},due-now)
  this.#timer.unref()
 }
 refresh(retry=false):Promise<void>{
  clearTimeout(this.#timer);this.#timer=undefined;this.#firstChangeAt=0
  if(this.#run)return this.#run
  if(!this.#opened||!this.#key||!this.generate)return Promise.resolve()
  if(retry)this.#failures=0
  else if(this.#cache.key===this.#key)return Promise.resolve()
  const key=this.#key,entries=structuredClone(this.#entries),controller=new AbortController(),started=Date.now()
  this.#abort=controller;this.#runEntries=entries;this.#lastRunAt=started;this.#withdrawnDuringRun=new Set()
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(this.#timeoutMs)])
  let outcome:ProfileOutcome={outcome:'ok',latency_ms:0,items:0}
  const run=(async()=>{
   let cancel:()=>void=()=>{/* Assigned when the abort listener is installed. */}
   try{
    const result=await Promise.race([this.generate!(entries,signal),new Promise<never>((_,reject)=>{cancel=()=>reject(Error('warmup_aborted'));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()})])
    signal.throwIfAborted()
    // Facts citing anything outside this call's inputs are invented; drop them and keep the grounded rest.
    // Evidence withdrawn while the call ran stays withdrawn even if the same id (a re-digested project) is eligible again.
    const draft=this.#prune(profileDraftSchema.parse(result),entries.filter(entry=>!this.#withdrawnDuringRun.has(entry.id)))
    if(!draft)throw Error('invalid_profile_evidence')
    outcome.items=factCount(draft)
    const current=this.#prune(draft,this.#entries)
    // A reply that leaves about out keeps the previous one only while every entry it cites is unchanged; a re-read source may now say something else.
    const previousAbout=this.#cache.draft?.about,kept=previousAbout?.refs.every(ref=>this.#entries.some(e=>e.id===ref.entry_id&&e.version===ref.version))?previousAbout:null
    if(current&&!current.about&&kept)current.about=kept
    if(!this.#opened)return
    if(!current){this.#failures=0;this.#failedKey='';return}
    // Installed before the write so a withdrawal arriving mid-write prunes this draft and queues its own write after it.
    const previous=this.#cache,cache={key,draft:current},withdrawals=this.#withdrawals;this.#cache=cache
    try{await this.#persist(cache)}catch{
     // A rollback must not bring back facts withdrawn since the previous draft was captured.
     if(this.#cache===cache){const kept=withdrawals===this.#withdrawals?previous.draft:previous.draft&&this.#prune(previous.draft,this.#entries);this.#cache={key:kept?previous.key:'',draft:kept}}
     throw Error('profile_persist_failed')
    }
    this.#failures=0;this.#failedKey=''
   }catch(error){
    outcome={...outcome,outcome:classify(error,signal,controller)}
    if(this.#opened&&outcome.outcome!=='aborted'){this.#failures++;this.#failedKey=key}
   }
   finally{signal.removeEventListener('abort',cancel);outcome.latency_ms=Date.now()-started}
  })()
  this.#run=run;this.changed()
  void run.finally(()=>{
   this.#run=undefined;this.#runEntries=[]
   try{this.#report?.(outcome)}catch{/* Reporting never changes the draft. */}
   if(!this.#opened)return
   this.#schedule();this.changed()
  })
  return run
 }
}
