import assert from 'node:assert/strict'
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {TaskService} from '../src/personal-agent/tasks.js'

test('public events replay durably with stage dedup and monotonic cursor',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-events-')),path=join(dir,'tasks.json'),tasks=new TaskService(path)
 try{await tasks.open();const task=await tasks.delegate('r',{conversation_id:'c',goal:'Fix login',acceptance:[],origin_ref:'user:1'})
  assert.equal(typeof tasks.appendEvent,'function')
  const event={task_id:task.id,kind:'message' as const,sender:'executor' as const,text:'Checking login',refs:[]}
  const first=await tasks.appendEvent(event,'thread:1/turn:1/item:1/started')
  assert.equal((await tasks.appendEvent(event,'thread:1/turn:1/item:1/started')).seq,first.seq)
  assert.deepEqual(tasks.events(task.id,first.seq).items,[])
  const second=await tasks.appendEvent({...event,text:'Login checked'},'thread:1/turn:1/item:1/completed')
  assert.ok(second.seq>first.seq)
  await tasks.close();const restored=new TaskService(path);await restored.open()
  assert.deepEqual(restored.events(task.id,first.seq).items,[second]);await restored.close()
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('display retention is byte bounded while refs and input receipts survive',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-events-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{await tasks.open();const task=await tasks.delegate('r',{conversation_id:'c',goal:'Fix',acceptance:[],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  assert.equal(typeof tasks.appendEvent,'function')
  await tasks.bindWork(fence,'work','session')
  await tasks.input('input',fence,{kind:'nova'},'session','Preserve me',()=>Promise.resolve('unknown'))
  for(let n=0;n<120;n++)await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session',kind:'message',sender:'executor',text:'界'.repeat(18000),refs:n===0?['artifact:original']:[]},'source:'+n)
  const page=tasks.events(task.id,0)
  assert.equal(page.truncated,true);assert.ok(page.items.length<=100)
  assert.ok(page.items.filter(item=>item.kind==='message').every(item=>item.text.length<=16000&&item.text_truncated))
  assert.ok(tasks.get(task.id).artifact_refs.includes('artifact:original'))
  assert.equal(tasks.inputReceipts(task.id)[0]?.status,'unknown')
  await assert.rejects(tasks.appendEvent({task_id:task.id,work_id:'wrong',kind:'status',text:'Wrong',refs:[]},'wrong'),/work_not_found/)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('control history and direct input attribution persist without implying task completion',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-events-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{await tasks.open();const task=await tasks.delegate('r',{conversation_id:'c',goal:'Fix',acceptance:[],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session');await tasks.controlClient('take',fence,'client','takeover')
  const controlled={...fence,control_revision:1}
  await tasks.input('direct',controlled,{kind:'user',client_id:'client'},'session','Please check errors',()=>Promise.resolve('accepted'))
  await tasks.input('direct',controlled,{kind:'user',client_id:'client'},'session','Please check errors',()=>Promise.reject(Error('must not resend')))
  const events=tasks.events(task.id,0).items
  assert.ok(events.some(event=>event.kind==='control'))
  assert.equal(events.filter(event=>event.sender==='user-to-executor'&&event.text==='Please check errors').length,1)
  assert.equal(tasks.get(task.id).phase,'running')
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
test('host-owned retained approval is replayed for the exact original task',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-approval-')),host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const task=await host.tasks.delegate('r',{conversation_id:'chat:main',conversation_generation:0,goal:'Fix',acceptance:[],origin_ref:'user:1'})
  await host.tasks.bindWork({task_id:task.id,control_revision:0,goal_revision:0},'work','session')
  assert.equal(typeof host.recordTaskApproval,'function')
  host.recordTaskApproval('chat:main',0,{pending_approval:true,pending_approval_busy:false,pending_approval_id:'approval',kind:'command_execution',local_detail:null,operation_summary:'Run check',expires_at:null,work:{work_id:'work',project:'Project',title:'Fix'},queued:0,held:true})
  const response=await host.command({type:'personal.command',request_id:'get',method:'tasks.get',params:{task_id:task.id}},{client_id:'client'}) as {data:{approvals:{pending_approval_id:string}[];capabilities:{detail:string}}}
  assert.equal(response.data.approvals[0]?.pending_approval_id,'approval')
  assert.equal(response.data.capabilities.detail,'summary-only')
  assert.equal(host.snapshot().pending_approvals[0]?.approval_id,'approval')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('task page reads remain fresh and do not copy replay pages into command receipts',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-pages-')),host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const task=await host.tasks.delegate('r',{conversation_id:'chat:main',goal:'Fix',acceptance:[],origin_ref:'user:1'})
  const request={type:'personal.command' as const,request_id:'get-page',method:'tasks.get',params:{task_id:task.id}}
  let notifications=0;const unsubscribe=host.subscribe(()=>notifications++);await host.command(request,{client_id:'client'});unsubscribe();assert.equal(notifications,0,'detail reads do not create a snapshot/read feedback loop')
  await host.tasks.appendEvent({task_id:task.id,kind:'message',sender:'nova',text:'Fresh summary',refs:[]},'summary:1')
  const response=await host.command(request,{client_id:'client'}) as {data:{events:{items:{text:string}[]}}}
  assert.equal(response.data.events.items[0]?.text,'Fresh summary')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})


test('receipt growth prunes display bytes before the bounded store fills',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-capacity-')),path=join(dir,'tasks.json'),tasks=new TaskService(path)
 let restored:TaskService|undefined
 try{await tasks.open();const task=await tasks.delegate('r',{conversation_id:'c',goal:'Fix',acceptance:[],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session')
  for(let n=0;n<50;n++)await tasks.appendEvent({task_id:task.id,kind:'message',sender:'executor',text:'x'.repeat(16000),refs:[]},'display:'+n)
  await tasks.close()
  const state=JSON.parse(await readFile(path,'utf8')) as {effects:Record<string,{hash:string;status:string;text:string}>}
  const count=Math.floor((16*1024*1024-Buffer.byteLength(JSON.stringify(state))-65536)/16100)
  for(let n=0;n<count;n++)state.effects['protected:'+n]={hash:'hash',status:'unknown',text:'q'.repeat(16000)}
  await writeFile(path,JSON.stringify(state));restored=new TaskService(path);await restored.open()
  for(let n=0;n<10;n++)await restored.input('input:'+n,fence,{kind:'nova'},'session','y'.repeat(16000),()=>Promise.resolve('unknown'))
  assert.equal(restored.events(task.id,0).truncated,true)
  assert.equal(restored.inputReceipts(task.id).length,10)
  const saved=JSON.parse(await readFile(path,'utf8')) as typeof state
  assert.equal(Object.keys(saved.effects).length,count+10)
 }finally{await restored?.close();await tasks.close();await rm(dir,{recursive:true,force:true})}
})

import {BoundedJsonStore} from '../src/storage/bounded-json.js'
test('incomplete replay survives publication of an already in-flight state clone',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-incomplete-race-')),path=join(dir,'tasks.json'),tasks=new TaskService(path)
 // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below and invoked with an explicit store receiver via call.
 const write=BoundedJsonStore.prototype.write
 let release!:()=>void,entered!:()=>void
 const writing=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 try{await tasks.open();const task=await tasks.delegate('r',{conversation_id:'c',goal:'Fix',acceptance:[],origin_ref:'user:1'})
  assert.equal(typeof tasks.markReplayIncomplete,'function')
  BoundedJsonStore.prototype.write=async function(state:unknown){if(this.path===path){entered();await gate}await write.call(this,state)}
  const pending=tasks.appendEvent({task_id:task.id,kind:'status',text:'In flight',refs:[]},'first')
  await writing;tasks.markReplayIncomplete(task.id);release();await pending
  assert.equal(tasks.events(task.id,0).incomplete,true)
  await tasks.appendEvent({task_id:task.id,kind:'status',text:'Next',refs:[]},'second')
  const restored=new TaskService(path);await restored.open();assert.equal(restored.events(task.id,0).incomplete,true);await restored.close()
 }finally{release();BoundedJsonStore.prototype.write=write;await tasks.close();await rm(dir,{recursive:true,force:true})}
})
