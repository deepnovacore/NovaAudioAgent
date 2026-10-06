import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {admitIntakeTask} from '../src/personal-agent/intake-task.js'
import {TaskService} from '../src/personal-agent/tasks.js'

const input={intake_id:'i1',conversation_id:'chat:main',conversation_generation:0,goal:'Repair',acceptance:['Check passes'],origin_ref:'conversation:1',route:'codex'}

async function service(){
 const root=await mkdtemp(join(await realpath(tmpdir()),'intake-task-')),tasks=new TaskService(join(root,'tasks.json'));await tasks.open()
 return {tasks,close:async()=>{await tasks.close();await rm(root,{recursive:true,force:true})}}
}

test('an intake task superseded during persistence is cancelled and never admitted',async()=>{
 const {tasks,close}=await service();let current=true,admitted=0
 try{
  const setRoute=tasks.setRoute.bind(tasks);tasks.setRoute=async(...args)=>{const task=await setRoute(...args);current=false;return task}
  assert.equal(await admitIntakeTask(tasks,input,()=>current,()=>{admitted++;return Promise.resolve({accepted:true})}),'superseded')
  assert.equal(admitted,0);assert.equal(tasks.list()[0]?.phase,'cancelled','recovery must not run a superseded task')
 }finally{await close()}
})

test('an intake task is cancelled when the runtime does not admit it or admission throws',async()=>{
 for(const admit of [()=>Promise.resolve({accepted:false,problem:'closed'}),()=>Promise.reject(Error('runtime_closed'))]){
  const {tasks,close}=await service()
  try{await admitIntakeTask(tasks,input,()=>true,admit).catch(()=>undefined);assert.equal(tasks.list()[0]?.phase,'cancelled')}
  finally{await close()}
 }
})

test('an accepted intake keeps its task, and an existing task is never cancelled by a superseded intake',async()=>{
 const {tasks,close}=await service()
 try{
  await admitIntakeTask(tasks,input,()=>true,grant=>{assert.equal(tasks.get(grant.fence.task_id).execution_route,'codex');return Promise.resolve({accepted:true})})
  const task=tasks.list()[0]!;assert.notEqual(task.phase,'cancelled')
  const fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
  assert.equal(await admitIntakeTask(tasks,{...input,intake_id:'i2',task_fence:fence},()=>false,()=>Promise.resolve({accepted:true})),'superseded')
  assert.equal(tasks.list().length,1);assert.notEqual(tasks.get(task.id).phase,'cancelled')
 }finally{await close()}
})
