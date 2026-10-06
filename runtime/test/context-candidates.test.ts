import assert from 'node:assert/strict'
import test from 'node:test'
import {selectContextCandidates,type ContextInput} from '../src/personal-agent/context-candidates.js'

const file=(id:string,rel_path:string,content:string,priority=0,mtime_ms=1):ContextInput=>({kind:'file',id:`source:${id}`,version:'v1',content,source_id:'computer',file_id:id,root:id==='note'?'/notes':'/projects',rel_path,role:'document',mtime_ms,priority})

test('candidate selection excludes generic project overviews and keeps explicit proposals',()=>{
 const inputs:ContextInput[]=[
  file('note','project-notes.md','Next step: compare two recording flows.\nAn idea for simpler onboarding.',2,1),
  file('readme','README.md','A library for measuring input quality.',0,9),
  file('agent','AGENTS.md','Always run these agent instructions.',0,10),
  file('config','config.yaml','provider: example',0,11),
  file('vendor','node_modules/dependency/README.md','Dependency overview',0,12),
 ]
 const selected=selectContextCandidates(inputs)
 assert.ok(selected.some(item=>item.tab==='todos'&&item.primaryFileId==='note'))
 assert.ok(selected.some(item=>item.tab==='ideas'&&item.primaryFileId==='note'))
 assert.ok(selected.every(item=>item.primaryFileId!=='readme'))
 assert.ok(selected.every(item=>!['agent','config','vendor'].includes(item.primaryFileId??'')))
 assert.ok(selected.every(item=>item.tab==='todos'||item.tab==='ideas'))
})

test('README content alone never turns a cloned repository into a personal suggestion',()=>{
 const selected=selectContextCandidates([file('clone','README.md','Next step: publish a release.',0,Date.now())])
 assert.deepEqual(selected,[])
 assert.deepEqual(selectContextCandidates([file('workspace','README.md','Next step: publish a release.',1,Date.now())]),[])
 assert.deepEqual(selectContextCandidates([file('overview','README.md','An idea for setup.',3,Date.now())]),[])
 assert.deepEqual(selectContextCandidates([file('vendor','vendor/tool/README.md','An idea for setup.',3,Date.now())]),[])
 assert.deepEqual(selectContextCandidates([file('config','config.yaml','key: value')]),[])
})
test('an explicit proposal in a project note remains a candidate',()=>{
 const selected=selectContextCandidates([file('proposal','notes.md','摘要：建议用会话替代一次性派发。',1)])
 assert.equal(selected.length,1)
 assert.equal(selected[0]!.tab,'ideas')
})
test('an unselected whole-computer document does not become an automatic suggestion',()=>{
 assert.deepEqual(selectContextCandidates([file('intake','Documents/onboarding/notes.md','摘要：建议用会话替代一次性派发。',0,Date.now())]),[])
})
test('an explicitly selected hidden notes folder may contribute its documents only',()=>{
 const selected={...file('hidden','.notes/idea.md','An idea for a simpler workflow.',3),hidden_prefix_depth:1} as Extract<ContextInput,{kind:'file'}>
 assert.equal(selectContextCandidates([selected]).length,1)
 assert.deepEqual(selectContextCandidates([{...selected,rel_path:'.notes/.nested/idea.md'}]),[])
})
test('with project digests, todos come from own projects with a focus or next step instead of keyword lines',()=>{
 const digest=(key:string,role:'own'|'third_party',focus:string|null,next_step:string|null)=>({project_key:key,name:key,role,summary:`${key} summary`,focus,next_step,refs:[{entry_id:`source:${key}`,version:'v1'}]})
 const inputs=[file('note','project-notes.md','Next step: compare two recording flows.',2,1)]
 const selected=selectContextCandidates(inputs,[digest('nova','own','修复工作台内容',null),digest('lib','third_party','x','y'),digest('idle','own',null,null)])
 const todos=selected.filter(c=>c.tab==='todos')
 assert.deepEqual(todos.map(c=>c.reason_code),['project_focus'])
 assert.deepEqual(todos[0]!.refs,[{entry_id:'source:nova',version:'v1'}])
 assert.doesNotMatch(todos[0]!.excerpt,/\//u)
 assert.ok(selectContextCandidates(inputs).some(c=>c.tab==='todos'),'without digests the old document path still works')
})
test('a document excerpt sent to the model stops at 400 characters',()=>{
 const [candidate]=selectContextCandidates([file('long','plan.md','An idea for a simpler workflow. '+'细'.repeat(900),3)])
 assert.equal(candidate?.excerpt.length,400);assert.equal(candidate?.content.length,400)
})
test('evidence past the first 400 characters stays in the excerpt, with the first line as a title',()=>{
 const filler=Array.from({length:12},(_,i)=>`第 ${i} 段背景说明，写了一些与行动无关的细节。`.repeat(2)).join('\n')
 const [todo]=selectContextCandidates([file('t','notes.md','发布清单\n'+filler+'\n下一步：把原生验收跑完\n尾注',3)])
 assert.equal(todo?.tab,'todos');assert.ok(todo.excerpt.length<=400);assert.equal(todo.content,todo.excerpt)
 assert.match(todo.excerpt,/^发布清单\n…\n第 \d+ 段/u,'the window starts on a line boundary');assert.match(todo.excerpt,/下一步：把原生验收跑完/u)
 const [idea]=selectContextCandidates([file('i','design.md','设计笔记\n'+filler+'\n可以考虑把来源收进右键菜单',3)])
 assert.equal(idea?.tab,'ideas');assert.ok(idea.excerpt.length<=400);assert.match(idea.excerpt,/可以考虑把来源收进右键菜单$/u)
})
test('goal candidates keep their slots when todos and documents alone would fill the twelve',()=>{
 const digest=(key:string)=>({project_key:key,name:key,role:'own' as const,summary:`${key} 是一个长期在做的项目`,focus:`${key} 近期在收尾`,next_step:null,refs:[{entry_id:`source:${key}`,version:'v1'}]})
 const docs=Array.from({length:10},(_,i)=>({...file(`d${i}`,`notes${i}.md`,'An idea for a simpler workflow.',2),root:`/root${i}`}) as ContextInput)
 const selected=selectContextCandidates(docs,['a','b','c','d','e','f','g'].map(digest))
 assert.equal(selected.length,12)
 assert.deepEqual(selected.filter(c=>c.tab==='goals').map(c=>c.root),['project:a','project:b','project:c'])
 assert.ok(selected.filter(c=>c.tab==='todos').length>0)
})
test('own projects, and only own projects, offer at most one long-term direction each and three overall',()=>{
 const digest=(key:string,role:'own'|'third_party'|'sample')=>({project_key:key,name:key,role,summary:`${key} 是一个长期在做的项目`,focus:null,next_step:null,refs:[{entry_id:`source:${key}`,version:'v1'}]})
 const selected=selectContextCandidates([],[digest('a','own'),digest('lib','third_party'),digest('demo','sample'),digest('b','own'),digest('c','own'),digest('d','own')])
 const goals=selected.filter(c=>c.tab==='goals')
 assert.deepEqual(goals.map(c=>c.root),['project:a','project:b','project:c'])
 assert.ok(goals.every(c=>c.reason_code==='project_direction'&&c.excerpt.includes('长期在做')))
 assert.equal(selected.filter(c=>c.tab==='todos').length,0,'a project with no focus or next step is not a todo')
 assert.equal(new Set(goals.map(c=>c.candidate_id)).size,3)
})
