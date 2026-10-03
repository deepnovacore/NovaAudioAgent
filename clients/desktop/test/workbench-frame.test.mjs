import test from 'node:test'
import assert from 'node:assert/strict'
import {createWorkbenchFrame} from '../src/main/workbench-frame.mjs'

function setup(initial={x:100,y:80,width:800,height:600}){
 const state={bounds:initial}
 const frame=createWorkbenchFrame({
  getBounds:()=>({...state.bounds}),
  setBounds:bounds=>{state.bounds={...bounds}},
  getWorkArea:()=>({x:0,y:25,width:1440,height:875}),
 })
 return {state,frame}
}

test('toggling maximizes to the work area and restores the exact previous bounds', () => {
 const {state,frame}=setup()
 assert.equal(frame.toggleMaximize(),true)
 assert.deepEqual(state.bounds,{x:0,y:25,width:1440,height:875})
 assert.equal(frame.maximized,true)
 assert.equal(frame.toggleMaximize(),false)
 assert.deepEqual(state.bounds,{x:100,y:80,width:800,height:600})
 assert.equal(frame.maximized,false)
})

test('natural bounds are the pre-maximize rectangle while maximized', () => {
 const {frame}=setup()
 frame.toggleMaximize()
 assert.deepEqual(frame.naturalBounds(),{x:100,y:80,width:800,height:600})
})

test('a manual resize after maximizing makes the next toggle maximize again', () => {
 const {state,frame}=setup()
 frame.toggleMaximize()
 state.bounds={x:10,y:40,width:900,height:700}
 assert.equal(frame.maximized,false)
 assert.deepEqual(frame.naturalBounds(),{x:10,y:40,width:900,height:700})
 assert.equal(frame.toggleMaximize(),true)
 assert.equal(frame.toggleMaximize(),false)
 assert.deepEqual(state.bounds,{x:10,y:40,width:900,height:700})
})

test('a maximized window the OS re-fits to a changed work area is still maximized and restores', () => {
 const state={bounds:{x:100,y:80,width:800,height:600},area:{x:0,y:25,width:1440,height:875}}
 const frame=createWorkbenchFrame({getBounds:()=>({...state.bounds}),setBounds:b=>{state.bounds={...b}},getWorkArea:()=>({...state.area})})
 frame.toggleMaximize()
 state.area={x:0,y:25,width:1920,height:1055};state.bounds={...state.area}
 assert.equal(frame.maximized,true)
 assert.deepEqual(frame.naturalBounds(),{x:100,y:80,width:800,height:600})
 assert.equal(frame.toggleMaximize(),false)
 assert.deepEqual(state.bounds,{x:100,y:80,width:800,height:600})
})

test('forget drops the restore rectangle', () => {
 const {frame}=setup()
 frame.toggleMaximize();frame.forget()
 assert.equal(frame.maximized,false)
})
