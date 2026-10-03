import assert from 'node:assert/strict'
import {test} from 'node:test'
import {intakeModels} from '../src/executors/coding/intake-model.js'
import {GatewayTargetResolver} from '../src/executors/coding/target-resolution.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

const input = {intake_id:'target-test',revision:1,opening:'切到 blog',roster:[{name:'blog',running:[]}],running:[]}
const missing = {state:'missing',note:''}
const requirements = {intake_id:input.intake_id,revision:input.revision,execution_mode:'direct',
 slots:{goal:missing,scope:missing,acceptance:missing,constraints:missing},readiness:0,
 intent_to_proceed:true,candidate_question:null,discovery:[],early_exit:false,abandon:false}
const selected = {intake_id:input.intake_id,revision:input.revision,kind:'switch',project:'blog',
 project_evidence:'blog',project_confirmation:null,session:{mode:'new'},question:null}

test('target resolution can be replaced independently of requirement assessment and planning',async()=>{
 let selections=0
 const calls:string[]=[]
 const gateway={stream:()=>{throw Error('unused stream')},complete:({model}:{model:string})=>{calls.push(model);return Promise.resolve({text:JSON.stringify(requirements)})}} as ModelGateway
 const targets={resolveIntake:()=>{selections++;return Promise.resolve(selected)},resolveWork:()=>Promise.resolve(null)}
 const models=intakeModels(gateway,'support','planner',targets)
 const result=await models.assess(input,new AbortController().signal) as Record<string,unknown>
 assert.equal(selections,1,'the target resolver owns workspace/session selection')
 assert.equal(result.kind,'switch')
 assert.equal(result.project,'blog')
 assert.deepEqual(calls,['support'],'selecting a target does not invoke a planner or a second requirement assessor')
})

function gatewayReply(value: unknown): ModelGateway {
 return {stream:()=>{throw Error('unused stream')},complete:()=>Promise.resolve({text:JSON.stringify(value)})}
}

test('target questions preserve repository discovery and both calls share one original snapshot',async()=>{
 const original=structuredClone(input)
 let observed:Readonly<Record<string,unknown>>|undefined
 const model=intakeModels({stream:()=>{throw Error('unused')},complete:()=>{
  original.roster[0]!.name='changed while awaiting requirements'
  return Promise.resolve({text:JSON.stringify({...requirements,candidate_question:{owner:'repo',text:'Find the test command'}})})
 }},'support','planner',{
  resolveIntake:state=>{observed=state;return Promise.resolve({...selected,kind:'unclear',question:'Which workspace?'})},
  resolveWork:()=>Promise.resolve(null),
 })
 const result=await model.assess(original,new AbortController().signal) as Record<string,unknown>
 assert.deepEqual(observed?.roster,input.roster)
 assert.deepEqual(observed?.requirements,{...requirements,candidate_question:{owner:'repo',text:'Find the test command'}})
 assert.deepEqual(result.candidate_question,{owner:'user',text:'Which workspace?'})
 assert.deepEqual(result.discovery,['Find the test command'])
})

test('abandoned or stale requirements never invoke target resolution; stale target binding is never rewritten',async()=>{
 for(const patch of [{abandon:true},{revision:2},{intake_id:'other'}]){
  let calls=0
  const model=intakeModels(gatewayReply({...requirements,...patch}),'support','planner',{
   resolveIntake:()=>{calls++;return Promise.resolve(selected)},resolveWork:()=>Promise.resolve(null),
  })
  const result=await model.assess(input,new AbortController().signal) as Record<string,unknown>
  assert.equal(calls,0)
  assert.equal(result.project,null)
  for(const [key,value] of Object.entries(patch))assert.equal(result[key],value)
 }
 const model=intakeModels(gatewayReply(requirements),'support','planner',{
  resolveIntake:()=>Promise.resolve({...selected,revision:2}),resolveWork:()=>Promise.resolve(null),
 })
 assert.equal((await model.assess(input,new AbortController().signal) as Record<string,unknown>).revision,2)
})

test('malformed or failed target resolution never falls back to an active workspace',async()=>{
 for(const response of [{}, {...selected,kind:'cancel'}, {...selected,session:{mode:'named'}}, {...selected,kind:'steer'}]){
  const model=intakeModels(gatewayReply(requirements),'support','planner',{
   resolveIntake:()=>Promise.resolve(response),resolveWork:()=>Promise.resolve(null),
  })
  await assert.rejects(model.assess(input,new AbortController().signal))
 }
 const failure=new Error('target unavailable')
 const model=intakeModels(gatewayReply(requirements),'support','planner',{
  resolveIntake:()=>Promise.reject(failure),resolveWork:()=>Promise.resolve(null),
 })
 await assert.rejects(model.assess(input,new AbortController().signal),error=>error===failure)
})

test('requirements cannot supply target fields and cancellation between stages prevents selection',async()=>{
 let calls=0
 const targets={resolveIntake:()=>{calls++;return Promise.resolve(selected)},resolveWork:()=>Promise.resolve(null)}
 await assert.rejects(intakeModels(gatewayReply({...requirements,project:'invented'}),'support','planner',targets).assess(input,new AbortController().signal))
 assert.equal(calls,0)
 const abort=new AbortController()
 const model=intakeModels({stream:()=>{throw Error('unused')},complete:()=>{
  abort.abort();return Promise.resolve({text:JSON.stringify(requirements)})
 }},'support','planner',targets)
 await assert.rejects(model.assess(input,abort.signal),{name:'AbortError'})
 assert.equal(calls,0)
 const late=new AbortController()
 const delayed=intakeModels(gatewayReply(requirements),'support','planner',{
  resolveIntake:()=>{late.abort();return Promise.resolve(selected)},resolveWork:()=>Promise.resolve(null),
 })
 await assert.rejects(delayed.assess(input,late.signal),{name:'AbortError'})
})


test('running-work resolution preserves closed-set validation and the caller abort signal',async()=>{
 const running=[{work_id:'one',project:'blog',title:'Fix login'},{work_id:'two',project:'store',title:'Tests'}]
 for(const id of ['one','two','invented',null]){
  const resolver=new GatewayTargetResolver(gatewayReply({target_work_id:id}),'support')
  assert.equal(await resolver.resolveWork('the tests',running,new AbortController().signal),id==='invented'?null:id)
 }
 const abort=new AbortController();abort.abort()
 await assert.rejects(new GatewayTargetResolver(gatewayReply({target_work_id:'one'}),'support').resolveWork('stop',running,abort.signal),{name:'AbortError'})
})
