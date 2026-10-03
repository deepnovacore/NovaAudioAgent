import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ModelLane} from '../src/model/model-lane.js'
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
test('background calls run one at a time and wait while foreground work is in flight',async()=>{
 const lane=new ModelLane(),order:string[]=[],fg=deferred(),bg=deferred()
 const foreground=lane.run('foreground',async()=>{order.push('fg');await fg.promise})
 const first=lane.run('background',async()=>{order.push('bg1');await bg.promise})
 const second=lane.run('background',()=>{order.push('bg2');return Promise.resolve()})
 await new Promise(r=>setImmediate(r));assert.deepEqual(order,['fg'])
 fg.resolve();await foreground;await new Promise(r=>setImmediate(r));assert.deepEqual(order,['fg','bg1'])
 const late=lane.run('foreground',()=>{order.push('fg2');return Promise.resolve()});await late
 assert.deepEqual(order,['fg','bg1','fg2'],'foreground never queues behind a running background call')
 bg.resolve();await first;await second;assert.deepEqual(order,['fg','bg1','fg2','bg2'])
})
test('an aborted background call leaves the queue without running',async()=>{
 const lane=new ModelLane(),fg=deferred(),controller=new AbortController();let ran=false
 const foreground=lane.run('foreground',()=>fg.promise)
 const waiting=lane.run('background',()=>{ran=true;return Promise.resolve()},controller.signal)
 controller.abort();await assert.rejects(waiting);fg.resolve();await foreground
 assert.equal(ran,false);assert.deepEqual(lane.snapshot(),{foreground:0,background:0,waiting:0})
})
test('a failing background call releases the lane',async()=>{
 const lane=new ModelLane()
 await assert.rejects(lane.run('background',()=>Promise.reject(Error('provider_down'))))
 assert.equal(await lane.run('background',()=>Promise.resolve(7)),7)
})
