import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {SuggestionPool} from '../src/core/suggestions.js'

test('presentation and personal state writes survive reopening on the host filesystem',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-presentation-storage-'))
 const create=()=>new PersonalAgentHost({path:join(dir,'host.json'),userScope:'local',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let host=create()
 const request={type:'personal.command' as const,method:'presentation.set',request_id:'startup',params:{mode:'workbench'}}
 try{
  await host.open()
  const result=await host.command(request,{client_id:'desktop'}) as {ok:boolean}
  assert.equal(result.ok,true,JSON.stringify(result))
  assert.equal(host.presentationMode,'workbench')
  await host.close();host=create();await host.open()
  assert.deepEqual(await host.command(request,{client_id:'desktop'}),result)
  const store=new PersonalStore(join(dir,'personal.json')),state=initialState()
  state.revision=1;await store.write(state)
  assert.deepEqual(await new PersonalStore(store.path).read(),state)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
