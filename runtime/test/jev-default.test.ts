/* eslint-disable @typescript-eslint/require-await */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildAssembly} from '../src/composition/assembly.js'
import type {ModelGateway,CompleteRequest} from '../src/model/model-gateway.js'
import {settingsSchema} from '../src/config/config.js'
import {decide} from '../src/model/jev-client.js'
import {createJevNewsRanker} from '../src/news/jev-ranking.js'
test('default news uses Jev and never silently substitutes the chat provider',async()=>{
 assert.equal(settingsSchema.parse({executors:[]}).openrouter_api_key,null)
 const calls:CompleteRequest[]=[]
 const gateway={complete:(request:CompleteRequest)=>{calls.push(request);return Promise.resolve({text:JSON.stringify({candidates:[{quote:'记下想法',occurrence:0,kind:'idea',text:'记下想法'}]})})}} as unknown as ModelGateway
 const core=buildAssembly({settings:settingsSchema.parse({executors:[],support_model:'support-test'}),gateway,cameraModuleEnabled:false,blackboard:{path:':memory:',ownerId:'test'}})
 const models=core.personalAgentConfig!.models
 await assert.rejects(models.rankNews([],[],new AbortController().signal),/jev_not_configured/)
 assert.equal(calls.length,0,'news never calls the chat model')
 await assert.rejects(models.understand({id:'source',version:1,text:'记下想法',origin:'user'},new AbortController().signal),/jev_not_configured/)
 assert.equal(calls[0]!.model,'support-test','understanding extracts with the shared LLM before Jev judgment')
})
test('typed transport rejects incomplete probability distributions',async()=>{
 const q={one:{type:'choice' as const,instructions:'test',criteria:{yes:'yes',no:'no'}}}
 await assert.rejects(decide({apiKey:'test',fetcher:async()=>Response.json({answers:{one:{type:'choice',choice:'yes',confidence:1,probabilities:{yes:1}}}})}, {},q,new AbortController().signal),/invalid_decision/)
})
test('news batches interest and substance judgments with original quote evidence',async()=>{
 const article={id:'a',source_id:'bbc',title:'New voice model',summary:'A voice model can run offline.',url:'https://www.bbc.com/a',published_at:null,first_seen:new Date().toISOString(),content_hash:'h'}
 let requests=0
 const rank=createJevNewsRanker({apiKey:'test',fetcher:async(_url,init)=>{
  requests++;const request=JSON.parse(init!.body as string) as {questions:Record<string,{criteria:Record<string,string>}>}
  return Response.json({answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>{const choice=id.endsWith('substance')?'concrete':'relevant';return [id,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}]}))})
 }})
 const rows=await rank([{id:'voice',text:'语音模型',weight:1}],[article],new AbortController().signal)
 assert.equal(requests,1);assert.equal(rows[0]!.matches[0]!.quote,article.title);assert.equal(rows[0]!.judgment!.provider,'jev')
 assert.equal(rows[0]!.judgment!.probabilities.concrete,1)
})
