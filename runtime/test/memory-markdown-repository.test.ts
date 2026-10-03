import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync,statSync,symlinkSync,mkdirSync,renameSync,linkSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync,spawn} from 'node:child_process'
import {MarkdownRepository} from '../src/memory-substrate/markdown-repository.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

const first:EntryRevision={entry_id:'personal:test:one',revision:1,supersedes:null,kind:'preference',origin:'stated',written_by:'merge',evidence_refs:['synthetic:evidence'],entity_refs:[],content:{text:'Prefer concise replies',aliases:['concise']},valid_until:null,op:'add',recorded_at:'2026-09-21T00:00:00.000Z'}
const next:EntryRevision={...first,revision:2,supersedes:1,op:'update',written_by:'user_correction',content:{text:'Prefer detailed replies'},evidence_refs:['synthetic:correction']}
function fixture(t:{after:(fn:()=>void)=>void}){const root=mkdtempSync(join(tmpdir(),'nova-markdown-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root}
function document(root:string){return join(root,'entries',readdirSync(join(root,'entries'))[0]!)}
function git(root:string,...args:string[]){return execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim()}

test('permanent purge keeps other histories and removes selected content from every Git object',t=>{
 const root=fixture(t),repo=new MarkdownRepository(root),keep={...first,entry_id:'personal:test:keep',content:{text:'keep synthetic'}}
 repo.open([first,next,keep]);const before=repo.read(),old=git(root,'rev-parse','HEAD')
 repo.purge([keep],'purge-selected',before.baselines)
 assert.deepEqual(repo.read().revisions,[keep]);assert.equal(git(root,'rev-list','--count','HEAD'),'1')
 assert.throws(()=>git(root,'cat-file','-e',old));assert.equal(git(root,'fsck','--no-reflogs','--unreachable'),'')
 repo.purge([keep],'purge-selected',before.baselines)
 assert.deepEqual(new MarkdownRepository(root).read().revisions,[keep])
})

test('permanent purge refuses concurrent body edits before deleting any document',t=>{
 const root=fixture(t),repo=new MarkdownRepository(root);repo.open([first]);const before=repo.read(),file=document(root)
 writeFileSync(file,readFileSync(file,'utf8').replace(/Prefer concise replies\n$/u,'New hand edit\n'))
 assert.throws(()=>repo.purge([],'purge-conflict',before.baselines),/CONFLICT/u)
 assert.match(readFileSync(file,'utf8'),/New hand edit/u)
})

test('Markdown migrates once and rebuilds the complete revision history without SQLite',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root)
 assert.deepEqual(repo.open([first]).revisions,[first])
 repo.publish([first,next])
 assert.deepEqual(new MarkdownRepository(root).open([]).revisions,[first,next])
 assert.deepEqual(new MarkdownRepository(root).open([first]).revisions,[first,next])
 assert.equal(git(root,'rev-list','--count','HEAD'),'2')
 assert.equal(git(root,'remote'),'')
 assert.equal(statSync(root).mode&0o777,0o700)
 assert.equal(statSync(document(root)).mode&0o777,0o600)
 assert.match(readFileSync(document(root),'utf8'),/Prefer detailed replies/)
 assert.throws(()=>repo.publish([next]),/HISTORY/)
})

test('external text edits produce corrections while preserving the old canonical revision',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first]);const path=document(root)
 // Only change the editable Markdown body, not machine-readable history.
 const old=readFileSync(path,'utf8');const split=old.lastIndexOf('Prefer concise replies')
 writeFileSync(path,old.slice(0,split)+'Prefer detailed replies'+old.slice(split+'Prefer concise replies'.length))
 const read=repo.read();assert.deepEqual(read.revisions,[first]);assert.equal(read.edits.length,1)
 assert.equal(read.edits[0]!.entry_id,first.entry_id);assert.equal(read.edits[0]!.expected_revision,1)
 assert.equal(read.edits[0]!.content.text,'Prefer detailed replies')
 assert.throws(()=>repo.publish([first]),/UNADMITTED_EDIT/)
 repo.publish([first,{...next,content:{...first.content,text:'Prefer detailed replies'}}])
 assert.equal(repo.read().edits.length,0)
 assert.equal(repo.read().revisions[0]!.content.text,'Prefer concise replies')
})

test('prepared and published batches recover after process interruption',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first])
 const operation=repo.prepare([first,next]);assert.ok(operation)
 const recovered=new MarkdownRepository(root);recovered.recover(operation);assert.deepEqual(recovered.open([]).revisions,[first,next])
 assert.equal(git(root,'rev-list','--count','HEAD'),'2')
 const third={...next,revision:3,supersedes:2,content:{text:'Detailed with examples'}}
 const reopened=new MarkdownRepository(root);reopened.open([]);const id=reopened.prepare([first,next,third]);reopened.publishPrepared(id)
 const recoveredAgain=new MarkdownRepository(root);recoveredAgain.recover(id);assert.deepEqual(recoveredAgain.open([]).revisions,[first,next,third])
 assert.equal(git(root,'rev-list','--count','HEAD'),'3')
})

