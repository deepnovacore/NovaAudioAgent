import test from 'node:test'
import assert from 'node:assert/strict'
import {memoryOverview} from '../src/renderer/memory-overview.mjs'
const entries=[
 {id:'voice',version:1,status:'active',topic:'Nova',content:'Nova 支持语音对话和任务执行。',source_refs:[{type:'file',ref:'/Nova/README.md'}]},
 {id:'bench',version:'v2',status:'active',content:'JuggleBench 用可重复的手机操作任务评估智能体。',source_refs:[{type:'file',ref:'/JuggleBench/README.md'}]},
]
const overview={summary:'两个项目分别负责智能体交互和能力评估。',sections:[{title:'智能体开发',summary:'Nova 提供交互入口，JuggleBench 提供评估任务；资料尚未说明二者是否直接集成。',keywords:['语音对话','任务评估'],refs:[{entry_id:'voice',version:1},{entry_id:'bench',version:'v2'}]}]}
test('host synthesis connects multiple grounded records and retains references',()=>{
 const result=memoryOverview(entries,overview)
 assert.equal(result.generated,true);assert.equal(result.summary,overview.summary)
 assert.deepEqual(result.groups[0].entries,entries)
 assert.deepEqual(result.groups[0].keywords,['语音对话','任务评估'])
})
test('missing or stale references discard synthesis after correction, deletion and pagination',()=>{
 for(const items of [[entries[0]],entries.map(entry=>({...entry,version:3})),entries.map(entry=>({...entry,status:'forgotten'}))]){
  const result=memoryOverview(items,overview)
  assert.equal(result.generated,false);assert.equal(result.groups.length,0)
  assert.notEqual(result.summary,overview.summary)
 }
})
test('fallback displays actual content including records without topics, never inferred identity or counts as summary',()=>{
 const result=memoryOverview(entries)
 assert.equal(result.summary,'已记录的资料可在下方逐条查看。')
 assert.doesNotMatch(result.summary,/个主题|研究员|投资者/)
 assert.equal(memoryOverview([]).summary,'暂无记忆。')
 assert.equal(memoryOverview([{...entries[0],content:'a'.repeat(300)}]).summary,'已记录的资料可在下方逐条查看。')
})
test('invalid overview structure falls back without crashing',()=>{
 for(const value of [{...overview,sections:[null]},{...overview,sections:[{...overview.sections[0],refs:[null]}]},{...overview,sections:[{...overview.sections[0],keywords:['a'.repeat(81)]}]}])assert.equal(memoryOverview(entries,value).generated,false)
})
