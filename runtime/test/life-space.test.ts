import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {LifeService} from '../src/personal-agent/life.js'
test('five-tab objects persist, conversion is idempotent, links and versions are enforced',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-life-'));let life=new LifeService(join(dir,'life.json'))
 await life.open()
 try{
  const idea=await life.mutate({op:'create',kind:'idea',title:'Learn Japanese',note:'For travel'},'one')
  const goal=await life.mutate({op:'convert',id:idea.id,target:'goal',expected_version:idea.version},'two')
  assert.equal((await life.mutate({op:'convert',id:idea.id,target:'goal',expected_version:idea.version},'three')).id,goal.id)
  const todo=await life.mutate({op:'create',kind:'todo',title:'First lesson',goal_id:goal.id},'four')
  assert.equal(life.snapshot().goals[0]!.progress.total,1)
  await life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,status:'done'},'five')
  assert.equal(life.snapshot().goals[0]!.progress.done,1);assert.equal(life.snapshot().goals[0]!.status,'active')
  await assert.rejects(life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,title:'Stale'},'six'),/version_conflict/)
  await assert.rejects(life.mutate({op:'create',kind:'todo',title:'Bad link',goal_id:'missing'},'seven'),/goal_not_found/)
  await life.mutate({op:'profile',expected_version:0,about:'I like language learning'},'eight')
  life=new LifeService(join(dir,'life.json'));await life.open();assert.equal(life.snapshot().profile.about,'I like language learning');assert.equal(life.snapshot().todos[0]!.status,'done')
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('news conversions retain provenance and dedupe by article and kind after receipt eviction and restart',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-life-'));const path=join(dir,'life.json');let life=new LifeService(path);await life.open()
 const article={article_id:'article',source_id:'bbc',url:'https://www.bbc.com/news/article',content_hash:'hash-v1',title:'Public claim',summary:'Quoted public excerpt',published_at:null}
 try{
  const input={op:'from_news',kind:'todo',title:'Check this research',note:'My intended action',article}
  const first=await life.mutate(input,'conversion');await life.mutate({op:'update',kind:'todo',id:first.id,expected_version:1,title:'My revised plan',status:'done'},'edit')
  for(let i=0;i<257;i++)await life.mutate({op:'profile',expected_version:i,about:'Synthetic profile'},'profile:'+i)
  await life.close();life=new LifeService(path);await life.open()
  const again=await life.mutate({...input,article:{...article,content_hash:'hash-v2'},title:'Must not replace edited title'},'conversion-again')
  assert.equal(again.id,first.id);assert.equal(again.version,2);assert.equal(life.snapshot().todos.length,1)
  const row=life.snapshot().todos[0]!;assert.equal(row.title,'My revised plan');assert.equal(row.status,'done');assert.deepEqual(row.news_source,{...article,action:'user_conversion',converted_at:row.created_at})
  const idea=await life.mutate({...input,kind:'idea'},'idea');const goal=await life.mutate({...input,kind:'goal'},'goal');assert.notEqual(idea.id,first.id);assert.notEqual(goal.id,first.id)
  assert.equal((await life.mutate({op:'convert',id:idea.id,target:'todo',expected_version:1},'idea-to-todo')).id,first.id)
  assert.equal(life.snapshot().todos.length,1)
 }finally{await life.close();await rm(dir,{recursive:true,force:true})}
})
test('rejected news conversion guard writes neither object nor receipt and remains retryable',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-guard-'));const life=new LifeService(join(dir,'life.json'));await life.open()
 const input={op:'from_news',kind:'idea',title:'My idea',note:'',article:{article_id:'article',source_id:'bbc',url:'https://www.bbc.com/news/a',content_hash:'v1',title:'Public article',summary:'Public excerpt',published_at:null}}
 try{
  const before=life.snapshot();await assert.rejects(life.mutate(input,'same-request',()=>{throw Error('article_changed')}),/article_changed/);assert.deepEqual(life.snapshot(),before)
  await life.mutate(input,'same-request');assert.equal(life.snapshot().ideas.length,1)
 }finally{await life.close();await rm(dir,{recursive:true,force:true})}
})

test('news conversion IDs cannot collide with a normal create request ID',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-id-collision-')),life=new LifeService(join(dir,'life.json'))
 const article={article_id:'a'.repeat(64),source_id:'synthetic',url:'https://example.com/article',content_hash:'synthetic-v1',title:'Public article',summary:'Public excerpt',published_at:null}
 try{
  await life.open()
  const original=await life.mutate({op:'create',kind:'todo',title:'Keep my existing task'},'news:todo:'+article.article_id)
  const converted=await life.mutate({op:'from_news',kind:'todo',title:'Read this article',article},'distinct-news-conversion-request')
  assert.notEqual(converted.id,original.id)
  const todos=life.snapshot().todos
  assert.equal(todos.length,2)
  assert.equal(todos.find(todo=>todo.id===original.id)?.title,'Keep my existing task')
  assert.equal(todos.find(todo=>todo.id===converted.id)?.news_source?.article_id,article.article_id)
 }finally{await life.close();await rm(dir,{recursive:true,force:true})}
})