test('concurrent hand edits are preserved and recovery reports a conflict',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first]);const operation=repo.prepare([first,next])
 const path=document(root);writeFileSync(path,readFileSync(path,'utf8')+'\nConcurrent user note\n')
 const changed=readFileSync(path,'utf8')
 assert.throws(()=>new MarkdownRepository(root).recover(operation),/CONFLICT/)
 assert.equal(readFileSync(path,'utf8'),changed)
})

test('symlink roots and Markdown paths are rejected without touching their targets',t=>{
 const base=fixture(t);const outside=join(base,'outside');mkdirSync(outside);const link=join(base,'link');symlinkSync(outside,link)
 assert.throws(()=>new MarkdownRepository(link).open([]),/UNSAFE_PATH/)
 const root=join(base,'repository');const repo=new MarkdownRepository(root);repo.open([first]);const path=document(root)
 const target=join(outside,'keep');writeFileSync(target,'untouched');rmSync(path);symlinkSync(target,path)
 assert.throws(()=>repo.read(),/UNSAFE_PATH/);assert.equal(readFileSync(target,'utf8'),'untouched')
})

test('Git write failure leaves a recoverable batch and never claims a commit',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first]);const lock=join(root,'.git','HEAD.lock');writeFileSync(lock,'external lock')
 assert.throws(()=>repo.publish([first,next]),/GIT/)
 assert.equal(git(root,'rev-list','--count','HEAD'),'1');rmSync(lock)
 const recovered=new MarkdownRepository(root);recovered.recover(recovered.pendingOperationId()!);assert.deepEqual(recovered.open([]).revisions,[first,next])
 assert.equal(git(root,'rev-list','--count','HEAD'),'2')
})

test('the read baseline fences edits that arrive during admission',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);const baseline=repo.open([first]).baselines
 const path=document(root);const original=readFileSync(path,'utf8');writeFileSync(path,original.replace(/Prefer concise replies\n$/,'Another correction\n'))
 const changed=readFileSync(path,'utf8');repo.read()
 assert.throws(()=>repo.prepare([first,next],'stale-baseline',baseline),/CONFLICT/)
 assert.equal(readFileSync(path,'utf8'),changed)
 assert.equal(repo.pendingOperationId(),null)
})

test('partially published multi-file batches recover only their own staging files',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first]);const second={...first,entry_id:'personal:test:two',content:{text:'Synthetic goal'}}
 const operation=repo.prepare([first,next,second])
 const journal=JSON.parse(readFileSync(join(root,'.nova-memory-batch.json'),'utf8')) as {files:{path:string;after:string}[]}
 const one=journal.files.find(file=>file.path.endsWith('.md'))!
 writeFileSync(join(root,one.path),one.after)
 writeFileSync(join(root,'unrelated-note.txt'),'Keep my note')
 assert.throws(()=>new MarkdownRepository(root).open([]),/PENDING_OPERATION/)
 const reopened=new MarkdownRepository(root);reopened.recover(operation)
 assert.equal(reopened.read().revisions.length,3)
 assert.equal(readFileSync(join(root,'unrelated-note.txt'),'utf8'),'Keep my note')
 assert.ok(!git(root,'ls-tree','-r','--name-only','HEAD').includes('unrelated-note'))
 assert.ok(!git(root,'ls-tree','-r','--name-only','HEAD').includes('batch'))
})

test('deleted documents and rewritten machine history cannot silently rebuild the index',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first]);const path=document(root);const original=readFileSync(path,'utf8')
 writeFileSync(path,original.replace('Prefer concise replies','Forged earlier revision'))
 assert.throws(()=>repo.read(),/HISTORY_EDIT/)
 writeFileSync(path,original);rmSync(path)
 assert.throws(()=>repo.read(),/CONFLICT/)
})

test('repository locks reject simultaneous workers and release on operation failure',t=>{
 const root=fixture(t);const firstRepo=new MarkdownRepository(root);const other=new MarkdownRepository(root)
 firstRepo.withLock(()=>{
  assert.throws(()=>other.withLock(()=>other.open([])),/BUSY/)
  firstRepo.open([first])
 })
 assert.throws(()=>firstRepo.withLock(()=>{throw Error('synthetic failure')}),/synthetic failure/)
 assert.equal(other.withLock(()=>other.read()).revisions.length,1)
})

test('repository locks recover confirmed dead owners without stealing a live lock',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.initialize()
 const deadPid=Number(execFileSync(process.execPath,['-p','process.pid'],{encoding:'utf8'}))
 const lock=join(root,'.nova-memory.lock');writeFileSync(lock,JSON.stringify({pid:deadPid,token:'dead-test-owner'}))
 assert.equal(repo.withLock(()=>repo.open([first])).revisions.length,1)
 writeFileSync(lock,JSON.stringify({pid:process.pid,token:'live-test-owner'}))
 assert.throws(()=>repo.withLock(()=>undefined),/BUSY/)
 assert.equal((JSON.parse(readFileSync(lock,'utf8')) as {token:string}).token,'live-test-owner')
})

