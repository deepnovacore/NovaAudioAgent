import test from 'node:test'
import assert from 'node:assert/strict'
import {taskNextStep} from '../src/renderer/tasks-page.mjs'
test('cards say who acts next',()=>{
 assert.match(taskNextStep({phase:'waiting',waiting_reason:'correction_limit',controller:{kind:'nova'}}),/^需要你：自动修正次数已用完/)
 assert.equal(taskNextStep({phase:'running',controller:{kind:'nova'}}),'Nova 在推进')
 assert.equal(taskNextStep({phase:'running',controller:{kind:'user',client_id:'a'}}),'你在控制')
 assert.equal(taskNextStep({phase:'completed',controller:{kind:'nova'}}),'无需操作')
})
