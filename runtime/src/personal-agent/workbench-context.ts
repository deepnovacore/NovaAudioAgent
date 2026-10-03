import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {MemoryEntry} from '../memory/entry.js'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {versionSchema} from './contracts.js'
import {digestEligible,selectContextCandidates,type ContextCandidate,type ContextInput} from './context-candidates.js'
import type {ProjectDigest} from './project-digests.js'

const refSchema=z.object({entry_id:z.string().min(1),version:versionSchema}).strict()
const line=(max:number)=>z.string().trim().min(1).max(max).nullable().default(null)
/** A todo card says what, why now, and one concrete next step; a goal card names a state to reach, how to tell it is reached, and a first step; ideas leave why/next null. */
export const contextCardSchema=z.object({candidate_id:z.string().min(1).max(128),tab:z.enum(['todos','ideas','goals']),title:z.string().trim().min(1).max(80),body:z.string().trim().min(1).max(120),why:line(80),next:line(80),refs:z.array(refSchema).min(1).max(8)}).strict()
export const recapSchema=z.object({text:z.string().trim().min(1).max(160),refs:z.array(refSchema).min(1).max(8)}).strict()
export const contextCardsSchema=z.object({recap:recapSchema.nullable().default(null),cards:z.array(contextCardSchema).max(9)}).strict()
export type ContextCards=z.infer<typeof contextCardsSchema>
export type ContextEntry=ContextInput | (Pick<MemoryEntry,'id'|'version'|'content'> & {origin?:'stated'|'inferred'})
export type ContextGenerator=(candidates:readonly ContextCandidate[],signal:AbortSignal)=>Promise<z.input<typeof contextCardsSchema>>
const keyOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const generationRevision='project-digest-v4'
const stateSchema=contextCardsSchema.extend({recap_basis:z.array(z.string().max(128)).max(20).default([]),card_sources:z.record(z.string().max(128),z.object({root:z.string().max(512),entries:z.array(z.string().max(512)).max(64)}).strict()).default({}),version:z.literal(2),key:z.string(),automatic_call_times:z.array(z.number().int().nonnegative()).max(6).default([]),retry_key:z.string().default(''),retry_not_before:z.number().int().nonnegative().default(0),dismissed:z.array(z.string()).max(1000),legacyDismissed:z.array(z.object({tab:z.string(),refs:z.array(refSchema)}).strict()).max(1000)})
type State=z.infer<typeof stateSchema>
const diskSchema=z.preprocess(value=>{
 // An earlier local build recorded only cited refs under card_basis; that is not complete provenance, so it is dropped rather than trusted.
 if(value&&typeof value==='object'&&'card_basis' in value){const rest={...value as Record<string,unknown>};delete rest.card_basis;value=rest}
 if(!value||typeof value!=='object'||'version' in value)return value
 const old=value as {cards?:unknown;dismissed?:unknown}
 const legacy=z.object({cards:z.array(z.object({tab:z.string(),title:z.string(),body:z.string(),refs:z.array(refSchema)}).passthrough()),dismissed:z.array(z.string()),key:z.string()}).safeParse(old)
 if(!legacy.success)return emptyState()
 return {version:2,recap:null,recap_basis:[],cards:[],key:'',dismissed:[],legacyDismissed:legacy.data.cards.filter(card=>legacy.data.dismissed.includes(keyOf(card))).map(card=>({tab:card.tab,refs:card.refs}))}
},stateSchema)
const emptyState=():State=>({version:2,recap:null,recap_basis:[],card_sources:{},cards:[],key:'',automatic_call_times:[],retry_key:'',retry_not_before:0,dismissed:[],legacyDismissed:[]})
const sameRef=(a:{entry_id:string;version:string|number},b:{entry_id:string;version:string|number})=>a.entry_id===b.entry_id&&a.version===b.version
const leaksRawText=(text:string)=>/(?:^|[^\w.])\/[\w.-]+\/[\w.-]|\b[A-Za-z]:[\\/]|\\\\[\w.$-]+\\|~[\\/]|\b(?:source|file):[\w-]+|\b(?:src|config|docs|runtime|clients)\/[\w./-]+|\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=：]|\b[a-f\d]{40,}\b/iu.test(text)
const leaksRawField=(card:ContextCards['cards'][number])=>leaksRawText([card.title,card.body,card.why??'',card.next??''].join(' '))

