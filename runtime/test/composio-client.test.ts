import test from 'node:test'
import assert from 'node:assert/strict'
import {ComposioClient,ComposioFailure,createComposioBudget} from '../src/connectors/composio/client.js'
const binding={toolkit:'gmail' as const,userId:'nova-fixture',accountId:'ca_fixture',authConfigId:'ac_fixture',identity:'fixture@example.test'}
const scope={kind:'gmail' as const,labels:['INBOX'],pastDays:30}
const response=(data:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status}))
test('verification fails closed before content reads on ambiguous route or mismatched profile',async()=>{
 let calls=0
 for(const multiple of [true,false]){
 const client=new ComposioClient('secret',()=>{calls++;return calls%2===1&&multiple?response({items:[]}):calls===1?response({items:[{id:binding.accountId,toolkit:{slug:'gmail'},auth_config:{id:binding.authConfigId}}]}):response({successful:true,data:{emailAddress:'other@example.test'}})})
 calls=0;await assert.rejects(client.verify(binding,scope,createComposioBudget()),ComposioFailure)
 assert.equal(calls,multiple?1:2)
 }
})
test('fixed reads pin version, enforce scope and reject forged verification handles',async()=>{
 const bodies:Record<string,unknown>[]=[]
 const client=new ComposioClient('secret',(url,init)=>{
  assert.equal(typeof url,'string');assert.equal(typeof init?.body==='string'||init?.body===undefined,true)
  assert.equal(init?.redirect,'error');assert((url as string).startsWith('https://backend.composio.dev/api/v3.1/'))
  if(!init?.body)return response({items:[{id:binding.accountId,toolkit:{slug:'gmail'},auth_config:{id:binding.authConfigId}}]})
  const body=JSON.parse(init.body as string) as Record<string,unknown>;bodies.push(body)
  return response({successful:true,data:(url as string).endsWith('GMAIL_GET_PROFILE')?{emailAddress:binding.identity,historyId:'99999999999999999999'}:{messages:[],nextPageToken:''}})
 })
 const budget=createComposioBudget(),verified=await client.verify(binding,scope,budget)
 await client.read(verified,{kind:'gmail.list',after:Math.floor(Date.now()/1000)-100,before:Math.floor(Date.now()/1000)},budget)
 assert.equal(bodies.at(-1)?.version,'20260915_00')
 assert.deepEqual((bodies.at(-1)?.arguments as Record<string,unknown>).label_ids,['INBOX'])
 await assert.rejects(client.read({identity:binding.identity,scope},{kind:'gmail.list',after:Math.floor(Date.now()/1000)-100,before:Math.floor(Date.now()/1000)},budget),/connection_unverified/)
 await assert.rejects(client.read(verified,{kind:'calendar.list',calendarId:'primary',timeMin:'2026-01-01T00:00:00Z',timeMax:'2026-01-02T00:00:00Z'},budget),/scope_denied/)
})
test('errors are sanitized and nested provider statuses survive HTTP200',async()=>{
 const client=new ComposioClient('secret',()=>response({successful:false,data:{status_code:410},error:'secret private body'}))
 await assert.rejects(client.link('ac_fixture','nova-fixture',createComposioBudget()),e=>e instanceof ComposioFailure&&!e.message.includes('secret'))
 const limited=new ComposioClient('secret',()=>Promise.resolve(new Response('secret',{status:429,headers:{'Retry-After':'60'}})))
 await assert.rejects(limited.link('ac_fixture','nova-fixture',createComposioBudget()),e=>e instanceof ComposioFailure&&e.code==='rate_limited'&&e.retryAfter===60)
})
test('budget, hostile redirect and streaming oversized body stop safely',async()=>{
 const budget=createComposioBudget();budget.requests=20
 await assert.rejects(new ComposioClient('secret',()=>assert.fail('called')).link('ac_x','u',budget),/budget_exhausted/)
 await assert.rejects(new ComposioClient('secret',()=>Promise.resolve(new Response('',{status:302}))).link('ac_x','u',createComposioBudget()),/redirect_denied/)
 await assert.rejects(new ComposioClient('secret',()=>Promise.resolve(new Response('x'.repeat(2*1024*1024+1)))).link('ac_x','u',createComposioBudget()),/response_too_large/)
})

test('scope windows cannot be shifted to unrelated history',async()=>{
 const client=new ComposioClient('secret',url=>response((url as string).includes('connected_accounts?')?{items:[{id:binding.accountId,toolkit:{slug:'gmail'},auth_config:{id:binding.authConfigId}}]}:{successful:true,data:{emailAddress:binding.identity}}))
 const budget=createComposioBudget(),verified=await client.verify(binding,scope,budget)
 await assert.rejects(client.read(verified,{kind:'gmail.list',after:100,before:200},budget),/scope_denied/)
})
