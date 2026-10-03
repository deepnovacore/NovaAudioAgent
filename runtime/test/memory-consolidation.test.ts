import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareConsolidation,generateConsolidation,consolidationCurrent,memoryReadContext,type SummaryContent} from '../src/memory-substrate/consolidation.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

const now=new Date('2026-09-21T04:00:00Z')
const fact=(id='spicy',revision=1,text='我不吃辣'):EntryRevision=>({entry_id:id,revision,supersedes:revision===1?null:revision-1,kind:'preference',op:revision===1?'add':'update',origin:'stated',written_by:'merge',evidence_refs:['e:'+id],entity_refs:[],content:{text},valid_until:null,recorded_at:now.toISOString()})
const content=(basis=[{id:'spicy',revision:1}]):SummaryContent=>({profile_derived:'派生：饮食倾向清淡',one_page:'当前情况：不吃辣',basis,generated_at:now.toISOString(),day:'2026-09-21'})
const summary=(value=content()):EntryRevision=>({...fact('summary'),kind:'memory_summary',origin:'inferred',content:{...value}})
const gateway=(answer:unknown):ModelGateway=>({async *stream(){ /* complete only */ },complete(){return Promise.resolve({text:JSON.stringify(answer)})}})

test('daily plans are timezone scheduled, run once per day, and never use summaries as evidence',()=>{
 const rows=[fact(),summary()]
 assert.equal(prepareConsolidation(rows,summary(),{now}),null)
 assert.equal(prepareConsolidation([fact('spicy',2)],summary(),{now}),null,'a changed basis invalidates reading but does not regenerate again the same day')
 const changed=prepareConsolidation([fact('spicy',2),summary()],summary(),{now:new Date('2026-09-22T04:00:00Z')})
 assert.deepEqual(changed?.basis,[{id:'spicy',revision:2}]);assert.deepEqual(changed?.evidence_refs,['e:spicy'])
 assert.equal(prepareConsolidation([fact()],null,{now:new Date('2026-09-21T00:59:00Z'),timezone:'Asia/Shanghai',hour:9}),null)
 assert.equal(prepareConsolidation([fact()],null,{now:new Date('2026-09-21T01:00:00Z'),timezone:'Asia/Shanghai',hour:9})?.day,'2026-09-21')
 assert.ok(prepareConsolidation([fact()],summary(),{now:new Date('2026-09-22T04:00:00Z')}))
})

test('daily model output preserves explicit facts and accepts only supplied reference versions',async()=>{
 const rows=[fact()],before=JSON.stringify(rows),plan=prepareConsolidation(rows,null,{now})!
 const output={profile_derived:[{text:'倾向清淡饮食',refs:[{id:'spicy',revision:1}]}],one_page:[{text:'饮食：不吃辣',refs:[{id:'spicy',revision:1}]}]}
 const derived=await generateConsolidation(plan,{gateway:gateway(output),model:'fixture'})
 assert.equal(JSON.stringify(rows),before);assert.equal(derived.profile_derived,'倾向清淡饮食 [spicy@1]');assert.equal(derived.one_page,'饮食：不吃辣 [spicy@1]');assert.deepEqual(derived.basis,[{id:'spicy',revision:1}])
 for(const refs of [[{id:'invented',revision:1}],[{id:'spicy',revision:2}],[]])await assert.rejects(generateConsolidation(plan,{gateway:gateway({...output,one_page:[{text:'unsupported',refs}]}),model:'fixture'}))
 await assert.rejects(generateConsolidation(plan,{gateway:gateway({...output,origin:'stated'}),model:'fixture'}))
})

test('a model ignoring abort cannot produce an accepted consolidation',async()=>{
 const controller=new AbortController(),plan=prepareConsolidation([fact()],null,{now})!
 const model:ModelGateway={async *stream(){ /* complete only */ },complete(){controller.abort();return Promise.resolve({text:JSON.stringify({profile_derived:[],one_page:[]})})}}
 await assert.rejects(generateConsolidation(plan,{gateway:model,model:'fixture',signal:controller.signal}),/abort/i)
})

test('changed, deleted, expired or newly admitted facts immediately invalidate the summary and readers fall back',()=>{
 const stored=summary();assert.equal(consolidationCurrent(stored,[fact()],now),true)
 const staleSets=[[fact('spicy',2,'最近可以吃一点辣')],[],[{...fact(),op:'tombstone' as const}],[{...fact(),valid_until:'2026-09-20T00:00:00Z'}],[fact(),fact('coffee',1,'喜欢咖啡')]]
 for(const rows of staleSets){assert.equal(consolidationCurrent(stored,rows,now),false);const text=memoryReadContext(rows,stored,{now,mode:'voice'});assert.ok(!text.includes('派生：饮食倾向清淡'));assert.ok(!text.includes('当前情况：不吃辣'))}
 const fresh=memoryReadContext([fact('spicy',2,'最近可以吃一点辣')],stored,{now,mode:'voice'});assert.ok(fresh.includes('最近可以吃一点辣'));assert.ok(fresh.includes('spicy@2'))
 const valid=memoryReadContext([fact()],stored,{now,mode:'voice'});assert.ok(valid.includes('我不吃辣'));assert.ok(valid.includes('派生：饮食倾向清淡'));assert.ok(valid.includes('当前情况：不吃辣'))
})

