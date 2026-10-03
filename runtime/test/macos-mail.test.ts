import * as module from '../src/connectors/macos/mail.js'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
test('local mail identity separates accounts and read flags do not supersede content',()=>{
 const mail={account:'account-a',mailbox:'Inbox',id:'12',messageId:'same@example.test',subject:'Review',sender:'a@example.test',recipients:['b@example.test'],received:'2026-09-20T00:00:00.000Z',sent:'2026-09-19T23:00:00.000Z',content:'Please review',read:false,flagged:false}
 const a=module.normalizeMacMailMessage(mail),read=module.normalizeMacMailMessage({...mail,read:true})
 assert.equal(a.key,read.key);assert.equal(a.semanticHash,read.semanticHash);assert.equal(read.metadata.read,true)
 assert.notEqual(a.key,module.normalizeMacMailMessage({...mail,account:'account-b'}).key)
 assert.notEqual(a.semanticHash,module.normalizeMacMailMessage({...mail,content:'Changed'}).semanticHash)
 assert.equal(a.retentionUntil,'2027-03-19T00:00:00.000Z')
 assert.equal(module.macMailScopeSchema.safeParse({kind:'macos_mail',mailboxes:['box'],pastDays:181}).success,false)
 const client=new module.MacMailClient('/missing-fixture')
 assert.throws(()=>client.request({command:'send'}))
})

test('local mail incomplete scans retain current evidence and persist continuation',async()=>{
 const {MacMailClient}=await import('../src/connectors/macos/mail.js')
 const {ComposioConnector}=await import('../src/connectors/composio/index.js')
 const {SubstrateMemoryResource}=await import('../src/memory-substrate/resource.js')
 const {MemoryLedgerClient}=await import('../src/memory-ledger/store-client.js')
 const root=await mkdtemp(join(tmpdir(),'nova-local-mail-'));let incomplete=false,capped=false
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',model:'fixture',gateway:{async *stream(){await Promise.resolve();throw Error('unexpected model call')},complete(){throw Error('unexpected model call')}}})
 const mail=new MacMailClient('/fixture')
 mail.request=(input:unknown)=>{
  const request=input as {command:string}
  if(request.command==='status')return Promise.resolve({status:'granted'})
  return Promise.resolve({status:'granted',messages:incomplete||capped?[]:[{account:'a',mailbox:'box',id:'1',messageId:'test@example.test',subject:'Task',sender:'sender',recipients:[],received:new Date(Date.now()-60000).toISOString(),sent:new Date(Date.now()-60000).toISOString(),content:'Read only',read:false,flagged:false}],complete:!incomplete,capped,cursor:incomplete?{box:0,offset:100,fingerprints:['200:1:200']}:null})
 }
 const manager=new ComposioConnector({memory:()=>memory,client:null,mail,automatic:false,onChange:()=>{ /* inspected below */ }})
 try{
  await memory.open();await manager.open();const {id}=await manager.command('connector.mail_connect') as {id:string}
  await assert.rejects(manager.command('connector.configure',{id,scope:{kind:'gmail',labels:['INBOX'],pastDays:30},processingConsent:false}),/scope_denied/)
  await manager.command('connector.configure',{id,scope:{kind:'macos_mail',mailboxes:['box'],pastDays:30},processingConsent:false})
  await manager.syncOnce(id);await manager.syncOnce(id)
  incomplete=true;await manager.syncOnce(id)
  const row=await memory.options.client.memory('source_connection',{action:'get',id}) as {continuation:{providerCursor:{offset:number}}}
  assert.equal(row.continuation.providerCursor.offset,100)
  const objects=await memory.options.client.memory('source_pending',{id}) as {objects:{status:string}[]}
  assert.equal(objects.objects.length,1);assert.equal(objects.objects[0]?.status,'current')
  incomplete=false;capped=true;await manager.syncOnce(id)
  await Promise.all([manager.open(),manager.command('connector.status')])
  assert.equal(manager.snapshot().connections.length,1,'overlapping refreshes must not duplicate connection rows')
  assert.equal(manager.snapshot().connections[0]?.scan_limited,true)
  const retained=await memory.options.client.memory('source_pending',{id}) as typeof objects
  assert.equal(retained.objects[0]?.status,'current')
  await manager.command('connector.pause',{id});assert.equal(manager.snapshot().connections[0]?.state,'paused')
  await manager.command('connector.disconnect',{id});assert.equal(manager.snapshot().connections[0]?.state,'disconnected')
 }finally{await manager.close();await memory.close();await rm(root,{recursive:true,force:true})}
})
