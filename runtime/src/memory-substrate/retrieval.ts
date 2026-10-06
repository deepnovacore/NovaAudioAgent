import {z} from 'zod'
import {EntryRevisionSchema,retrievalEvidence,effectiveEvidence,processingStamp,fileDerivedInference,type EntryRevision} from './store.js'
import type {LedgerDatabase} from '../memory-ledger/store.js'

const vectorSchema=z.array(z.number().finite()).min(1).max(4096).refine(vector=>vector.some(value=>value!==0),'zero embedding')
const key=z.string().min(1).max(512)
const latest=`SELECT r.entry_id,r.revision,r.payload_json FROM memory_revisions r JOIN (SELECT entry_id,MAX(revision) revision FROM memory_revisions GROUP BY entry_id) l USING(entry_id,revision)`
export function initializeRetrieval(db:LedgerDatabase):void {
 db.exec('CREATE TABLE IF NOT EXISTS memory_vectors(entry_id TEXT NOT NULL,revision INTEGER NOT NULL,provider TEXT NOT NULL,vector_json TEXT NOT NULL,PRIMARY KEY(entry_id,provider))')
}
function active(entry:EntryRevision):boolean{return entry.op!=='tombstone'&&(entry.valid_until===null||Date.parse(entry.valid_until)>Date.now())}
function hasEvidence(db:LedgerDatabase,entry:EntryRevision):boolean{return entry.evidence_refs.some(id=>retrievalEvidence(db,id)!==null)}
function consented(db:LedgerDatabase,entry:EntryRevision,provider:string):boolean {
 const live=entry.evidence_refs.map(id=>retrievalEvidence(db,id)).filter(value=>value!==null)
 return live.length===entry.evidence_refs.length&&live.every(value=>effectiveEvidence(db,value.id,{purpose:'embedding',provider})!==null)
}
export function memoryRetrieval(db:LedgerDatabase,operation:'pending_vectors'|'write_vectors'|'search',input:unknown):unknown {
 const value=z.record(z.string(),z.unknown()).parse(input)
 const prefix=key.parse(value.entry_prefix);const provider=key.parse(value.provider)
 if(operation==='write_vectors'){
  const batch=z.array(z.object({entry_id:key,revision:z.number().int().positive(),vector:vectorSchema,stamp:z.string().min(1).max(128)}).strict()).max(100).parse(value.entries)
  let count=0
  for(const item of batch){
   if(!item.entry_id.startsWith(prefix))throw Error('STORE_INVALID_OPERATION')
   const raw=db.prepare(`SELECT payload_json FROM (${latest}) WHERE entry_id=?`).get(item.entry_id)
   if(!raw)continue
   const entry=EntryRevisionSchema.parse(JSON.parse(String(raw.payload_json)))
   if(item.stamp!==processingStamp(db,entry.evidence_refs,'embedding',provider)||entry.revision!==item.revision||!active(entry)||!hasEvidence(db,entry)||!consented(db,entry,provider))continue
   db.prepare('INSERT INTO memory_vectors VALUES(?,?,?,?) ON CONFLICT(entry_id,provider) DO UPDATE SET revision=excluded.revision,vector_json=excluded.vector_json').run(item.entry_id,item.revision,provider,JSON.stringify(item.vector));count++
  }
  return count
 }
 const limit=operation==='pending_vectors'?z.number().int().min(1).max(100).parse(value.limit??100):value.scope==='recent'?200:5000
 const excludeFileInferences=z.boolean().parse(value.exclude_file_inferences??false)
 const fileClause=excludeFileInferences?`AND NOT (json_extract(r.payload_json,'$.origin')='inferred' AND json_extract(r.payload_json,'$.written_by')<>'user_correction' AND EXISTS (SELECT 1 FROM json_each(r.payload_json,'$.evidence_refs') ref JOIN memory_evidence e ON e.id=ref.value WHERE json_extract(e.payload_json,'$.source_kind')='file'))`:''
 // ponytail: scan the bounded current namespace in the existing Worker; add ANN only beyond 5000 active entries.
 const candidates=db.prepare(`SELECT r.payload_json,v.vector_json FROM (${latest}) r LEFT JOIN memory_vectors v ON v.entry_id=r.entry_id AND v.revision=r.revision AND v.provider=? WHERE substr(r.entry_id,1,length(?))=? AND json_extract(r.payload_json,'$.op')<>'tombstone' AND (json_extract(r.payload_json,'$.valid_until') IS NULL OR julianday(json_extract(r.payload_json,'$.valid_until'))>julianday(?)) ${fileClause} ${operation==='pending_vectors'?'AND v.entry_id IS NULL':''} ORDER BY json_extract(r.payload_json,'$.recorded_at') DESC,r.entry_id LIMIT ?`).all(provider,prefix,prefix,new Date().toISOString(),limit+1)
 const extractionProvider=value.extraction_provider===undefined?null:key.parse(value.extraction_provider)
 const kind=value.kind===undefined?null:key.parse(value.kind)
 const usable=candidates.slice(0,limit).map(row=>({entry:EntryRevisionSchema.parse(JSON.parse(String(row.payload_json))),vector:row.vector_json===null?null:vectorSchema.parse(JSON.parse(String(row.vector_json)))})).filter(row=>row.entry.kind!=='memory_summary'&&hasEvidence(db,row.entry)&&(kind===null||row.entry.kind===kind)&&(!excludeFileInferences||!fileDerivedInference(db,row.entry))).map(row=>({...row,extraction_stamp:extractionProvider?processingStamp(db,row.entry.evidence_refs,'extraction',extractionProvider):null})).filter(row=>extractionProvider===null||row.extraction_stamp!==null)
 if(operation==='pending_vectors')return usable.filter(row=>consented(db,row.entry,provider)).map(row=>row.entry)
 const query=z.string().min(1).max(4000).parse(value.query);const k=z.number().int().min(1).max(20).parse(value.limit??8)
 const queryVector=value.vector===null?null:vectorSchema.parse(value.vector)
 const scores=bm25(query,usable.map(row=>Object.values(row.entry.content).filter(value=>typeof value==='string').join(' ')))
 const lexical=usable.map((row,index)=>({row,score:scores[index]!})).filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,50)
 const semantic=queryVector?usable.flatMap(row=>row.vector?.length===queryVector.length&&consented(db,row.entry,provider)?[{row,score:cosine(queryVector,row.vector)}]:[]).filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,50):[]
 const fused=new Map<string,{entry:EntryRevision;score:number;extraction_stamp?:string}>()
 for(const ranking of [semantic,lexical])for(const [index,item] of ranking.entries()){const old=fused.get(item.row.entry.entry_id);fused.set(item.row.entry.entry_id,{entry:item.row.entry,score:(old?.score??0)+1/(60+index+1),...(item.row.extraction_stamp?{extraction_stamp:item.row.extraction_stamp}:{})})}
 return {hits:[...fused.values()].sort((a,b)=>b.score-a.score||a.entry.entry_id.localeCompare(b.entry.entry_id)).slice(0,k),degraded:queryVector===null||candidates.length>limit||usable.some(row=>row.vector?.length!==queryVector.length||!consented(db,row.entry,provider))}
}
function cosine(a:readonly number[],b:readonly number[]):number {
 let dot=0,left=0,right=0
 for(let i=0;i<a.length;i++){dot+=a[i]!*b[i]!;left+=a[i]!*a[i]!;right+=b[i]!*b[i]!}
 return left===0||right===0?-1:dot/Math.sqrt(left*right)
}

const segmenter=new Intl.Segmenter(undefined,{granularity:'word'})
function tokens(text:string):string[]{return [...segmenter.segment(text.normalize('NFKC').toLowerCase())].filter(part=>part.isWordLike).map(part=>part.segment)}
/** BM25 lexical ranking shares the hybrid retrieval path; tokens rank candidates, never decide intent or identity. */
export function bm25(query:string,documents:readonly string[]):number[]{
 const terms=[...new Set(tokens(query))].slice(0,24),docs=documents.map(tokens)
 const average=docs.reduce((sum,doc)=>sum+doc.length,0)/(docs.length||1)||1
 const frequencies=new Map(terms.map(term=>[term,docs.filter(doc=>doc.includes(term)).length]))
 return docs.map(doc=>terms.reduce((score,term)=>{
  const frequency=doc.filter(token=>token===term).length
  if(!frequency)return score
  const found=frequencies.get(term)!
  const idf=Math.log(1+(docs.length-found+0.5)/(found+0.5))
  return score+idf*frequency*2.2/(frequency+1.2*(0.25+0.75*doc.length/average))
 },0))
}
