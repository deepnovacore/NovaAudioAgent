import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {VoiceMem} from 'voicemem'
import {VersionedMemory} from '../src/voicemem/versioned-memory.js'

const now = '2026-09-11T00:00:00.000Z'
const embeddings = {model:'test', embed(texts: readonly string[]) { return Promise.resolve(texts.map(() => [1,0])) }}
function open(path:string,userId='user') { return new VoiceMem({path,userId,embeddings,model:{complete(){return Promise.resolve('{}')}}}) }
function seed(memory:VoiceMem,id:string,text:string,sourceId=id,kind:'fact'|'trait'='fact') {
 const source=memory.store.admit({id:sourceId,userId:'user',scope:'personal',sessionId:'session',text,occurredAt:now,recordedAt:now,authority:'inferred',assistantReply:''})
 memory.store.commit(source,[{record:{id,userId:'user',scope:'personal',kind,text,subject:'user',attribute:kind==='trait'?'preference':'',slots:[],entities:[],emotion:'',authority:'inferred',occurredAt:now,recordedAt:now,revision:1,supersededBy:null,evidenceIds:[sourceId]},vector:[1,0],model:'test'}],[])
}
test('durable correction, stale versions, forgetting, suppression and user isolation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-entry-'));const path=join(dir,'memory.sqlite')
 let memory=open(path)
 try {
 seed(memory,'old','I prefer short replies')
 const entries=new VersionedMemory(memory,'user',embeddings)
 assert.equal(entries.list({}).entries.length,1)
 const corrected=await entries.correct('old',1,'I prefer detailed replies',{type:'conversation',ref:'user-correction',observed_at:now})
 assert.equal(corrected.previous.status,'corrected');assert.equal(corrected.entry.origin,'stated')
 assert.equal(corrected.entry.source_refs[0]?.ref,'user-correction')
 await assert.rejects(entries.correct('old',1,'stale',{type:'conversation',ref:'stale',observed_at:now}),/STORE_CONFLICT/)
 assert.equal((await memory.search('replies')).hits.some(hit=>hit.text==='I prefer short replies'),false)
 const forgotten=entries.forgetEntry(corrected.entry.id,1)
 assert.equal(forgotten.status,'forgotten');assert.equal(forgotten.content,'')
 assert.throws(()=>entries.forgetEntry(corrected.entry.id,1),/STORE_CONFLICT/)
 await memory.close(); memory=open(path)
 const reopened=new VersionedMemory(memory,'user',embeddings)
 assert.equal(reopened.get(corrected.entry.id)?.status,'forgotten')
 seed(memory,'repeated','I prefer detailed replies','new-sync')
 reopened.suppress()
 assert.equal((await memory.search('replies')).hits.length,0)
 assert.equal(reopened.list({}).entries.length,0)
 const other=open(path,'other');try {assert.equal(new VersionedMemory(other,'other',embeddings).get('old'),null)}finally{await other.close()}
 }finally{await memory.close();await rm(dir,{recursive:true,force:true})}
})

test('file observations retain typed provenance and forgotten inference stays suppressed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-observe-'));const memory=open(join(dir,'memory.sqlite'))
 try {
 const entries=new VersionedMemory(memory,'user',embeddings)
 const input={source_ref:{type:'file' as const,ref:'folder:project',observed_at:now},content:'Authorized directory contains project Example',topic:'Example'}
 const entry=await entries.observeSource(input)
 assert.equal(entry?.topic,'Example');assert.equal(entry?.origin,'inferred');assert.equal(entry?.source_refs[0]?.type,'file')
 assert.equal((await entries.observeSource(input))?.id,entry?.id)
 entries.forgetEntry(entry.id,entry.version)
 assert.equal(await entries.observeSource(input),null)
 const another=await entries.observeSource({...input,content:'Authorized directory contains project Another'})
 entries.forgetSource(input.source_ref.ref)
 assert.equal(entries.get(another!.id)?.status,'forgotten')
 }finally{await memory.close();await rm(dir,{recursive:true,force:true})}
})

test('removing one source restores independent surviving evidence and bumps its version',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-provenance-'));const memory=open(join(dir,'memory.sqlite'))
 try {
 seed(memory,'shared','Original conversation evidence','conversation','trait')
 const stored=memory.store.memory('user','personal','shared')!
 const source=memory.store.admit({id:'file',userId:'user',scope:'personal',sessionId:'file',text:'file evidence',occurredAt:now,recordedAt:now,authority:'inferred',assistantReply:''})
 memory.store.commit(source,[],[],[{id:'shared',revision:1,snapshot:{...stored,record:{...stored.record,text:'File-derived evidence',evidenceIds:['file']}}}])
 const entries=new VersionedMemory(memory,'user',embeddings)
 assert.equal(entries.get('shared')?.source_refs.length,2)
 entries.forgetSource('file')
 assert.equal(entries.get('shared')?.source_refs.length,1)
 assert.equal(entries.get('shared')?.content,'Original conversation evidence')
 assert.equal(entries.get('shared')?.status,'active')
 assert.equal(entries.get('shared')?.version,3)
 }finally{await memory.close();await rm(dir,{recursive:true,force:true})}
})
