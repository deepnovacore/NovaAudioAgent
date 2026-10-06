import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {PersonalStore,initialState,acquirePersonalLock,type PersonalState} from '../src/personal-agent/store.js';
import {createConversation} from '../src/personal-agent/conversations.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js';
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}};
async function fixture(){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-restore-')),path=join(dir,'personal.json');
 const state=initialState();state.user_scope='fixture';state.revision=12;
 state.settings={discovery_enabled:false,discovery_interval_minutes:90,timezone:'Asia/Shanghai'};
 state.conversations.items.push(createConversation('chat','Project discussion',null,'project-chat'));
 state.conversations.selected_id='project-chat';
 for(const item of state.conversations.items)item.messages.push({id:item.id+'-message',conversation_id:item.id,role:'user',text:'Preserved '+item.id,created_at:'2026-09-20T00:00:00Z'});
 state.conversations.items[2]!.coding_target={workspace_id:'workspace',session_id:'session',project:'Fixture project',title:'Fixture session',executor:'codex'};
 state.conversations.work_owners.work='project-chat';state.conversations.approval_owners.approval='project-chat';
 state.feed=[{id:'saved-feed',kind:'notify',title:'Saved reminder',why_now:'Retain history',evidence_refs:['fixture-evidence'],memory_refs:[],source:{type:'file',ref:'fixture-evidence'},subject_key:'fixture',task_ref:null,suggestion_id:null,priority:40,created_at:'2026-09-20T00:00:00Z',updated_at:'2026-09-20T00:00:00Z',expires_at:null,user_state:'dismissed',snooze_until:null,lifecycle:'active',delivery:{presented_at:null,notified_at:null,spoken_at:null}}];
 state.dedupe=['saved-dedupe'];state.receipts.saved={payload:'saved-payload',result:{ok:true}};
 const store=new PersonalStore(path);await store.write(state);
 const make=()=>new PersonalAgentHost({path,userScope:'fixture',memory:()=>undefined,pool:new SuggestionPool(),evidence:ref=>ref==='fixture-evidence'?{subject_key:'fixture',source:{type:'file',ref}}:null});
 const preserved=(actual:PersonalState)=>{assert.deepEqual({...actual,revision:0},{...state,revision:0})};
 return {dir,path,state,store,make,preserved,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

test('source notifications before restore preserve conversations, bindings, feed and settings over three restarts',async()=>{
 const f=await fixture();
 try{for(let restart=0;restart<3;restart++){
  const host=f.make();try{
   await host.sourceChanged({revision:restart+1,phase:'invalidated'});await host.sourceChanged({revision:restart+1,phase:'ready'});await host.sourceChanged();
   f.preserved(await f.store.read());await host.open();f.preserved(await f.store.read());
  }finally{await host.close()}
  f.preserved(await f.store.read());
 }}finally{await f.cleanup()}
});

test('notifications during disk read stay pending until restored state is available',async t=>{
 const f=await fixture(),host=f.make(),entered=deferred(),resume=deferred();const read=Reflect.get(PersonalStore.prototype,'read');
 const mock=t.mock.method(PersonalStore.prototype,'read',async function(this:PersonalStore){if(this.path===f.path){entered.resolve();await resume.promise}return read.call(this)});
 const opening=host.open();
 try{await entered.promise;await host.sourceChanged({revision:1,phase:'ready'});f.preserved(JSON.parse(await readFile(f.path,'utf8')) as PersonalState);resume.resolve();await opening;assert.ok((await read.call(f.store)).revision>12);f.preserved(await read.call(f.store))}
 finally{resume.resolve();await opening.catch(()=>undefined);mock.mock.restore();await host.close();await f.cleanup()}
});

test('direct persistence before open and after close cannot bypass ownership and restoration',async()=>{
 const f=await fixture(),host=f.make();
 try{await assert.rejects(host.taskResult('unexpected','Must not persist'),/personal_store_not_ready/);f.preserved(await f.store.read());await host.open();await host.close();await assert.rejects(host.taskResult('unexpected','Must not persist'),/personal_store_not_ready/);f.preserved(await f.store.read())}
 finally{await host.close();await f.cleanup()}
});

test('failed read never replaces the damaged file and releases ownership',async()=>{
 const f=await fixture(),host=f.make();await writeFile(f.path,'{invalid-json');
 try{await host.sourceChanged();await assert.rejects(host.open(),SyntaxError);await host.sourceChanged({revision:1,phase:'ready'});assert.equal(await readFile(f.path,'utf8'),'{invalid-json');const release=await acquirePersonalLock(f.path);await release()}
 finally{await host.close();await f.cleanup()}
});

test('failed ownership acquisition cannot write through pending source notifications',async()=>{
 const f=await fixture(),host=f.make(),release=await acquirePersonalLock(f.path);
 try{await host.sourceChanged();await assert.rejects(host.open(),/personal_store_locked/);await host.sourceChanged({revision:1,phase:'ready'});f.preserved(await f.store.read())}
 finally{await release();await host.close();await f.cleanup()}
});

test('close drains an in-flight source refresh and write before releasing ownership',async t=>{
 const f=await fixture(),host=f.make(),refreshEntered=deferred(),refreshResume=deferred(),writeEntered=deferred(),writeResume=deferred();await host.open();
 const refresh=host.refreshMemory.bind(host),write=Reflect.get(PersonalStore.prototype,'write');let refreshes=0,closingDone=false;
 host.refreshMemory=async()=>{refreshes++;refreshEntered.resolve();await refreshResume.promise;await refresh()};
 const mock=t.mock.method(PersonalStore.prototype,'write',async function(this:PersonalStore,state:PersonalState){if(this.path===f.path){writeEntered.resolve();await writeResume.promise}await write.call(this,state)});
 const changing=host.sourceChanged({revision:1,phase:'ready'});await refreshEntered.promise;
 const closing=host.close().then(()=>{closingDone=true});
 try{
  const late=host.sourceChanged({revision:2,phase:'ready'});await assert.rejects(acquirePersonalLock(f.path),/personal_store_locked/);assert.equal(closingDone,false);
  refreshResume.resolve();await writeEntered.promise;await assert.rejects(acquirePersonalLock(f.path),/personal_store_locked/);assert.equal(closingDone,false);
  writeResume.resolve();await changing;await late;await closing;assert.equal(refreshes,1);f.preserved(await f.store.read());const release=await acquirePersonalLock(f.path);await release();
 }finally{refreshResume.resolve();writeResume.resolve();await changing.catch(()=>undefined);await closing;mock.mock.restore();await host.close();await f.cleanup()}
});

test('substrate startup callbacks registered before memory open preserve personal state',async()=>{
 const f=await fixture(),host=f.make(),notices:Promise<void>[]=[];
 const resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(f.dir,'memory.sqlite')),userId:'fixture',model:'fixture',gateway:{stream(){throw Error('unexpected model call')},complete(){return Promise.reject(Error('unexpected model call'))}}});
 resource.setOnChange(()=>{notices.push(host.sourceChanged())});resource.setOnSourceChange(change=>host.sourceChanged(change));
 try{await resource.open();await Promise.all(notices);assert.ok(notices.length>0);f.preserved(await f.store.read());await host.open();f.preserved(await f.store.read())}
 finally{await host.close();await resource.close();await f.cleanup()}
});

