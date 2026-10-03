/* eslint-disable @typescript-eslint/require-await */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createJevJudge} from '../src/understanding/jev.js'
import {createUnderstandingPipeline} from '../src/understanding/pipeline.js'
import {understandingFixture} from '../src/understanding/fixture.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
test('Jev sends all independent dimensions in one request and rejects missing answers',async()=>{
 const rows=understandingFixture();let calls=0
 const judge=createJevJudge({apiKey:'synthetic-test',fetcher:async(url,init)=>{calls++;assert.equal(url,'https://openrouter.ai/api/alpha/decisions');const body=JSON.parse(init?.body as string) as {questions:Record<string,unknown>};assert.equal(Object.keys(body.questions).length,15)
  return Response.json({answers:Object.fromEntries(rows.flatMap((r,i)=>Object.entries({...r.decision,capture:'suggested'}).map(([d,v])=>[`c${i}_${d}`,{type:'choice',choice:v,confidence:0.9,probabilities:Object.fromEntries(Object.keys((body.questions[`c${i}_${d}`] as {criteria:Record<string,string>}).criteria).map(k=>[k,k===v?1:0]))}])))})}})
 const result=await judge(rows[0]!.source,rows.map(r=>r.candidate),new AbortController().signal)
 assert.equal(calls,1);assert.equal(result[rows[0]!.candidate.id]!.capture,'suggested');assert.equal(result[rows[0]!.candidate.id]!.probabilities!.support!.supported,1)
 const invalid=createJevJudge({apiKey:'synthetic-test',fetcher:async()=>Response.json({answers:{}})})
 await assert.rejects(invalid(rows[0]!.source,rows.map(r=>r.candidate),new AbortController().signal),/incomplete/)
})
test('pipeline derives verified offsets from exact quote and injectable judgment',async()=>{
 const rows=understandingFixture(),row=rows[0]!
 const gateway={complete:async()=>({text:JSON.stringify({candidates:[{quote:row.candidate.span.quote,occurrence:0,kind:'goal',text:row.candidate.text}]})})} as unknown as ModelGateway
 const pipeline=createUnderstandingPipeline({gateway,model:'synthetic',judge:async(_s,c)=>Object.fromEntries(c.map(x=>[x.id,row.decision]))})
 const result=await pipeline(row.source,new AbortController().signal)
 assert.equal(result[0]!.status,'proposed');assert.equal(result[0]!.candidate.id,row.candidate.id)
})
