import test from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {buildTextRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js'
import {loadSettings} from '../src/config/config.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'

test('production text host materializes the shared source ledger for configured local memory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-connector-production-'))
 const settings=loadSettings({MEMORY_LEDGER_PATH:join(root,'memory.sqlite'),MEMORY_PATH:join(root,'legacy.sqlite'),PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'fixture',MODEL_API_KEY:'fixture',MEMORY_CONNECTION:'local'},true)
 const capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:false},search:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}},{})
 const runtime=buildTextRealtimeAssembly({settings,capabilities})
 try{assert(runtime.personalMemory instanceof SubstrateMemoryResource)}finally{await runtime.stop();await rm(root,{recursive:true,force:true})}
})


test('explicit mem0 retains its inspection surface without VoiceMem ledger migration', async () => {
 const root=await mkdtemp(join(tmpdir(),'nova-mem0-production-'))
 const settings=loadSettings({MEMORY_LEDGER_PATH:join(root,'memory.sqlite'),MEMORY_PATH:join(root,'legacy.sqlite'),MEMORY_PROVIDER:'mem0',PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'fixture',MODEL_API_KEY:'fixture',MEMORY_CONNECTION:'local'},true)
 const capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:false},search:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}},{})
 const runtime=buildTextRealtimeAssembly({settings,capabilities})
 try{assert(!(runtime.personalMemory instanceof SubstrateMemoryResource));assert.equal(typeof runtime.personalMemory?.inspect,'function')}finally{await runtime.stop();await rm(root,{recursive:true,force:true})}
})
