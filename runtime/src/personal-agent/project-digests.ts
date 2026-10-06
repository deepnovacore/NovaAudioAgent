import {createHash} from 'node:crypto'
import {basename} from 'node:path'
import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {digestEligible,type ContextInput} from './context-candidates.js'
import type {ContextEntry} from './workbench-context.js'
type FileInput=Extract<ContextInput,{kind:'file'}>
const ref=z.object({entry_id:z.string().min(1).max(256),version:z.string().min(1).max(128)}).strict()
export const projectDigestSchema=z.object({
 project_key:z.string().min(1).max(64),
 role:z.enum(['own','third_party','sample','unclear']),
 summary:z.string().trim().min(1).max(200),
 focus:z.string().trim().min(1).max(120).nullable(),
 next_step:z.string().trim().min(1).max(120).nullable(),
 refs:z.array(ref).min(1).max(8),
}).strict()
/** `inputs` are every document the digest read, cited or not. */
export type ProjectDigest=z.infer<typeof projectDigestSchema>&{name:string;inputs?:readonly string[]}
/** What the model sees for one project: a display name, a few documents, and activity signals — never a path. */
export interface ProjectInput {
 project_key:string;name:string
 signals:{tier:number;own_commits_30d:number;last_own_commit_days:number|null;last_modified_days:number}
 documents:{entry_id:string;version:string;document:string;excerpt:string}[]
}
/** `authorize` runs right before the request leaves the process, after any queueing, and throws if consent moved. */
export type DigestGenerator=(projects:readonly ProjectInput[],signal:AbortSignal,authorize?:()=>void)=>Promise<{digests:unknown[]}>
export interface DigestOutcome {outcome:'ok'|'timeout'|'aborted'|'schema'|'consent'|'provider';projects:number;digests:number;latency_ms:number}
export interface ProjectDigestOptions {report?:(outcome:DigestOutcome)=>void;idleMs?:number;batch?:number;hourlyProjects?:number;timeoutMs?:number;now?:()=>number}
interface Project {input:ProjectInput;key:string;changedAt:number;priority:number;recent:number}
const DOCUMENTS=4,MAX_PROJECTS=24,EXCERPT=1200,KEEP=64,DAY=86_400_000
// `inputs` lists every document the digest read, cited or not: withdrawing any of them retires the digest.
const cached=z.object({key:z.string(),name:z.string(),digest:projectDigestSchema,at:z.number(),inputs:z.array(z.string()).max(DOCUMENTS).default([])})
const diskSchema=z.object({projects:z.record(z.string(),cached)})
export const projectKey=(root:string)=>createHash('sha256').update(root).digest('hex').slice(0,16)
/**
 * L1 of the workbench synthesis: one short digest per active project, cached by the exact document versions it read.
 * Only projects whose documents changed are sent again, batched and in the background.
 */
