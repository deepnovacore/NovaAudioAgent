import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings,renamedEnvironmentWarnings} from '../src/config/config.js'

test('SUPPORT_MODEL selects the shared auxiliary LLM and preserves raw values',()=>{
 for(const value of ['custom-support','','  ']){
  const settings=loadSettings({SUPPORT_MODEL:value})
  assert.equal(settings.support_model,value)
 }
})
test('removed SURROGATE_MODEL cannot override the support model or its default',()=>{
 const explicit=loadSettings({SUPPORT_MODEL:'new-model',SURROGATE_MODEL:'old-model'})
 assert.equal(explicit.support_model,'new-model')
 const legacy=loadSettings({SURROGATE_MODEL:'old-model'})
 assert.equal(legacy.support_model,'qwen-plus')
})
test('a leftover SURROGATE_MODEL produces one rename warning, even when empty',()=>{
 for(const value of ['old-model',''])
  assert.deepEqual(renamedEnvironmentWarnings({SURROGATE_MODEL:value,SUPPORT_MODEL:'new-model'}),
   ['[config-warning] SURROGATE_MODEL is no longer read; rename it to SUPPORT_MODEL'])
 assert.deepEqual(renamedEnvironmentWarnings({SUPPORT_MODEL:'new-model'}),[])
})
