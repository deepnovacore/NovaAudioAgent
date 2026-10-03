import assert from 'node:assert/strict'
import {chmod,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {test} from 'node:test'
import {SuggestionPool} from '../src/core/suggestions.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {TaskService} from '../src/personal-agent/tasks.js'

const input={conversation_id:'c',goal:'Fix login',acceptance:['regression passes'],origin_ref:'user:1'}
const temporaryPath=async()=>join(await mkdtemp(join(await realpath(tmpdir()),'nova-tasks-')),'tasks.json')

test('delegation is idempotent and persists across restart',async()=>{
 const path=await temporaryPath()
 const tasks=new TaskService(path)
 try{
  await tasks.open()
  const task=await tasks.delegate('request:1',input)
  assert.equal((await tasks.delegate('request:1',input)).id,task.id)
  await assert.rejects(tasks.delegate('request:1',{...input,goal:'Different'}),/request_conflict/)
  await tasks.close()
  const restored=new TaskService(path)
  try{await restored.open();assert.equal(restored.get(task.id).goal,'Fix login')}finally{await restored.close()}
 }finally{await tasks.close();await rm(dirname(path),{recursive:true,force:true})}
})

test('control and goal changes reject stale or unauthorized fences',async()=>{
 const path=await temporaryPath(),tasks=new TaskService(path)
 try{await tasks.open();const task=await tasks.delegate('request:1',input),fence={task_id:task.id,control_revision:0,goal_revision:0}
  const controlled=await tasks.control('control:1',fence,{kind:'nova'},{kind:'user',client_id:'workbench'})
  assert.equal(controlled.control_revision,1)
  await assert.rejects(tasks.control('control:2',fence,{kind:'nova'},{kind:'user',client_id:'other'}),/stale_task/)
  await assert.rejects(tasks.reviseGoal('goal:bad',{...fence,control_revision:1},{kind:'nova'},'Wrong',[]),/not_controller/)
  const unchanged=await tasks.reviseGoal('goal:unchanged',{...fence,control_revision:1},{kind:'user',client_id:'workbench'},input.goal,input.acceptance)
  assert.equal(unchanged.goal_revision,0)
  const revised=await tasks.reviseGoal('goal:1',{...fence,control_revision:1},{kind:'user',client_id:'workbench'},'Fix login safely',['regression passes','audit passes'])
  assert.equal(revised.goal_revision,1);assert.equal(revised.goal,'Fix login safely')
  await assert.rejects(tasks.reviseGoal('goal:2',{...fence,control_revision:1},{kind:'user',client_id:'workbench'},'Stale',[]),/stale_task/)
 }finally{await tasks.close();await rm(dirname(path),{recursive:true,force:true})}
})

test('control retries ignore equivalent fence and actor key order',async()=>{
 const path=await temporaryPath(),tasks=new TaskService(path)
 try{await tasks.open();const task=await tasks.delegate('request:1',input)
  await tasks.control('takeover:1',{task_id:task.id,control_revision:0,goal_revision:0},{kind:'nova'},{kind:'user',client_id:'workbench'})
  const returned=await tasks.control('return:1',{task_id:task.id,control_revision:1,goal_revision:0},{kind:'user',client_id:'workbench'},{kind:'nova'})
  const retried=await tasks.control('return:1',{goal_revision:0,task_id:task.id,control_revision:1},{client_id:'workbench',kind:'user'},{kind:'nova'})
  assert.equal(retried.control_revision,returned.control_revision)
 }finally{await tasks.close();await rm(dirname(path),{recursive:true,force:true})}
})

test('open rejects persisted blank waiting reasons',async()=>{
 const path=await temporaryPath(),tasks=new TaskService(path)
 try{await tasks.open();await tasks.delegate('request:1',input);await tasks.close()
  const persisted=JSON.parse(await readFile(path,'utf8')) as {tasks:{waiting_reason:string|null}[]}
  persisted.tasks[0]!.waiting_reason='   ';await writeFile(path,JSON.stringify(persisted))
  await assert.rejects(new TaskService(path).open())
 }finally{await tasks.close();await rm(dirname(path),{recursive:true,force:true})}
})

test('an active executor session cannot be rebound to another task',async()=>{
 const path=await temporaryPath(),tasks=new TaskService(path)
 try{await tasks.open();const first=await tasks.delegate('request:1',input),second=await tasks.delegate('request:2',{...input,goal:'Fix signup'})
  await tasks.bindWork({task_id:first.id,control_revision:0,goal_revision:0},'work:1','session:1')
  await assert.rejects(tasks.bindWork({task_id:second.id,control_revision:0,goal_revision:0},'work:2','session:1'),/session_active/)
  assert.deepEqual(tasks.get(first.id).session_ids,['session:1']);assert.deepEqual(tasks.get(second.id).session_ids,[])
 }finally{await tasks.close();await rm(dirname(path),{recursive:true,force:true})}
})

test('a failed disk write does not publish staged task state',async()=>{
 const path=await temporaryPath(),tasks=new TaskService(path),dir=dirname(path)
 try{await tasks.open();const first=await tasks.delegate('request:1',input);await chmod(dir,0o500)
  try{await assert.rejects(tasks.delegate('request:2',{...input,goal:'Must not publish'}))}finally{await chmod(dir,0o700)}
  assert.deepEqual(tasks.list().map(task=>task.id),[first.id])
  await tasks.close();const restored=new TaskService(path);try{await restored.open();assert.deepEqual(restored.list().map(task=>task.id),[first.id])}finally{await restored.close()}
 }finally{await chmod(dir,0o700).catch(()=>undefined);await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('personal host opens, snapshots, and closes its task service',async()=>{
 const path=await temporaryPath(),personalPath=path.replace(/tasks\.json$/u,'personal.json')
 const make=()=>new PersonalAgentHost({path:personalPath,userScope:'local',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let host=make()
 try{await host.open();const task=await host.tasks.delegate('request:1',input);assert.equal(host.snapshot().tasks[0]?.id,task.id);await host.close();host=make();await host.open();assert.equal(host.snapshot().tasks[0]?.id,task.id);await host.close()}
 finally{await host.close();await rm(dirname(path),{recursive:true,force:true})}
})