/** Disposable, source-grounded suggestions. Saved Life records live elsewhere. */
export class WorkbenchContext{
 #store:BoundedJsonStore<State>;#state:State=emptyState();#inputs:ContextInput[]=[];#candidates:ContextCandidate[]=[];#abort=new AbortController();#run:Promise<void>|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#status='idle';#opened=false;#tail:Promise<unknown>=Promise.resolve();#firstChangeAt:number|null=null;#lastChangeAt=0;#pendingKey='';#manualPending=false;#digests:readonly ProjectDigest[]|undefined;#digestsPending=0
 constructor(path:string,readonly generate:ContextGenerator|undefined,readonly changed:()=>void){this.#store=new BoundedJsonStore(path,diskSchema)}
 async open(){try{this.#state=await this.#store.read(emptyState())}catch(error){if(!(error instanceof z.ZodError))throw error;this.#state=emptyState()}this.#opened=true;this.#abort=new AbortController();this.#firstChangeAt=null;this.#pendingKey='';this.#manualPending=false}
 async close(){this.#opened=false;clearTimeout(this.#timer);this.#timer=undefined;this.#manualPending=false;this.#abort.abort();await this.#run;await this.#tail}
 async clear(){const reopen=this.#opened;await this.close();this.#inputs=[];this.#candidates=[];this.#digests=undefined;this.#digestsPending=0;await this.#write(next=>Object.assign(next,emptyState()));this.#abort=new AbortController();this.#opened=reopen;this.#status='idle'}
 #candidate(card:ContextCards['cards'][number]){return this.#candidates.find(candidate=>candidate.candidate_id===card.candidate_id&&candidate.tab===card.tab&&card.refs.every(ref=>candidate.refs.some(allowed=>sameRef(ref,allowed))))}
 /**
  * A project card outlives a digest rewrite until the next generation replaces it: during a first scan digests are rewritten far more often than cards are regenerated.
  * Every entry the card was derived from, cited or read uncited by its digest, must still be present, and for a project card still pass the digest rule, so withdrawn material never resurfaces; the card then cites the successor's current refs.
  * Document cards keep an exact match.
  */
 #shownRefs(card:ContextCards['cards'][number]){
  const basis=this.#state.card_sources[card.candidate_id]
  const project=basis?.root.startsWith('project:')
  if(basis&&!basis.entries.every(id=>this.#inputs.some(input=>input.id===id&&(!project||digestEligible(input)))))return null
  if(this.#candidate(card))return card.refs
  if(!basis||!project)return null
  return this.#candidates.find(candidate=>candidate.root===basis.root&&candidate.tab===card.tab)?.refs??null
 }
 #recapGrounded(recap:{refs:readonly {entry_id:string;version:string|number}[]},candidates:readonly ContextCandidate[]=this.#candidates){return recap.refs.every(ref=>candidates.some(c=>c.tab==='todos'&&c.refs.some(allowed=>sameRef(ref,allowed))))}
 /** Todo candidates a recap draws on; any of them changing or leaving retires the recap, even if its cited refs survive. */
 #recapBasis(recap:{refs:readonly {entry_id:string;version:string|number}[]},candidates:readonly ContextCandidate[]){return candidates.filter(c=>c.tab==='todos'&&c.refs.some(allowed=>recap.refs.some(ref=>sameRef(ref,allowed)))).map(c=>c.candidate_id)}
 #recapCurrent(){const basis=this.#state.recap_basis;return Boolean(this.#state.recap)&&basis.length>0&&basis.every(id=>this.#candidates.some(c=>c.tab==='todos'&&c.candidate_id===id))&&this.#recapGrounded(this.#state.recap!)}
 #emptyReason(tab:'todos'|'ideas'|'goals',cards:number){if(cards)return null;if(!this.#candidates.some(c=>c.tab===tab))return tab!=='ideas'&&this.#digestsPending?'digests_pending':'no_eligible_sources';return this.#status==='ready'?'model_abstained':this.#status==='failed'?'generation_failed':null}
 #key(){return keyOf([generationRevision,this.#candidates.map(candidate=>[candidate.candidate_id,candidate.version])])}
 /** Active own projects, one line each, straight from their digests; no model call. */
 #projects(){return (this.#digests??[]).filter(d=>d.role==='own').slice(0,4).map(d=>({name:d.name,line:d.focus??d.summary})).filter(p=>!leaksRawText(p.name+' '+p.line))}
 snapshot(){
  const recap=this.#recapCurrent()?this.#state.recap!.text:null,cards=this.#state.cards.flatMap(card=>{const refs=this.#shownRefs(card);return refs&&!this.#state.dismissed.includes(card.candidate_id)?[{card,refs}]:[]}).map(({card,refs})=>({...structuredClone(card),id:card.candidate_id,refs:refs.map(ref=>({...ref,label:this.#inputs.find(input=>input.id===ref.entry_id)?.content.slice(0,700)??ref.entry_id}))}))
  const empty_reasons={todos:this.#emptyReason('todos',cards.filter(card=>card.tab==='todos').length),ideas:this.#emptyReason('ideas',cards.filter(card=>card.tab==='ideas').length),goals:this.#emptyReason('goals',cards.filter(card=>card.tab==='goals').length)}
  return {status:this.#status,candidate_count:this.#candidates.length,recap:{text:recap,projects:this.#projects()},empty_reason:this.#candidates.length===0?this.#digestsPending?'digests_pending':'no_eligible_sources':cards.length===0&&this.#status==='ready'?'model_abstained':cards.length===0&&this.#status==='failed'?'generation_failed':null,empty_reasons,cards}
 }
 #write(fn:(next:State)=>void){const run=this.#tail.then(async()=>{const next=structuredClone(this.#state);fn(next);await this.#store.write(next);this.#state=next;this.changed()});this.#tail=run.catch(()=>undefined);return run}
 dismiss(id:string){if(!this.#state.cards.some(card=>card.candidate_id===id))throw Error('card_not_found');return this.#write(next=>{next.dismissed=[...new Set([...next.dismissed,id])].slice(-1000)})}
 update(entries:readonly ContextEntry[],digests?:{items:readonly ProjectDigest[];pending:number}){
  this.#digests=digests?.items;this.#digestsPending=digests?.pending??0
  this.#inputs=entries.flatMap<ContextInput>(entry=>{
   if('kind' in entry&&entry.kind==='file')return [entry]
   if('kind' in entry&&entry.kind==='memory')return entry.version===null?[]:[entry]
   if('origin' in entry&&entry.version!==null)return [{kind:'memory',id:entry.id,version:entry.version,content:entry.content,origin:entry.origin??'inferred'}]
   return []
  }).filter(entry=>entry.content.trim())
  this.#candidates=selectContextCandidates(this.#inputs,this.#digests)
  if(this.#state.legacyDismissed.length){const mapped:string[]=[],unmatched:State['legacyDismissed']=[];for(const old of this.#state.legacyDismissed){const matches=this.#candidates.filter(candidate=>candidate.tab===old.tab&&old.refs.length===candidate.refs.length&&old.refs.every(ref=>candidate.refs.some(allowed=>sameRef(ref,allowed))));if(matches.length===1)mapped.push(matches[0]!.candidate_id);else unmatched.push(old)}if(mapped.length)void this.#write(next=>{next.dismissed=[...new Set([...next.dismissed,...mapped])].slice(-1000);next.legacyDismissed=unmatched}).catch(()=>undefined)}
  this.changed();if(!this.#opened||!this.generate)return
  const key=this.#key();if(!this.#candidates.length||key===this.#state.key){clearTimeout(this.#timer);this.#timer=undefined;this.#firstChangeAt=null;this.#pendingKey='';return}
  if(key!==this.#pendingKey){const now=Date.now();if(this.#firstChangeAt===null)this.#firstChangeAt=now;this.#lastChangeAt=now;this.#pendingKey=key}
  this.#schedule()
 }
 #schedule(){
  clearTimeout(this.#timer);this.#timer=undefined
  if(!this.#opened||!this.generate||this.#run||!this.#candidates.length||this.#key()===this.#state.key||this.#firstChangeAt===null)return
  const now=Date.now(),recent=this.#state.automatic_call_times.filter(at=>at>now-3_600_000),first=this.#state.automatic_call_times.length===0&&this.#state.key===''
  const due=Math.min(this.#firstChangeAt+(first?10_000:120_000),this.#lastChangeAt+(first?3_000:30_000))
  const eligible=Math.max(due,(recent.at(-1)??-Infinity)+120_000,recent.length>=6?recent[0]!+3_600_000:-Infinity,this.#state.retry_key===this.#key()?this.#state.retry_not_before:0)
  this.#timer=setTimeout(()=>{this.#timer=undefined;if(this.#key()!==this.#state.key)void this.#generate(true)},Math.max(0,eligible-now));this.#timer.unref()
 }
 async refresh():Promise<void>{if(this.#run){this.#manualPending=true;return this.#run}await this.#generate(false)}
 async #generate(automatic:boolean):Promise<void>{
  if(!this.#opened||!this.generate||this.#run||!this.#candidates.length)return
  clearTimeout(this.#timer);this.#timer=undefined
  const candidates=structuredClone(this.#candidates),key=this.#key();if(key===this.#state.key){this.#status='ready';this.changed();return}
  this.#firstChangeAt=null;this.#pendingKey='';this.#status='working';this.changed()
  const signal=AbortSignal.any([this.#abort.signal,AbortSignal.timeout(120000)])
  let failedAt=0
  const run=(async()=>{try{
   if(automatic)await this.#write(next=>{next.automatic_call_times=[...next.automatic_call_times.filter(at=>at>Date.now()-3_600_000),Date.now()].slice(-6)})
   const result=contextCardsSchema.parse(await this.generate!(candidates,signal));signal.throwIfAborted()
   const seen=new Set<string>()
   const cards=result.cards.filter(card=>{if(seen.has(card.candidate_id)||leaksRawField(card)||!this.#candidate(card)||!card.refs.every(ref=>candidates.some(candidate=>candidate.candidate_id===card.candidate_id&&candidate.refs.some(allowed=>sameRef(ref,allowed)))))return false;seen.add(card.candidate_id);return true})
   const basis=result.recap?this.#recapBasis(result.recap,candidates):[]
   const recap=result.recap&&basis.length&&!leaksRawText(result.recap.text)&&this.#recapGrounded(result.recap,candidates)?result.recap:null
   const cardBasis=Object.fromEntries(cards.map(card=>{const candidate=candidates.find(c=>c.candidate_id===card.candidate_id)!;return [card.candidate_id,{root:candidate.root,entries:[...(candidate.sources??new Set(candidate.refs.map(ref=>ref.entry_id)))]}]}))
   await this.#write(next=>{next.recap=recap;next.recap_basis=recap?basis:[];next.card_sources=cardBasis;next.cards=cards;next.key=key;next.retry_key='';next.retry_not_before=0});this.#status='ready'
  }catch(error){failedAt=Date.now();if(this.#opened&&!signal.aborted)await this.#write(next=>{next.retry_key=key;next.retry_not_before=failedAt+300000}).catch(()=>undefined);this.#status='failed';console.error('[workbench-context] generation_failed',error instanceof z.ZodError?JSON.stringify(error.issues.map(i=>({code:i.code,path:i.path}))):error instanceof Error?error.name:'unknown')}finally{this.#run=undefined;this.changed();if(this.#opened){if(this.#manualPending){this.#manualPending=false;void this.refresh()}else if(key!==this.#key())this.update(this.#inputs,this.#digests&&{items:this.#digests,pending:this.#digestsPending});else if(this.#status==='failed'){this.#firstChangeAt=failedAt;this.#lastChangeAt=failedAt;this.#pendingKey=key;this.#schedule()}}}})();this.#run=run;await run
 }
}
