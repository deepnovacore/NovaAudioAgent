import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {LifeService,lifeStateSchema,emptyLifeState} from '../src/personal-agent/life.js'
import type {LifeBackend} from '../src/personal-agent/life.js'

test('configured Life backend receives legacy state once and never rewrites the legacy JSON',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-life-backend-')),path=join(dir,'life.json')
 try{
  const old=new LifeService(path);await old.open();await old.mutate({op:'profile',expected_version:0,about:'用户手改的完整自由文本\n没有逐句来源'},'legacy-profile');await old.close()
  const before=await readFile(path,'utf8');let loads=0,mutations=0
  const state=lifeStateSchema.parse(JSON.parse(before))
  const backend:LifeBackend={load:(legacy,options)=>{loads++;assert.equal(options?.legacyPath,path);assert.deepEqual(legacy,state);return Promise.resolve({state,revision:4})},mutate:q=>{mutations++;assert.equal(q.expectedRevision,4);assert.equal(q.requestId,'new-profile');return Promise.resolve({state:{...state,profile:{about:'更新内容',version:2}},revision:5,result:{id:'profile',version:2}})}}
  const life=new LifeService(path,()=>undefined,backend)
  await life.open();assert.equal(loads,1)
  await life.mutate({op:'profile',expected_version:1,about:'更新内容'},'new-profile')
  assert.equal(mutations,1);assert.equal(life.snapshot().profile.about,'更新内容');assert.equal(await readFile(path,'utf8'),before)
  await life.close()
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('backend failure never falls back to a JSON write',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-life-backend-failure-')),path=join(dir,'life.json')
 try{
  const old=new LifeService(path);await old.open();await old.mutate({op:'profile',expected_version:0,about:'保留'},'old');await old.close()
  const before=await readFile(path,'utf8'),state=lifeStateSchema.parse(JSON.parse(before))
  const backend:LifeBackend={load:()=>Promise.resolve({state,revision:1}),mutate:()=>Promise.reject(Error('backend_offline'))}
  const life=new LifeService(path,()=>undefined,backend);await life.open()
  await assert.rejects(life.mutate({op:'profile',expected_version:1,about:'不得本地回退'},'new'),/backend_offline/)
  assert.equal(await readFile(path,'utf8'),before);assert.equal(life.snapshot().profile.about,'保留');await life.close()
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('completed cutover no longer depends on the retained legacy file being readable JSON',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-life-backend-cutover-')),path=join(dir,'life.json')
 try{
  await writeFile(path,'not valid JSON')
  const state={todos:[],ideas:[],goals:[],profile:{about:'权威快照',version:3},receipts:{}}
  const backend:LifeBackend={peek:()=>Promise.resolve({state,revision:8}),load:()=>Promise.reject(Error('legacy_must_not_load')),mutate:()=>Promise.reject(Error('unused'))}
  const life=new LifeService(path,()=>undefined,backend);await life.open()
  assert.equal(life.snapshot().profile.about,'权威快照');assert.equal(await readFile(path,'utf8'),'not valid JSON');await life.close()
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('Life resolves a backend factory at open and never falls back after selecting the authority',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-life-lazy-')),path=join(dir,'life.json')
 try{
  let selected:LifeBackend|undefined
  const life=new LifeService(path,()=>undefined,()=>selected)
  const state={todos:[],ideas:[],goals:[],profile:{about:'稍后可用的底座',version:1},receipts:{}}
  selected={peek:()=>Promise.resolve({state,revision:1}),load:()=>Promise.resolve({state,revision:1}),mutate:()=>Promise.reject(Error('unused'))}
  await life.open();assert.equal(life.snapshot().profile.about,'稍后可用的底座');await life.close()
  selected=undefined;await assert.rejects(life.open(),/life_backend_unavailable/)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('Life refresh updates the synchronous UI snapshot after an external correction',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-life-refresh-')),path=join(dir,'life.json')
 try{
  let about='旧快照',version=1
  const snapshot=()=>({state:{todos:[],ideas:[],goals:[],profile:{about,version},receipts:{}},revision:version})
  const backend:LifeBackend={peek:()=>Promise.resolve(snapshot()),load:()=>Promise.resolve(snapshot()),mutate:()=>Promise.reject(Error('unused'))}
  const life=new LifeService(path,()=>undefined,backend);await life.open();about='文件手改';version=2
  await life.refresh()
  assert.deepEqual(life.snapshot().profile,{about:'文件手改',version:2});await life.close()
 }finally{await rm(dir,{recursive:true,force:true})}
})

import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {TaskService} from '../src/personal-agent/tasks.js'
import {TaskLoop} from '../src/personal-agent/task-loop.js'
test('task Todo projection reconciles a committed backend update after its acknowledgement is lost',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-life-ack-')),client=new MemoryLedgerClient(join(dir,'memory.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'task-life',gateway:{complete:()=>Promise.reject(Error('unused')),async *stream(){await Promise.reject(Error('unused'))}},model:'fixture',extractionFingerprint:'fixture',inputConsent:true})
 const tasks=new TaskService(join(dir,'tasks.json'));let mutations=0,checks=0
 await resource.open();const backend=resource.lifeBackend(),mutate=backend.mutate.bind(backend)
 const life=new LifeService(join(dir,'life.json'),()=>undefined,{...backend,mutate:async request=>{const result=await mutate(request);if(request.requestId.startsWith('task-complete:')){mutations++;if(mutations===1)throw Error('lost acknowledgement')}return result}})
 try{await life.open();await tasks.open();const todo=await life.mutate({op:'create',kind:'todo',title:'Keep title',note:'Keep note'},'create'),task=await tasks.delegate('task',{conversation_id:'c',goal:'deliver',acceptance:[],origin_ref:'conversation:1',todo_ref:todo})
 await tasks.recordDelivery({task_id:task.id,control_revision:0,goal_revision:0},'reply','answer')
 const loop=new TaskLoop(tasks,{evaluate:()=>{checks++;return Promise.resolve({kind:'complete',evidence_refs:['task-delivery:reply']})},execute:()=>Promise.reject(Error('must not execute again')),syncTodo:task=>life.completeTaskTodo(task)})
 try{await loop.wake(task.id);assert.equal(tasks.get(task.id).todo_sync,'pending');assert.equal((await backend.peek!())!.state.todos[0]!.status,'done');await loop.wake(task.id);assert.equal(tasks.get(task.id).todo_sync,'synced');assert.equal(checks,1);assert.equal(mutations,1);assert.equal(life.snapshot().todos[0]!.version,2);assert.equal(life.snapshot().todos[0]!.note,'Keep note')}finally{await loop.close()}
 }finally{await life.close();await tasks.close();await resource.close();await rm(dir,{recursive:true,force:true})}
})


test('absent legacy JSON supplies no migration path and read errors never become empty migrations',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-life-absent-')),path=join(dir,'life.json')
 let loads=0
 const backend:LifeBackend={load:(legacy,options)=>{loads++;assert.deepEqual(legacy,emptyLifeState());assert.equal(options?.legacyPath,undefined);return Promise.resolve({state:legacy,revision:0})},mutate:()=>Promise.reject(Error('unused'))}
 try{
  const life=new LifeService(path,()=>undefined,backend);await life.open();await life.close();assert.equal(loads,1)
  await assert.rejects(readFile(path),{code:'ENOENT'})
  await writeFile(path,'invalid JSON');await assert.rejects(life.open(),SyntaxError);assert.equal(loads,1)
  const directory=new LifeService(dir,()=>undefined,backend);await assert.rejects(directory.open());assert.equal(loads,1)
 }finally{await rm(dir,{recursive:true,force:true})}
})