test('a waiting repository takes the lock once a live owner releases it, and still reports BUSY after its budget',t=>{
 const root=fixture(t);new MarkdownRepository(root).initialize()
 const lock=join(root,'.nova-memory.lock')
 const holder=spawn(process.execPath,['-e',`const fs=require('fs');fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:process.pid,token:'other-process'}));setTimeout(()=>{fs.unlinkSync(${JSON.stringify(lock)});process.exit(0)},500)`],{stdio:'ignore'})
 t.after(()=>{holder.kill()})
 const sleep=(ms:number)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)
 for(let waited=0;!existsSync(lock);waited+=10){assert.ok(waited<5000,'holder never took the lock');sleep(10)}
 const waiting=new MarkdownRepository(root,{lockWaitMs:5000})
 const started=Date.now()
 assert.equal(waiting.withLock(()=>waiting.open([first])).revisions.length,1)
 assert.ok(Date.now()-started>=100,'it waited for the owner instead of failing at once')
 writeFileSync(lock,JSON.stringify({pid:process.pid,token:'live-test-owner'}))
 const impatient=new MarkdownRepository(root,{lockWaitMs:150})
 const before=Date.now()
 assert.throws(()=>impatient.withLock(()=>undefined),/BUSY/)
 assert.ok(Date.now()-before>=150,'BUSY only after the wait budget is spent')
})

test('only a host-admitted exact file edit can authorize normalized correction content',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first]);const path=document(root)
 writeFileSync(path,readFileSync(path,'utf8').replace(/Prefer concise replies\n$/,'Prefer detailed replies\n'))
 const snapshot=repo.read();const normalized={...next,content:{text:'Prefer detailed replies',normalized:true}}
 assert.throws(()=>repo.prepare([first,normalized]),/UNADMITTED_EDIT/)
 assert.throws(()=>repo.prepare([first,normalized],'wrong-edit',snapshot.baselines,[{...snapshot.edits[0]!,hash:'0'.repeat(64)}]),/UNADMITTED_EDIT/)
 const operation=repo.prepare([first,normalized],'admitted-edit',snapshot.baselines,snapshot.edits)
 repo.publishPrepared(operation);repo.finalize(operation)
 assert.deepEqual(repo.read().revisions,[first,normalized])
})

test('raw evidence records are rejected before any Git publication',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first])
 assert.throws(()=>repo.publish([{...first,raw_text:'Synthetic raw transcript never belongs in Git'} as EntryRevision]))
 assert.equal(git(root,'rev-list','--count','HEAD'),'1')
 assert.ok(!git(root,'show','HEAD:'+git(root,'ls-tree','-r','--name-only','HEAD').split('\n').find(path=>path.endsWith('.md'))!).includes('Synthetic raw transcript'))
})


test('an entries directory swapped for a symlink after open cannot redirect publication',t=>{
 const base=fixture(t);const root=join(base,'repository');const repo=new MarkdownRepository(root);repo.open([first])
 const outside=join(base,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep'),'untouched')
 renameSync(join(root,'entries'),join(root,'entries-original'));symlinkSync(outside,join(root,'entries'))
 assert.throws(()=>repo.publish([first,next]),/UNSAFE_PATH/)
 assert.deepEqual(readdirSync(outside),['keep'])
 assert.equal(readFileSync(join(outside,'keep'),'utf8'),'untouched')
})


test('a crash after atomic journal linking still recovers its owned staging link',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first]);const operation=repo.prepare([first,next])
 const staging=join(root,`.nova-batch-${operation}.tmp`);linkSync(join(root,'.nova-memory-batch.json'),staging)
 const recovered=new MarkdownRepository(root);assert.equal(recovered.pendingOperationId(),operation);recovered.recover(operation)
 assert.deepEqual(recovered.read().revisions,[first,next])
 assert.ok(!readdirSync(root).includes(`.nova-batch-${operation}.tmp`))
})


test('a Git common-directory redirect cannot mutate another repository',t=>{
 const base=fixture(t);const root=join(base,'repository'),other=join(base,'other')
 const repo=new MarkdownRepository(root);repo.open([first]);new MarkdownRepository(other).open([first]);const previous=git(other,'rev-parse','HEAD')
 writeFileSync(join(root,'.git','commondir'),join(other,'.git'))
 assert.throws(()=>repo.publish([first,next]),/UNSAFE_PATH/)
 assert.equal(git(other,'rev-parse','HEAD'),previous)
})

test('recovery refuses an outbox with the same operation ID but a different target snapshot',t=>{
 const root=fixture(t);const repo=new MarkdownRepository(root);repo.open([first]);const operation=repo.prepare([first,next])
 const file=document(root),before=readFileSync(file,'utf8')
 assert.throws(()=>repo.recover(operation,[first,{...next,content:{text:'A different committed intent'}}]),/CONFLICT/)
 assert.equal(readFileSync(file,'utf8'),before)
 assert.equal(repo.pendingOperationId(),operation)
 repo.recover(operation,[first,next]);assert.deepEqual(repo.read().revisions,[first,next])
})
