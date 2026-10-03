import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'

test('Life dates and state survive recall; completed objects cannot enter or retain reminders',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-life-discovery-'))
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'ledger.sqlite')),userId:'synthetic',model:'synthetic',inputConsent:true,conversationProviders:['synthetic'],gateway:{async *stream(){await Promise.resolve();throw Error('unexpected model')},complete(){return Promise.reject(Error('unexpected model'))}},consolidation:{enabled:false}})
 const host=new PersonalAgentHost({path:join(root,'host.json'),userScope:'synthetic',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await memory.open();await host.open()
  const todo=await host.life.mutate({op:'create',kind:'todo',title:'Synthetic orchid report',due:'2026-10-01'},'create')
  const current=()=>memory.list().then(page=>page.entries.find(row=>row.content==='Synthetic orchid report')!)
  const entry=await current();assert.equal(entry.kind,'todo')
  const snapshot=await host.discoverySnapshot(),projected=snapshot.memory.find(row=>row.id===entry.id)!
  assert.equal((projected as unknown as {life:{due:string}}).life.due,'2026-10-01')
  const retrieval=new UnifiedRetrieval({memory:()=>memory})
  const recalled=await retrieval.recall('orchid',{consumer:'synthetic'})
  assert.equal(recalled.entries[0]?.kind,'todo')
  assert.equal((recalled.entries[0]?.life as {status:string}).status,'open')
  assert.equal((recalled.entries[0]?.life as {due_precision:string}).due_precision,'date')
  assert.equal((recalled.entries[0]?.life as {due_time:null}).due_time,null)
  const evidenceId=recalled.entries[0].evidence_refs[0]!
  assert.ok(evidenceId.startsWith(memory.prefix+'life:e:'))
  assert.equal((await retrieval.evidence(evidenceId,{consumer:'synthetic'})).state,'ok')
  assert.ok(recalled.snippets.some(snippet=>snippet.evidence_id===evidenceId),'canonical Life evidence is readable by the authorized chat consumer')
  assert.equal((await retrieval.evidence(evidenceId,{consumer:'unapproved'})).state,'gone')
  assert.equal(await memory.readEvidence(evidenceId.replace(memory.prefix,'personal:another-user:')),null)
  const proposal={kind:'question',summary:'Review the report?',why_now:'Synthetic due item',evidence_refs:[],memory_refs:[{entry_id:entry.id,version:entry.version}]}
  assert.equal(await host.admit(proposal,snapshot),'admitted')
  await host.life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:1,status:'done'},'complete')
  await host.sourceChanged()
  assert.equal(host.snapshot().feed[0]?.lifecycle,'invalidated')
  assert.equal((await host.discoverySnapshot()).memory.some(row=>row.id===entry.id),false)
  const done=await current()
  assert.equal(await host.admit({...proposal,memory_refs:[{entry_id:entry.id,version:done.version}]},{...snapshot,memory:[done]}),'rejected')
  assert.equal((await retrieval.recall('orchid',{consumer:'synthetic'})).entries[0]?.life instanceof Object,true,'completed objects remain readable as history')
 }finally{await host.close();await memory.close();await rm(root,{recursive:true,force:true})}
})