export class ProjectDigests{
 #store:BoundedJsonStore<z.infer<typeof diskSchema>>;#disk:z.infer<typeof diskSchema>={projects:{}};#opened=false
 /** Every document id currently eligible for a digest; a digest that read anything outside it is withheld until regenerated. */
 #eligible=new Set<string>();#projects=new Map<string,Project>();#failures=new Map<string,{key:string;count:number;at:number}>();#blocked=new Map<string,string>();#spent:number[]=[]
 #timer:ReturnType<typeof setTimeout>|undefined;#run:Promise<void>|undefined;#runBatch:Project[]=[];#abort=new AbortController();#writes:Promise<void>=Promise.resolve()
 readonly #idleMs:number;readonly #batch:number;readonly #hourly:number;readonly #timeoutMs:number;readonly #now:()=>number
 constructor(path:string,readonly generate:DigestGenerator|undefined,readonly changed:()=>void,readonly options:ProjectDigestOptions={}){
  this.#store=new BoundedJsonStore(path,diskSchema);this.#idleMs=options.idleMs??30_000;this.#batch=options.batch??4
  this.#hourly=options.hourlyProjects??24;this.#timeoutMs=options.timeoutMs??60_000;this.#now=options.now??Date.now
 }
 async open(){
  const disk=await this.#store.read(this.#disk)
  // A record that does not list what it read cannot be retired on withdrawal; recompute it instead.
  this.#disk={projects:Object.fromEntries(Object.entries(disk.projects).filter(([,hit])=>hit.inputs.length))};this.#opened=true
 }
 async close(){this.#opened=false;clearTimeout(this.#timer);this.#abort.abort();await this.#run;await this.#writes}
 async clear(){clearTimeout(this.#timer);this.#abort.abort();await this.#run;this.#projects.clear();this.#failures.clear();this.#blocked.clear();this.#disk={projects:{}};await this.#persist()}
 #persist(){const snapshot=structuredClone(this.#disk),write=this.#writes.then(()=>this.#store.write(snapshot));this.#writes=write.catch(()=>{/* The next change writes again. */});return write}
 /** Digests of projects that are currently eligible. A digest stays while its project is re-read, and yields once a fresh one lands. */
 digests():ProjectDigest[]{
  return [...this.#projects.values()].sort((a,b)=>b.priority-a.priority||b.recent-a.recent).flatMap(project=>{
   const hit=this.#disk.projects[project.input.project_key]
   // Refs keep their file ids across re-reads; the version is refreshed to the current one so downstream evidence checks still pass.
   const versions=new Map(project.input.documents.map(d=>[d.entry_id,d.version]))
   const refs=hit?.digest.refs.flatMap(r=>{const version=versions.get(r.entry_id);return version?[{entry_id:r.entry_id,version}]:[]})??[]
   return hit&&refs.length&&hit.inputs.every(id=>this.#eligible.has(id))?[{...hit.digest,name:project.input.name,refs,inputs:[...hit.inputs]}]:[]
  })
 }
 pending(){return [...this.#projects.values()].filter(p=>this.#disk.projects[p.input.project_key]?.key!==p.key).length}
 update(entries:readonly ContextEntry[]){
  const now=this.#now(),groups=new Map<string,FileInput[]>(),eligible=new Set<string>()
  for(const entry of entries){
   if(!('kind' in entry)||entry.kind!=='file'||!digestEligible(entry))continue
   eligible.add(entry.id)
   const group=groups.get(entry.root)??[];group.push(entry);groups.set(entry.root,group)
  }
  const next=new Map<string,Project>()
  const ranked=[...groups.entries()].map(([root,files])=>({root,files:files.sort((a,b)=>b.mtime_ms-a.mtime_ms||a.id.localeCompare(b.id)),
   priority:Math.max(...files.map(f=>f.priority)),recent:Math.max(...files.map(f=>Math.max(f.mtime_ms,f.last_commit_ms??0)))}))
   .sort((a,b)=>b.priority-a.priority||b.recent-a.recent||a.root.localeCompare(b.root)).slice(0,MAX_PROJECTS)
  for(const {root,files,priority,recent} of ranked){
   const docs=files.slice(0,DOCUMENTS),first=files[0]!,project_key=projectKey(root)
   const input:ProjectInput={project_key,name:basename(root),
    signals:{tier:priority,own_commits_30d:first.own_commits??0,last_own_commit_days:first.last_commit_ms?Math.floor((now-first.last_commit_ms)/DAY):null,last_modified_days:Math.floor((now-first.mtime_ms)/DAY)},
    documents:docs.map(d=>({entry_id:d.id,version:d.version,document:basename(d.rel_path),excerpt:d.content.slice(0,EXCERPT)}))}
   const key=createHash('sha256').update(JSON.stringify(docs.map(d=>[d.id,d.version]))).digest('hex')
   const previous=this.#projects.get(project_key)
   next.set(project_key,{input,key,priority,recent,changedAt:previous?.key===key?previous.changedAt:now})
  }
  const before=JSON.stringify(this.digests());this.#projects=next;this.#eligible=eligible
  if(JSON.stringify(this.digests())!==before)this.changed()
  this.#schedule()
 }
 /** After a withdrawal: digests citing any file that is no longer eligible leave disk. */
 async forgetUnavailable(eligible:ReadonlySet<string>){
  let removed=false
  for(const [key,hit] of Object.entries(this.#disk.projects))if([...hit.inputs,...hit.digest.refs.map(r=>r.entry_id)].some(id=>!eligible.has(id))){delete this.#disk.projects[key];removed=true}
  // An in-flight or queued batch that read a withdrawn document is cancelled: a queued one never sends, a sent one is discarded whole.
  if(this.#runBatch.some(p=>p.input.documents.some(d=>!eligible.has(d.entry_id))))this.#abort.abort()
  for(const [key,project] of this.#projects)if(project.input.documents.some(d=>!eligible.has(d.entry_id)))this.#projects.delete(key)
  await this.#persist();if(removed)this.changed()
 }
 #due(){
  const now=this.#now()
  return [...this.#projects.values()].filter(p=>{
   if(this.#disk.projects[p.input.project_key]?.key===p.key||this.#blocked.get(p.input.project_key)===p.key)return false
   const failed=this.#failures.get(p.input.project_key);return failed?.key!==p.key||failed.count<3
  }).sort((a,b)=>b.priority-a.priority||b.recent-a.recent).map(p=>{
   // A project with no digest yet goes first and sooner; a failed one backs off 1, 4, then 16 minutes.
   const failed=this.#failures.get(p.input.project_key),retry=failed?.key===p.key?failed.at+60_000*4**(failed.count-1):0
   return {project:p,at:Math.max(now,retry,p.changedAt+(this.#disk.projects[p.input.project_key]?this.#idleMs:Math.min(this.#idleMs,5_000)))}
  })
 }
 #schedule(){
  clearTimeout(this.#timer);this.#timer=undefined
  if(!this.#opened||!this.generate||this.#run)return
  const due=this.#due();if(!due.length)return
  const now=this.#now();this.#spent=this.#spent.filter(at=>now-at<3_600_000)
  let at=Math.min(...due.map(item=>item.at))
  if(this.#spent.length>=this.#hourly)at=Math.max(at,this.#spent[this.#spent.length-this.#hourly]!+3_600_000)
  this.#timer=setTimeout(()=>{this.#timer=undefined;void this.refresh()},Math.max(0,at-now));this.#timer.unref()
 }
 refresh():Promise<void>{
  clearTimeout(this.#timer);this.#timer=undefined
  if(this.#run)return this.#run
  if(!this.#opened||!this.generate)return Promise.resolve()
  const now=this.#now();this.#spent=this.#spent.filter(at=>now-at<3_600_000)
  const room=Math.min(this.#batch,this.#hourly-this.#spent.length)
  const batch=this.#due().filter(item=>item.at<=now).slice(0,room).map(item=>item.project)
  if(!batch.length){this.#schedule();return Promise.resolve()}
  this.#spent.push(...batch.map(()=>now))
  const controller=new AbortController();this.#abort=controller;this.#runBatch=batch
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(this.#timeoutMs)]),inputs=structuredClone(batch.map(p=>p.input))
  const outcome:DigestOutcome={outcome:'ok',projects:batch.length,digests:0,latency_ms:0}
  const run=(async()=>{
   try{
    const raw=await this.generate!(inputs,signal);signal.throwIfAborted()
    const byKey=new Map(batch.map(p=>[p.input.project_key,p]))
    for(const value of raw.digests){
     const parsed=projectDigestSchema.safeParse(value);if(!parsed.success)continue
     const project=byKey.get(parsed.data.project_key);if(!project)continue
     // A digest may cite only the documents it was given for its own project. A withdrawal during the call aborts it (see forgetUnavailable).
     const given=new Set(project.input.documents.map(d=>d.entry_id+'\0'+d.version))
     const refs=parsed.data.refs.filter(r=>given.has(r.entry_id+'\0'+r.version));if(!refs.length)continue
     this.#disk.projects[project.input.project_key]={key:project.key,name:project.input.name,digest:{...parsed.data,refs},at:now,inputs:project.input.documents.map(d=>d.entry_id)}
     byKey.delete(project.input.project_key);outcome.digests++;this.#failures.delete(project.input.project_key)
    }
    for(const project of byKey.values()){const failed=this.#failures.get(project.input.project_key);this.#failures.set(project.input.project_key,{key:project.key,count:failed?.key===project.key?failed.count+1:1,at:now})}
    const kept=Object.entries(this.#disk.projects).sort((a,b)=>b[1].at-a[1].at).slice(0,KEEP);this.#disk.projects=Object.fromEntries(kept)
    if(outcome.digests)await this.#persist()
   }catch(error){
    outcome.outcome=controller.signal.aborted?'aborted':signal.aborted?'timeout':error instanceof z.ZodError?'schema':error instanceof Error&&error.message==='processing_consent_required'?'consent':'provider'
    // A consent rejection is not the provider's fault and nothing was sent: refund the budget and wait for the inputs to move.
    if(outcome.outcome==='consent'){for(const project of batch)this.#blocked.set(project.input.project_key,project.key);this.#spent.splice(-batch.length,batch.length)}
    else if(outcome.outcome!=='aborted')for(const project of batch){const failed=this.#failures.get(project.input.project_key);this.#failures.set(project.input.project_key,{key:project.key,count:failed?.key===project.key?failed.count+1:1,at:now})}
   }finally{outcome.latency_ms=this.#now()-now}
  })()
  this.#run=run
  void run.finally(()=>{
   this.#run=undefined;this.#runBatch=[]
   try{this.options.report?.(outcome)}catch{/* Reporting never changes digests. */}
   if(!this.#opened)return
   if(outcome.digests)this.changed()
   this.#schedule()
  })
  return run
 }
}