test('voice and text contexts remain bounded and distinguish inferred entries from stated facts',()=>{
 const rows=Array.from({length:200},(_,i)=>({...fact('entry-'+i,1,'说明'.repeat(300)),origin:i===0?'inferred' as const:'stated' as const}))
 const plan=prepareConsolidation(rows,null,{now})!;assert.ok(plan.entries.length<=32)
 const voice=memoryReadContext(rows,null,{now,mode:'voice'}),text=memoryReadContext(rows,null,{now,mode:'text'})
 assert.ok(voice.length<=4000);assert.ok(text.length<=6000);assert.ok(text.includes('memory__recall'));assert.ok(text.includes('memory__evidence'))
 const inferred=memoryReadContext([{...fact(),origin:'inferred'}],null,{now,mode:'voice'});assert.ok(inferred.includes('inferred'));assert.ok(!inferred.includes('stated'))
})

test('explicit profile and stated preferences keep priority when the consolidation input exceeds its budget',()=>{
 const profile={...fact('profile',1,'用户明确的完整个人资料'),kind:'profile',origin:'inferred' as const,written_by:'merge' as const,content:{text:'用户明确的完整个人资料',section:'explicit'}}
 const inferred=Array.from({length:80},(_,i)=>({...fact('inferred-'+i),origin:'inferred' as const,recorded_at:'2026-09-22T00:00:00Z'}))
 const plan=prepareConsolidation([...inferred,fact('preference'),profile],null,{now})!
 assert.equal(plan.entries[0]?.entry_id,'profile');assert.equal(plan.entries[1]?.entry_id,'preference');assert.ok(plan.entries.length<=32)
})

test('typed completion and due dates reach both daily synthesis and fallback reading',async()=>{
 const todo={...fact('todo'),kind:'todo',content:{text:'交报告',life_data:{status:'done',due:'2026-09-25'}}}
 let source:{status?:string;due?:string}|undefined
 const model:ModelGateway={async *stream(){ /* complete only */ },complete(request){source=(JSON.parse(request.prompt) as {entries:{status?:string;due?:string}[]}).entries[0];return Promise.resolve({text:JSON.stringify({profile_derived:[],one_page:[{text:'报告已完成',refs:[{id:'todo',revision:1}]}]})})}}
 await generateConsolidation(prepareConsolidation([todo],null,{now})!,{gateway:model,model:'fixture'})
 assert.equal(source?.status,'done');assert.equal(source?.due,'2026-09-25')
 const context=memoryReadContext([todo],null,{now,mode:'voice'});assert.ok(context.includes('done'));assert.ok(context.includes('2026-09-25'))
 const legacy=memoryReadContext([{...fact('legacy'),kind:'profile',origin:'inferred',content:{text:'旧资料',legacy:true}}],null,{now,mode:'voice'});assert.ok(legacy.includes('legacy import'));assert.ok(legacy.includes('inferred'))
})
test('news-derived Life objects retain public source marker without promoting the article excerpt to user facts',async()=>{
 const idea={...fact('idea'),kind:'idea',content:{text:'Compare these products',life_data:{status:'active',news_source:{action:'user_conversion',summary:'PUBLIC CLAIM MUST NOT BE A PERSONAL FACT'}}}}
 let prompt=''
 const model:ModelGateway={async *stream(){ /* complete only */ },complete(request){prompt=request.prompt;return Promise.resolve({text:JSON.stringify({profile_derived:[],one_page:[{text:'Saved a product comparison idea',refs:[{id:'idea',revision:1}]}]})})}}
 await generateConsolidation(prepareConsolidation([idea],null,{now})!,{gateway:model,model:'fixture'})
 assert.equal((JSON.parse(prompt) as {entries:{source_type:string}[]}).entries[0]?.source_type,'user_saved_public_news');assert.ok(!prompt.includes('PUBLIC CLAIM'))
 for(const mode of ['voice','text'] as const){const context=memoryReadContext([idea],null,{now,mode});assert.ok(context.includes('public-news reference, not a personal fact'));assert.ok(!context.includes('PUBLIC CLAIM'))}
})
