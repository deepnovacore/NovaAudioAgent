import {z} from 'zod'
import {newsArticleSchema} from '../personal-agent/life.js'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {NEWS_SOURCES,newsLanguage,digest,fetchFeed,type Article,type NewsSource} from './feeds.js'
import {scoreSchema,validateScores,type NewsRanker} from './ranking.js'
const interest=z.object({id:z.string(),text:z.string().min(1).max(100),weight:z.number().min(0).max(2)})
const article=z.object({id:z.string(),source_id:z.string(),title:z.string().max(300),summary:z.string().max(1500),url:z.string().url(),published_at:z.string().nullable(),first_seen:z.string(),content_hash:z.string(),read:z.boolean(),saved:z.boolean(),ranking:scoreSchema.extend({profile_version:z.number(),ready_at:z.string()}).nullable()})
const schema=z.object({version:z.literal(1),profile_version:z.number(),enabled:z.boolean(),explore:z.boolean(),interests:z.array(interest).max(8),/** Interests guessed from the Profile stay local: they order nothing until the user saves them. */interests_seeded:z.boolean().default(false),blocked:z.array(z.string()).max(20),items:z.array(article).max(500),sources:z.array(z.object({id:z.string(),last_attempt:z.string().nullable(),last_success:z.string().nullable(),error:z.string().nullable(),count:z.number()})),rank_error:z.string().nullable()})
type State=z.infer<typeof schema>
export interface NewsOptions {path:string;language?:string;sources?:NewsSource[];rank?:NewsRanker;fetcher?:typeof fetch;changed?:()=>void;now?:()=>Date;/** Delay before the first automatic refresh after open, so launch work goes first; null turns automatic refresh off. */firstRefreshMs?:number|null}
// ponytail: bounded 500-article cache; add indexed storage only if this measured ceiling grows.
export class NewsService{
 #store:BoundedJsonStore<State>;#state:State;#opened=false;#abort=new AbortController();#timer:ReturnType<typeof setInterval>|undefined;#first:ReturnType<typeof setTimeout>|undefined;#run:Promise<void>|undefined;#rerun=false;#tail:Promise<unknown>=Promise.resolve();#sources:NewsSource[]
 constructor(readonly options:NewsOptions){this.#store=new BoundedJsonStore(options.path,schema);this.#sources=(options.sources??NEWS_SOURCES).filter(s=>(s.language??'en')===newsLanguage(options.language??'en'));this.#state={version:1,profile_version:0,enabled:true,explore:true,interests:[],interests_seeded:false,blocked:[],items:[],sources:this.#sources.map(s=>({id:s.id,last_attempt:null,last_success:null,error:null,count:0})),rank_error:null}}
 #now(){return this.options.now?.()??new Date()}
 #serial<T>(fn:()=>Promise<T>):Promise<T>{const run=this.#tail.then(fn);this.#tail=run.catch(()=>{/* optional cleanup/observer */});return run}
 async #save(next:State){await this.#store.write(next);this.#state=next;this.options.changed?.()}
 async open(){if(this.#opened)return;this.#state=await this.#store.read(this.#state)
  // News is on by default; a never-configured file that says off is the old default, while any explicit choice advanced profile_version.
  if(this.#state.profile_version===0&&!this.#state.enabled)this.#state={...this.#state,enabled:true}
  this.#opened=true;this.#abort=new AbortController();const delay=this.options.firstRefreshMs===undefined?20_000:this.options.firstRefreshMs;if(delay===null)return
  const tick=()=>{void this.refresh().catch(()=>{/* optional cleanup/observer */})}
  this.#first=setTimeout(()=>{this.#first=undefined;tick()},delay);this.#first.unref();this.#timer=setInterval(tick,15*60*1000);this.#timer.unref()}
 /** Refreshes now unless the first automatic refresh is still pending, which will read the same state. */
 refreshSoon():Promise<void>{return this.#first?Promise.resolve():this.refresh()}
 async close(){this.#opened=false;clearTimeout(this.#first);this.#first=undefined;clearInterval(this.#timer);this.#abort.abort();await this.#run?.catch(()=>{/* optional cleanup/observer */});await this.#tail}
 async configure(raw:unknown){const value=z.object({enabled:z.boolean(),interests:z.array(z.string().trim().min(1).max(100)).max(8),explore:z.boolean(),expected_version:z.number().int().optional()}).strict().refine(v=>!v.enabled||v.interests.length>0,'interests_required').parse(raw)
  return this.#serial(async()=>{if(value.expected_version!==undefined&&value.expected_version!==this.#state.profile_version)throw Error('version_conflict');const next=structuredClone(this.#state);const texts=[...new Set(value.interests)];const interests=texts.map(text=>({id:digest(text).slice(0,16),text,weight:next.interests.find(i=>i.text===text)?.weight??1}))
   if(next.profile_version===0||value.enabled!==next.enabled||value.explore!==next.explore||JSON.stringify(interests.map(i=>i.text).sort())!==JSON.stringify(next.interests.map(i=>i.text).sort()))next.profile_version++
   Object.assign(next,{enabled:value.enabled,explore:value.explore,interests,interests_seeded:false,rank_error:null});await this.#save(next)
  })
 }
 /** Seeds interests generated from the Profile once, and only while the user has never configured news; returns whether it applied. */
 seedInterests(raw:readonly string[]):Promise<boolean>{
  const texts=[...new Set(raw.map(text=>text.trim()).filter(text=>text.length>0&&text.length<=100))].slice(0,8)
  return this.#serial(async()=>{if(!texts.length||this.#state.profile_version!==0||this.#state.interests.length||!this.#state.enabled)return false
   await this.#save({...structuredClone(this.#state),profile_version:1,interests:texts.map(text=>({id:digest(text).slice(0,16),text,weight:1})),interests_seeded:true,rank_error:null});return true})
 }
 async action(raw:unknown){const p=z.discriminatedUnion('action',[
  z.object({action:z.enum(['read','save']),id:z.string(),value:z.boolean()}).strict(),
  z.object({action:z.literal('weight'),interest_id:z.string(),value:z.number().min(0).max(2)}).strict(),
  z.object({action:z.literal('block'),source_id:z.string(),value:z.boolean()}).strict(),
 ]).parse(raw)
  return this.#serial(async()=>{const next=structuredClone(this.#state)
   if(p.action==='weight'){const i=next.interests.find(i=>i.id===p.interest_id);if(!i)throw Error('interest_not_found');i.weight=p.value}
   else if(p.action==='block'){if(!this.#sources.some(s=>s.id===p.source_id))throw Error('source_not_found');next.blocked=next.blocked.filter(id=>id!==p.source_id);if(p.value)next.blocked.push(p.source_id)}
   else{const row=next.items.find(i=>i.id===p.id);if(!row)throw Error('article_not_found');if(p.action==='save'&&p.value&&!row.saved&&next.items.filter(i=>i.saved).length>=100)throw Error('saved_limit_100');row[p.action==='save'?'saved':'read']=p.value}
   await this.#save(next)
  })
 }
 /** Resolve only a user-selected cached article; this method never records personal facts. */
 conversionInput(raw:unknown){
  const p=z.object({id:z.string(),content_hash:z.string(),kind:z.enum(['idea','todo','goal']),title:z.string().trim().min(1).max(200),note:z.string().max(4000).default('')}).strict().parse(raw)
  const row=this.#state.items.find(item=>item.id===p.id&&this.#sources.some(source=>source.id===item.source_id));if(!row)throw Error('article_not_found')
  if(row.content_hash!==p.content_hash)throw Error('article_changed')
  return {op:'from_news' as const,kind:p.kind,title:p.title,note:p.note,article:newsArticleSchema.parse({article_id:row.id,source_id:row.source_id,url:row.url,content_hash:row.content_hash,title:row.title,summary:row.summary,published_at:row.published_at})}
 }
 snapshot(){const s=this.#state,now=this.#now().getTime();const visible=s.items.filter(a=>this.#sources.some(source=>source.id===a.source_id)&&!s.blocked.includes(a.source_id));const weight=(a:typeof s.items[number])=>a.ranking?.profile_version===s.profile_version?Math.max(0,...a.ranking.matches.map(m=>m.score*(a.ranking?.judgment?.substance==='promotional'?0.5:a.ranking?.judgment?.substance==='thin'?0.85:1)*(s.interests.find(i=>i.id===m.interest_id)?.weight??0))):0
  const fresh=visible.filter(a=>now-Date.parse(a.published_at??a.first_seen)<7*86400000)
  const ready=fresh.filter(a=>a.ranking?.profile_version===s.profile_version);const fallback=ready.length===0
  const ranked=(fallback?fresh:fresh.filter(a=>weight(a)>0)).slice().sort((a,b)=>fallback?b.first_seen.localeCompare(a.first_seen):(weight(b)/(1+Math.max(0,now-Date.parse(b.published_at??b.first_seen))/86400000))-(weight(a)/(1+Math.max(0,now-Date.parse(a.published_at??a.first_seen))/86400000))||a.id.localeCompare(b.id))
  const selected:typeof ranked=[];const counts=new Map<string,number>();for(const a of ranked){if((counts.get(a.source_id)??0)>=5)continue;selected.push(a);counts.set(a.source_id,(counts.get(a.source_id)??0)+1);if(selected.length>=10)break}
  const exploration=new Set<string>();if(s.explore&&!fallback){for(const a of ready.filter(a=>a.ranking?.matches.length===0).sort((a,b)=>b.first_seen.localeCompare(a.first_seen))){if(exploration.size>=2)break;if((counts.get(a.source_id)??0)>=5)continue;selected.push(a);exploration.add(a.id);counts.set(a.source_id,(counts.get(a.source_id)??0)+1)}}
  const map=(a:typeof s.items[number])=>({...a,summary:a.summary.slice(0,700),ranking:a.ranking?.profile_version===s.profile_version?a.ranking:null,exploration:exploration.has(a.id)})
  return {enabled:s.enabled,explore:s.explore,interests:structuredClone(s.interests),interests_seeded:s.interests_seeded,profile_version:s.profile_version,refreshing:!!this.#run,mode:fallback?'timeline':'personalized',rank_error:s.rank_error,pending:fresh.filter(a=>a.ranking?.profile_version!==s.profile_version).length,total:visible.length,items:selected.map(map),saved:s.items.filter(a=>a.saved&&this.#sources.some(source=>source.id===a.source_id)).map(map),sources:this.#sources.map(source=>({...source,...s.sources.find(s=>s.id===source.id),blocked:s.blocked.includes(source.id)}))}
 }
 refresh():Promise<void>{if(this.#run){this.#rerun=true;return this.#run}if(!this.#opened||!this.#state.enabled)return Promise.resolve()
  const run=(async()=>{do{this.#rerun=false;await this.#refresh()}while(this.#rerun&&this.#opened&&this.#state.enabled)})();this.#run=run;this.options.changed?.();void run.finally(()=>{this.#run=undefined;this.options.changed?.()}).catch(()=>{/* optional cleanup/observer */});return run
 }
 async #refresh(){const signal=this.#abort.signal
  for(const source of this.#sources){if(signal.aborted||!this.#state.enabled)return;if(this.#state.blocked.includes(source.id))continue
   let articles:Article[]=[],error:string|null=null
   try{articles=await fetchFeed(source,AbortSignal.any([signal,AbortSignal.timeout(15000)]),this.options.fetcher,this.#now())}catch(e){error=e instanceof Error&&/^(invalid_feed|feed_|source_http_|empty_feed)/u.test(e.message)?e.message.slice(0,80):'source_unavailable'}
   if(signal.aborted)return
   await this.#serial(async()=>{const next=structuredClone(this.#state);if(!next.enabled||next.blocked.includes(source.id))return
    const status=next.sources.find(s=>s.id===source.id)??{id:source.id,last_attempt:null,last_success:null,error:null,count:0};if(!next.sources.includes(status))next.sources.push(status)
    status.last_attempt=this.#now().toISOString();status.error=error;status.count=articles.length;if(!error)status.last_success=status.last_attempt
    for(const a of articles){const old=next.items.find(i=>i.id===a.id);if(old){if(old.content_hash!==a.content_hash)Object.assign(old,a,{first_seen:old.first_seen,ranking:null})}else next.items.push({...a,read:false,saved:false,ranking:null})}
    const saved=next.items.filter(a=>a.saved),other=next.items.filter(a=>!a.saved).sort((a,b)=>b.first_seen.localeCompare(a.first_seen));next.items=[...saved,...other.slice(0,500-saved.length)];await this.#save(next)
   })
  }
  if(signal.aborted||!this.#state.enabled)return
  // Without interests, or with interests only guessed from the Profile, the page is a timeline: ranking would send them to a provider the user never chose for this.
  if(!this.#state.interests.length||this.#state.interests_seeded){if(this.#state.rank_error)await this.#serial(()=>this.#save({...this.#state,rank_error:null}));return}
  if(!this.options.rank){await this.#serial(()=>this.#save({...this.#state,rank_error:'model_unavailable'}));return}
  // Round-robin by source bounds cost without a semantic keyword prefilter.
  const version=this.#state.profile_version,interests=structuredClone(this.#state.interests)
  const queues=this.#sources.filter(s=>!this.#state.blocked.includes(s.id)).map(s=>this.#state.items.filter(a=>a.source_id===s.id&&a.ranking?.profile_version!==version&&this.#now().getTime()-Date.parse(a.published_at??a.first_seen)<7*86400000).sort((a,b)=>b.first_seen.localeCompare(a.first_seen)))
  const batch:Article[]=[];while(batch.length<24&&queues.some(q=>q.length))for(const q of queues){const a=q.shift();if(a&&batch.length<24)batch.push(a)}
  if(!batch.length){if(this.#state.rank_error)await this.#serial(()=>this.#save({...this.#state,rank_error:null}));return}
  try{
   for(let start=0;start<batch.length;start+=8){if(signal.aborted||!this.#state.enabled||this.#state.profile_version!==version)return
    const part=batch.slice(start,start+8);const scores=validateScores(await this.options.rank(interests,part,AbortSignal.any([signal,AbortSignal.timeout(45000)])),interests,part)
    await this.#serial(async()=>{if(!this.#opened||!this.#state.enabled||this.#state.profile_version!==version)return;const next=structuredClone(this.#state)
     for(const score of scores){const row=next.items.find(a=>a.id===score.id);if(row&&row.content_hash===part.find(a=>a.id===score.id)?.content_hash)row.ranking={...score,profile_version:version,ready_at:this.#now().toISOString()}}
     next.rank_error=null;await this.#save(next)
    })
   }
  }catch{if(!signal.aborted)await this.#serial(()=>this.#save({...this.#state,rank_error:'ranking_failed'}))}
 }
}