test('close requested during restoration waits for open before releasing ownership',async t=>{
 const f=await fixture(),host=f.make(),entered=deferred(),resume=deferred();const read=Reflect.get(PersonalStore.prototype,'read');
 const mock=t.mock.method(PersonalStore.prototype,'read',async function(this:PersonalStore){if(this.path===f.path){entered.resolve();await resume.promise}return read.call(this)});
 const opening=host.open();await entered.promise;let closed=false;
 const closing=host.close().then(()=>{closed=true});
 try{
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false);
  await assert.rejects(acquirePersonalLock(f.path),/personal_store_locked/);
  resume.resolve();await opening;await closing;f.preserved(await read.call(f.store));
  await assert.rejects(host.taskResult('after-close','Must not persist'),/personal_store_not_ready/);
  const release=await acquirePersonalLock(f.path);await release();
 }finally{resume.resolve();await opening.catch(()=>undefined);await closing;mock.mock.restore();await host.close();await f.cleanup()}
});

test('source open can await a notification without processing unrestored companion state',async()=>{
 const f=await fixture(),host=f.make();let sourcesOpening=false,refreshes=0;
 const refresh=host.refreshMemory.bind(host);host.refreshMemory=async()=>{assert.equal(sourcesOpening,false);refreshes++;await refresh()};
 host.setSources({list:()=>[],command:()=>Promise.resolve(null),open:async()=>{sourcesOpening=true;await host.sourceChanged({revision:1,phase:'ready'});sourcesOpening=false}});
 try{await host.open();assert.ok(refreshes>=2);f.preserved(await f.store.read())}
 finally{await host.close();await f.cleanup()}
});

