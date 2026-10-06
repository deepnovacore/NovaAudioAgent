import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

const now='2026-09-21T00:00:00Z'
const evidence={id:'personal:test:e:one',source_id:'personal:test:source',source_kind:'conversation',locator:'message:1',observed_at:now,recorded_at:now,raw_text:'SYNTHETIC RAW LEDGER ONLY',hash:'synthetic',trust:'trusted_user'}
const candidate={entry_id:'personal:test:preference',kind:'preference',origin:'stated',written_by:'merge',evidence_refs:[evidence.id],content:{text:'我不吃辣'},recorded_at:now}
async function enable(client:MemoryLedgerClient){await client.memory('enable_files',{})}

test('Markdown is authoritative after migration and rebuilds a deleted SQLite revision index',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-authority-')),path=join(root,'ledger.sqlite')
 let client=new MemoryLedgerClient(path)
 try{
  await client.open();await client.memory('append_evidence',evidence);await client.memory('merge',candidate)
  await enable(client);const directory=join(path+'.memory','entries'),files=await readdir(directory)
  const document=await readFile(join(directory,files[0]!), 'utf8')
  assert.match(document,/我不吃辣/u);assert.ok(!document.includes('SYNTHETIC RAW LEDGER ONLY'))
  await client.close();const db=new DatabaseSync(path);db.exec('DELETE FROM memory_revisions');db.close()
  client=new MemoryLedgerClient(path);await client.open();await enable(client)
  const rows=await client.memory('list',{}) as EntryRevision[]
  assert.equal(rows.length,1);assert.equal(rows[0]?.content.text,'我不吃辣');assert.equal(rows[0]?.revision,1)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('a manual Markdown edit is admitted through correction merge and survives restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-edit-')),path=join(root,'ledger.sqlite')
 let client=new MemoryLedgerClient(path)
 try{
  await client.open();await enable(client);await client.memory('append_evidence',evidence);await client.memory('merge',candidate)
  const directory=join(path+'.memory','entries'),file=join(directory,(await readdir(directory))[0]!)
  const text=await readFile(file,'utf8'),at=text.lastIndexOf('我不吃辣')
  await writeFile(file,text.slice(0,at)+'最近可以吃一点'+text.slice(at+'我不吃辣'.length))
  let rows=await client.memory('list',{}) as EntryRevision[]
  assert.equal(rows[0]?.content.text,'最近可以吃一点');assert.equal(rows[0]?.written_by,'user_correction');assert.equal(rows[0]?.revision,2)
  await client.close();client=new MemoryLedgerClient(path);await client.open();await enable(client)
  rows=await client.memory('list',{}) as EntryRevision[];assert.equal(rows[0]?.content.text,'最近可以吃一点')
  assert.equal((await client.memory('history',{entry_id:candidate.entry_id}) as EntryRevision[]).length,2)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('a failed Git publication replays its durable SQLite outbox before exposing memory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-outbox-')),path=join(root,'ledger.sqlite')
 const client=new MemoryLedgerClient(path)
 try{
  await client.open();await enable(client);await client.memory('append_evidence',evidence)
  const lock=join(path+'.memory','.git','HEAD.lock');await writeFile(lock,'synthetic lock')
  await assert.rejects(client.memory('merge',candidate))
  await rm(lock)
  const rows=await client.memory('list',{}) as EntryRevision[]
  assert.equal(rows[0]?.content.text,'我不吃辣');assert.equal(rows[0]?.revision,1)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('malformed Markdown never blocks raw admission or revoking a processing grant',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-controls-')),path=join(root,'ledger.sqlite')
 const client=new MemoryLedgerClient(path)
 try{
  await client.open();await enable(client);await client.memory('append_evidence',evidence);await client.memory('merge',candidate)
  await client.memory('source_grant',{source_id:evidence.source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:'fixture',embedding_provider:null}})
  const directory=join(path+'.memory','entries'),file=join(directory,(await readdir(directory))[0]!);await writeFile(file,'user unfinished document')
  await client.memory('source_grant',{source_id:evidence.source_id,expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null}})
  assert.equal(await client.memory('processing_evidence',{id:evidence.id,purpose:'extraction',provider:'fixture'}),null)
  await client.memory('append_evidence',{...evidence,id:'personal:test:e:two',hash:'two',raw_text:'new raw admission'})
  await assert.rejects(client.memory('list',{}));assert.equal(await readFile(file,'utf8'),'user unfinished document')
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('a knowledge extraction marker is ledger-only and never reconciles Markdown per chunk',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-marker-')),path=join(root,'ledger.sqlite')
 const client=new MemoryLedgerClient(path)
 try{
  await client.open();await enable(client);await client.memory('append_evidence',evidence);await client.memory('merge',candidate)
  const directory=join(path+'.memory','entries'),file=join(directory,(await readdir(directory))[0]!);await writeFile(file,'user unfinished document')
  // Document indexing records one marker per chunk; a half-edited memory file must not block it or be read back each time.
  await client.memory('record_extraction',{evidence_id:evidence.id,attempt_id:'knowledge-index',extracted:{}})
  assert.equal(await readFile(file,'utf8'),'user unfinished document')
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('initial migration uses the ledger outbox and retries a failed first Git commit after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-initial-')),path=join(root,'ledger.sqlite')
 let client=new MemoryLedgerClient(path)
 try{
  await client.open();await client.memory('append_evidence',evidence);await client.memory('merge',candidate)
  // Initialize an empty owned destination, then block its first commit.
  const {MarkdownRepository}=await import('../src/memory-substrate/markdown-repository.js')
  new MarkdownRepository(path+'.memory').initialize()
  const lock=join(path+'.memory','.git','HEAD.lock');await writeFile(lock,'synthetic lock')
  await assert.rejects(enable(client));await client.close();await rm(lock)
  const db=new DatabaseSync(path);assert.ok(db.prepare('SELECT 1 FROM memory_file_outbox').get());db.close()
  client=new MemoryLedgerClient(path);await client.open();await enable(client)
  assert.equal((await client.memory('list',{}) as EntryRevision[])[0]?.content.text,'我不吃辣')
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('editing a Life Markdown body updates the typed domain projection without rewriting legacy JSON',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-life-')),path=join(root,'ledger.sqlite')
 const client=new MemoryLedgerClient(path)
 try{
  const {emptyLifeState}=await import('../src/personal-agent/life.js')
  await client.open();await enable(client)
  const legacy=emptyLifeState();legacy.profile.about='原个人资料';legacy.profile.version=1
  await client.memory('life_load',{namespace:'personal:test:life:',legacy})
  const directory=join(path+'.memory','entries'),file=join(directory,(await readdir(directory))[0]!)
  const text=await readFile(file,'utf8'),at=text.lastIndexOf('原个人资料');await writeFile(file,text.slice(0,at)+'更新后的个人资料'+text.slice(at+'原个人资料'.length))
  const loaded=await client.memory('life_load',{namespace:'personal:test:life:'}) as {state:typeof legacy}
  assert.equal(loaded.state.profile.about,'更新后的个人资料');assert.equal(loaded.state.profile.version,2)
  const rows=await client.memory('list',{}) as EntryRevision[];assert.equal(rows[0]?.revision,2);assert.equal(rows[0]?.written_by,'user_correction')
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('a second already-open client automatically joins file authority before writing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-multiclient-')),path=join(root,'ledger.sqlite')
 const first=new MemoryLedgerClient(path),second=new MemoryLedgerClient(path)
 let reopened:MemoryLedgerClient|undefined
 try{
  await second.open();await first.open();await enable(first)
  await first.memory('append_evidence',evidence);await first.memory('merge',candidate)
  const otherEvidence={...evidence,id:'personal:test:e:second',source_id:'personal:test:other-source',hash:'other-source'}
  await second.memory('append_evidence',otherEvidence)
  await second.memory('merge',{...candidate,entry_id:'personal:test:second',evidence_refs:[otherEvidence.id],content:{text:'Second worker persisted'}})
  assert.equal((await first.memory('list',{}) as EntryRevision[]).length,2)
  await first.close();await second.close();reopened=new MemoryLedgerClient(path);await reopened.open()
  assert.equal((await reopened.memory('list',{}) as EntryRevision[]).find(row=>row.entry_id==='personal:test:second')?.content.text,'Second worker persisted')
 }finally{await first.close();await second.close();await reopened?.close();await rm(root,{recursive:true,force:true})}
})

test('two workers opening the same ledger together both start instead of failing on the path lock',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-concurrent-open-')),path=join(root,'ledger.sqlite')
 const first=new MemoryLedgerClient(path),second=new MemoryLedgerClient(path)
 try{
  await Promise.all([first,second].map(async client=>{await client.open();await enable(client)}))
 }finally{await first.close();await second.close();await rm(root,{recursive:true,force:true})}
})

test('first file enable respects a live path lock before migrating any documents',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-file-first-lock-')),path=join(root,'ledger.sqlite')
 const client=new MemoryLedgerClient(path,{memoryLockWaitMs:0});const lock=join(path+'.memory','.nova-memory.lock')
 try{
  await client.open();await client.memory('append_evidence',evidence);await client.memory('merge',candidate)
  await writeFile(lock,JSON.stringify({pid:process.pid,token:'synthetic-live-owner'}))
  await assert.rejects(enable(client),{code:'STORE_MEMORY_CONFLICT'})
  assert.equal((await readdir(path+'.memory')).includes('.nova-memory.json'),false)
  await rm(lock);await enable(client)
  assert.equal((await client.memory('list',{}) as EntryRevision[])[0]?.content.text,candidate.content.text)
 }finally{await rm(lock,{force:true});await client.close();await rm(root,{recursive:true,force:true})}
})
