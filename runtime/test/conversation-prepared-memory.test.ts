import assert from 'node:assert/strict'
import test from 'node:test'
import {maySendPreparedMemory} from '../src/personal-agent/conversation-runtime.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'

test('prepared topic requires every evidence grant for the actual recipient and fails closed without provenance',async()=>{
 const checked:string[]=[]
 const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.reject(Error('unused')),canReadConversationEvidence:(id,consumer)=>{checked.push(id+':'+consumer);return Promise.resolve(id==='allowed'&&consumer==='text-model')}}
 assert.equal(await maySendPreparedMemory(memory,'text-model',['allowed']),true)
 assert.equal(await maySendPreparedMemory(memory,'voice-model',['allowed']),false)
 assert.equal(await maySendPreparedMemory(memory,'text-model',['allowed','purged']),false)
 assert.equal(await maySendPreparedMemory(memory,'text-model',[]),false)
 assert.equal(await maySendPreparedMemory(memory,undefined,['allowed']),false)
 assert.equal(await maySendPreparedMemory(undefined,'text-model',['allowed']),false)
 assert.ok(checked.includes('purged:text-model'))
})
