import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {FEISHU_SCOPES,FeishuConnector} from '../src/connectors/feishu/index.js'
import type {ProcessingGrant} from '../src/memory-substrate/source-state.js'

async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'nova-feishu-scope-'))
 let account='ou_first',authorized=true
 const calls:{ids:string[];grant:ProcessingGrant}[]=[],grants=new Map<string,ProcessingGrant>()
 const connector=new FeishuConnector({executable:'unused',credentialRoot:directory,statePath:join(directory,'state.json'),
  ingest:()=>Promise.resolve(),deleteSource:()=>Promise.resolve(),onAction:()=>Promise.resolve(),
  processingGrant:(allowed,revision,scope_revision)=>({revision,scope_revision,extraction_provider:allowed?'model':null,embedding_provider:null,conversation_providers:allowed?['conversation']:[]}),
  onProcessingConsent:(ids,grant)=>{calls.push({ids:[...ids],grant});for(const id of ids)if((grants.get(id)?.revision??0)<grant.revision)grants.set(id,grant);return Promise.resolve()},
  run:args=>{
   if(args[0]==='--version')return Promise.resolve('1.0.69')
   if(args[1]==='status')return Promise.resolve(JSON.stringify({appId:'cli_fixture',verified:authorized,identities:{user:{openId:account,status:authorized?'authenticated':'expired',scopes:FEISHU_SCOPES}}}))
   if(args[1]==='+chat-list')return Promise.resolve(JSON.stringify({items:[{chat_id:'oc_a'},{chat_id:'oc_b'}],has_more:false}))
   if(args[1]==='+chat-messages-list')return Promise.resolve(JSON.stringify({items:[],has_more:false}))
   return Promise.resolve('{}')
  }})
 await connector.open();await connector.listChats()
 const select=async(chats:string[])=>{await connector.configure(chats,true);await connector.sync();await connector.setProcessingConsent(true)}
 return {connector,calls,grants,select,switchAccount(){account='ou_second'},expire(){authorized=false},async close(){await connector.close();await rm(directory,{recursive:true,force:true})}}
}

test('re-consent grants only selected chats while revocation includes retained removed sources',async()=>{
 const f=await fixture();try{
  await f.select(['oc_a','oc_b'])
  const original=f.calls.at(-1)!.ids;assert.equal(original.length,2)
  const removed=original.find(id=>id.endsWith(':oc_a'))!,kept=original.find(id=>id.endsWith(':oc_b'))!
  await f.select(['oc_b'])
  assert.deepEqual(f.calls.at(-1)!.ids,[kept])
  assert.equal(f.grants.get(removed)?.extraction_provider,null)
  assert.equal(f.grants.get(kept)?.extraction_provider,'model')
  await f.connector.setProcessingConsent(false)
  assert.deepEqual(new Set(f.calls.at(-1)!.ids),new Set(original))
  await f.connector.setProcessingConsent(true)
  assert.deepEqual(f.calls.at(-1)!.ids,[kept]);assert.equal(f.grants.get(removed)?.extraction_provider,null)
 }finally{await f.close()}
})

test('switching accounts never restores old evidence even after consent revisions exceed old grants',async()=>{
 const f=await fixture();try{
  await f.select(['oc_a']);const old=f.calls.at(-1)!.ids[0]!
  f.switchAccount();await f.connector.status()
  assert.equal(f.grants.get(old)?.extraction_provider,null)
  await f.connector.listChats();await f.select(['oc_a']);const current=f.calls.at(-1)!.ids[0]!
  assert.notEqual(current,old)
  for(let n=0;n<8;n++){
   await f.connector.setProcessingConsent(false);assert.ok(f.calls.at(-1)!.ids.includes(old),'revocations retain old account coverage')
   await f.connector.setProcessingConsent(true);assert.deepEqual(f.calls.at(-1)!.ids,[current])
   assert.equal(f.grants.get(old)?.extraction_provider,null);assert.equal(f.grants.get(current)?.extraction_provider,'model')
  }
 }finally{await f.close()}
})

test('authorization loss revokes processing for every retained source before reporting unauthorized',async()=>{
 const f=await fixture();try{
  await f.select(['oc_a','oc_b']);const original=f.calls.at(-1)!.ids
  await f.select(['oc_b']);f.expire();await f.connector.status()
  assert.equal(f.connector.snapshot().state,'unauthorized')
  assert.deepEqual(new Set(f.calls.at(-1)!.ids),new Set(original))
  assert.equal(f.calls.at(-1)!.grant.extraction_provider,null)
  for(const id of original)assert.equal(f.grants.get(id)?.extraction_provider,null)
 }finally{await f.close()}
})