test('read and scope errors retain the original bytes and reject subsequent writes',async t=>{
 const f=await fixture(),before=await readFile(f.path,'utf8');
 for(const fail of ['read','scope']){
  const host=fail==='scope'?new PersonalAgentHost({path:f.path,userScope:'wrong-scope',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null}):f.make();
  const mock=fail==='read'?t.mock.method(PersonalStore.prototype,'read',()=>Promise.reject(Error('disk read failed'))):undefined;
  try{await assert.rejects(host.open(),fail==='read'?/disk read failed/:/scope_mismatch/);await host.sourceChanged();await assert.rejects(host.taskResult('after-failure','Must not persist'),/personal_store_not_ready/);assert.equal(await readFile(f.path,'utf8'),before)}
  finally{mock?.mock.restore();await host.close()}
 }
 await f.cleanup();
});

test('failed source drain still closes resources and releases ownership',async()=>{
 const f=await fixture(),host=f.make(),entered=deferred(),resume=deferred();let sourcesClosed=false;
 host.setSources({list:()=>[],command:()=>Promise.resolve(null),close:()=>{sourcesClosed=true;return Promise.resolve()}});await host.open();
 host.refreshMemory=async()=>{entered.resolve();await resume.promise;throw Error('source refresh failed')};
 const changing=assert.rejects(host.sourceChanged({revision:1,phase:'ready'}),/source refresh failed/);await entered.promise;
 const closing=host.close();const outcome=closing.catch(error=>error as unknown);
 try{resume.resolve();await changing;await outcome;assert.equal(sourcesClosed,true);f.preserved(await f.store.read());const release=await acquirePersonalLock(f.path);await release()}
 finally{resume.resolve();await outcome;await host.close();await f.cleanup()}
});

test('a repeated open immediately followed by close remains idempotent',async()=>{
 const f=await fixture(),host=f.make();
 try{await host.open();await Promise.all([host.open(),host.close()]);f.preserved(await f.store.read());const release=await acquirePersonalLock(f.path);await release()}
 finally{await host.close();await f.cleanup()}
});

test('text submitted while closing is rejected before it is persisted or run',async t=>{
 const f=await fixture(),gate=deferred(),entered=deferred();let runs=0;
 const host=f.make();
 t.after(async()=>{gate.resolve();await host.close();await f.cleanup()});
 host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>{runs++;return Promise.resolve({assistant:'reply'})},close:()=>Promise.resolve()}),()=>{/* no renderer */});
 host.setSources({list:()=>[],command:()=>Promise.resolve(null),close:()=>{entered.resolve();return gate.promise}});
 await host.open();
 // Queued behind the lifecycle flip: admission checks passed, the write had not started.
 const queued=host.submitConversationText('chat:main','queued before close','queued');
 const closing=host.close();
 await assert.rejects(queued,/unavailable/u);
 await entered.promise;
 await assert.rejects(host.submitConversationText('chat:main','late message','late'),/unavailable/u);
 gate.resolve();await closing;
 const saved=(await f.store.read()).conversations.items.flatMap(item=>item.messages);
 assert.equal(saved.some(message=>message.request_id==='queued'||message.request_id==='late'),false);
 assert.equal(runs,0);
});
