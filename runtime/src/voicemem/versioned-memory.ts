import {createHash, randomUUID} from 'node:crypto'
import {MemoryStore, isGlobalReplyPreference, type VoiceMem, type EmbeddingModel, type MemoryRecord} from 'voicemem'
import {MemoryEntrySchema, MemoryObservationSchema, type MemoryObservation, MemoryListOptionsSchema, MemorySourceRefSchema, type MemoryEntry, type MemoryListOptions, type MemoryPage, type MemorySourceRef, type MemoryVersion} from '../memory/entry.js'

/** Projection and audit metadata share the existing VoiceMem database and transaction owner. */
export class VersionedMemory {
  private readonly store:MemoryStore
  constructor(memory:VoiceMem, private readonly userId:string, private readonly embeddings:EmbeddingModel) {this.store=new TransactionalStore(memory.store.db)}
  private key(kind:string,id:string):string {return JSON.stringify(['nova-entry',this.userId,'personal',kind,id])}
  private read(kind:string,id:string):unknown {
    const row=this.store.db.prepare('SELECT value FROM vm_meta WHERE key=?').get(this.key(kind,id))
    return row ? JSON.parse(String(row.value)) : undefined
  }
  private write(kind:string,id:string,value:unknown):void {
    this.store.db.prepare('INSERT OR REPLACE INTO vm_meta VALUES (?,?)').run(this.key(kind,id),JSON.stringify(value))
  }
  private project(record:MemoryRecord):MemoryEntry {
    const refs=record.evidenceIds.map(id=>{
      const saved=this.read('source',id)
      if(saved)return MemorySourceRefSchema.parse(saved)
      const source=this.store.source(this.userId,'personal',id)
      return {type:'conversation' as const,ref:id,observed_at:source?.occurredAt??source?.recordedAt??record.recordedAt}
    })
    const topic=record.evidenceIds.map(id=>this.read('topic',id)).find(value=>typeof value==='string')
    const replacement=record.supersededBy ? this.store.memory(this.userId,'personal',record.supersededBy):undefined
    return MemoryEntrySchema.parse({id:record.id,version:record.revision,content:record.text.slice(0,500),kind:record.kind==='trait'?'preference':record.kind==='heartnote'?'concern':'fact',origin:record.authority==='explicit'?'stated':'inferred',source_refs:refs,observed_at:record.occurredAt??refs[0]?.observed_at,recorded_at:record.recordedAt,topic:topic??record.slots[0]??'',status:record.supersededBy?'corrected':'active',corrected_to:replacement?.record.text.slice(0,500)??null,confidence_note:null})
  }
  list(options:MemoryListOptions={}):MemoryPage {
    const parsed=MemoryListOptionsSchema.parse(options)
    this.suppress()
    const records=this.store.list(this.userId,'personal',false,{vectors:false,includeArchived:true}).map(item=>item.record).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).filter(item=>!parsed.cursor||item.id>parsed.cursor)
    const page=records.slice(0,parsed.limit??50)
    return {entries:page.map(item=>this.project(item)),cursor:records.length>page.length?page.at(-1)!.id:null}
  }
  get(id:string):MemoryEntry|null {
    const tombstone=this.read('forgotten',id)
    if(tombstone)return MemoryEntrySchema.parse(tombstone)
    const item=this.store.memory(this.userId,'personal',id)
    return item?this.project(item.record):null
  }
  private current(id:string,version:MemoryVersion):MemoryEntry {
    const entry=this.get(id)
    if(!entry)throw new Error('STORE_NOT_FOUND')
    if(entry.status!=='active'||entry.version!==version)throw new Error('STORE_CONFLICT')
    return entry
  }
  async correct(id:string,version:MemoryVersion,content:string,userSource:MemorySourceRef):Promise<{previous:MemoryEntry;entry:MemoryEntry}> {
    const source=MemorySourceRefSchema.parse(userSource)
    if(source.type!=='conversation'||!content.trim()||content.length>500||content.includes('\0'))throw new Error('STORE_INVALID_INPUT')
    this.current(id,version)
    const [vector]=await this.embeddings.embed([content],undefined,'passage')
    if(!vector?.length||!vector.every(Number.isFinite))throw new Error('STORE_WRITE_FAILED')
    return this.store.transaction(()=>{
      this.current(id,version)
      const old=this.store.memory(this.userId,'personal',id)!.record
      const recordedAt=new Date().toISOString(),newId=randomUUID()
      // A typed reply-preference edit keeps that known role; unrelated derived labels are cleared.
      const replyPreference=isGlobalReplyPreference(old)
      const record:MemoryRecord={id:newId,userId:this.userId,scope:'personal',kind:replyPreference?'trait':'fact',text:content,subject:this.userId,attribute:replyPreference?'reply_preference':'',slots:[],entities:[],emotion:'',authority:'explicit',occurredAt:source.observed_at,recordedAt,revision:1,supersededBy:null,evidenceIds:[source.ref]}
      this.store.correct({id:source.ref,userId:this.userId,scope:'personal',sessionId:`correction:${id}`,text:content,occurredAt:source.observed_at,recordedAt,authority:'explicit',assistantReply:'',role:'user'},id,Number(version),{record,vector,model:this.embeddings.model})
      this.write('source',source.ref,source)
      this.write('suppressed',hash(old.text),true)
      return {previous:this.get(id)!,entry:this.project(record)}
    })
  }
  forgetEntry(id:string,version:MemoryVersion):MemoryEntry {
    return this.store.transaction(()=>{
      const entry=this.current(id,version)
      const record=this.store.memory(this.userId,'personal',id)!.record
      this.write('suppressed',hash(record.text),true)
      this.store.forget(this.userId,'personal',undefined,id)
      const forgotten={...entry,version:Number(entry.version)+1,status:'forgotten' as const,content:'',corrected_to:null}
      this.write('forgotten',id,forgotten)
      return forgotten
    })
  }
  forgetSource(ref:string):void {
    this.store.transaction(()=>{
      const records=this.store.list(this.userId,'personal',true,{includeArchived:true})
      const sourceIds=new Set([ref])
      for(const {record} of records)for(const id of record.evidenceIds){
        const saved=this.read('source',id)
        if(saved&&MemorySourceRefSchema.parse(saved).ref===ref)sourceIds.add(id)
      }
      for(const sourceId of sourceIds){
        const linked=this.store.sourceRecords(this.userId,'personal',sourceId).map(item=>this.project(item.record))
        this.store.forget(this.userId,'personal',sourceId)
        for(const entry of linked)if(!this.store.memory(this.userId,'personal',entry.id))this.write('forgotten',entry.id,{...entry,version:Number(entry.version)+1,status:'forgotten',content:'',corrected_to:null})
      }
    })
  }
  async observeSource(input:MemoryObservation):Promise<MemoryEntry|null> {
    const {source_ref:ref,content,topic}=MemoryObservationSchema.parse(input)
    if(ref.type==='conversation')throw new Error('STORE_INVALID_INPUT')
    const sourceId=`observation:${hash(JSON.stringify([ref.type,ref.ref,content]))}`
    if(this.read('suppressed',hash(content)))return null
    const existing=this.store.sourceRecords(this.userId,'personal',sourceId).find(item=>!item.record.supersededBy)
    if(existing)return this.project(existing.record)
    if(this.store.source(this.userId,'personal',sourceId)?.state==='forgotten')return null
    const [vector]=await this.embeddings.embed([content],undefined,'passage')
    if(!vector?.length||!vector.every(Number.isFinite))throw new Error('STORE_WRITE_FAILED')
    return this.store.transaction(()=>{
      if(this.read('suppressed',hash(content)))return null
      const concurrent=this.store.sourceRecords(this.userId,'personal',sourceId).find(item=>!item.record.supersededBy)
      if(concurrent)return this.project(concurrent.record)
      const recordedAt=new Date().toISOString()
      const source=this.store.admit({id:sourceId,userId:this.userId,scope:'personal',sessionId:`source:${hash(ref.ref)}`,text:content,occurredAt:ref.observed_at,recordedAt,authority:'inferred',assistantReply:'',role:'system'})
      if(source.state==='forgotten')return null
      const record:MemoryRecord={id:randomUUID(),userId:this.userId,scope:'personal',kind:'fact',text:content,subject:'authorized source',attribute:'',slots:[],entities:[],emotion:'',authority:'inferred',occurredAt:ref.observed_at,recordedAt,revision:1,supersededBy:null,evidenceIds:[sourceId]}
      const result=this.store.commit(source,[{record,vector,model:this.embeddings.model}],[])
      if(result===false)throw new Error('STORE_WRITE_FAILED')
      this.write('source',sourceId,ref)
      if(topic!==undefined)this.write('topic',sourceId,topic)
      const committed=result.find(item=>!item.record.supersededBy)
      return committed?this.project(committed.record):null
    })
  }
  /** Native source tombstones fence retries; content hashes also fence re-extraction under new source IDs. */
  suppress():void {
    for(const {record} of this.store.list(this.userId,'personal',false,{includeArchived:true})) {
      if(record.authority!=='explicit'&&this.read('suppressed',hash(record.text)))this.forgetEntry(record.id,record.revision)
    }
  }
}
// ponytail: exact normalized text suppression; semantic paraphrase suppression needs a separate reviewed policy.
function hash(text:string):string {return createHash('sha256').update(text.normalize('NFKC').trim().toLowerCase()).digest('hex')}

/** Savepoints let native correction/deletion and projection metadata commit atomically. No new connection. */
class TransactionalStore extends MemoryStore {
  override transaction<T>(fn:()=>T):T {
    const name=`nova_${randomUUID().replaceAll('-','')}`
    this.db.exec(`SAVEPOINT ${name}`)
    try {const result=fn();this.db.exec(`RELEASE ${name}`);return result}
    catch(error){this.db.exec(`ROLLBACK TO ${name}`);this.db.exec(`RELEASE ${name}`);throw error}
  }
}
