import test from 'node:test'
import assert from 'node:assert/strict'
import {onButton} from '../src/renderer/button-action.mjs'

test('pending button ignores repeat activation and clears feedback after failure without overriding disabled state',async()=>{
 const attrs={},button={disabled:false,setAttribute:(k,v)=>{attrs[k]=v},addEventListener:(_,fn)=>{button.click=fn}}
 let reject,calls=0,error
 onButton(button,()=>{calls++;return new Promise((_,fail)=>{reject=fail})},caught=>{error=caught})
 const first=button.click();assert.equal(attrs['aria-busy'],'true')
 await button.click();assert.equal(calls,1)
 button.disabled=true;reject(Error('failed'));await first
 assert.equal(error.message,'failed');assert.equal(attrs['aria-busy'],'false');assert.equal(button.disabled,true)
})
