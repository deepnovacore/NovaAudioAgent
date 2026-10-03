import assert from 'node:assert/strict'
import {test} from 'node:test'
import {existsSync, readFileSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {surface, score, runTextCase} from './text-tools.mjs'
import {validateFixtures, validateModuleReport, summary} from './validation.mjs'

const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/live/text-tools.json', import.meta.url)))
test('fixture contract, current built-in surface and expectations cannot silently drift', () => {
  const parsed = validateFixtures(fixture)
  const full = surface()
  assert.deepEqual(full.tools.map(tool => tool.name).sort(), ['memory__recall','memory__evidence','search__search',
    'mcp__nova_knowledge__recall','dispatch','cancel','confirm'].sort())
  assert.deepEqual(surface(['coding','camera','search','knowledge']).tools.map(tool => tool.name), ['memory__recall','memory__evidence'])
  const covered = new Set()
  for (const entry of parsed.cases) for (const step of entry.steps) for (const call of step.expect.calls) {
    assert.ok(surface(entry.disabled).tools.some(tool => tool.name === call.name), `${entry.id}: unavailable expected tool`)
    covered.add(call.name)
  }
  assert.deepEqual([...covered].sort(), full.tools.map(tool => tool.name).sort())
  assert.throws(() => validateFixtures({...fixture,cases:[fixture.cases[0],fixture.cases[0]]}))
  assert.throws(() => validateFixtures({...fixture,cases:[{...fixture.cases[0],steps:[fixture.cases[0].steps[0],fixture.cases[0].steps[0]]}]}))
})

test('scorer rejects wrong tools, invalid/missing args, duplicate calls, false confirmation and unsupported answers', () => {
  const tools = surface().tools
  const expect = {calls:[{name:'confirm',args:{id:'pending-1',accepted:false}}],text:'forbidden'}
  const correct = {calls:[{name:'confirm',arguments:{id:'pending-1',accepted:false}}],text:''}
  assert.deepEqual(score(expect,correct,tools),[])
  assert.ok(score(expect,{...correct,calls:[{name:'confirm',arguments:{id:'pending-1',accepted:'false'}}]},tools).includes('invalid_arguments'))
  assert.ok(score(expect,{...correct,calls:[{name:'confirm',arguments:{id:'pending-1',accepted:true}}]},tools).includes('argument:accepted'))
  assert.ok(score(expect,{...correct,calls:[...correct.calls,...correct.calls]},tools).includes('call_count'))
  assert.ok(score(expect,{...correct,calls:[{name:'codex__run',arguments:{}}]},tools).includes('unavailable_tool'))
  assert.ok(score(expect,{...correct,text:'已经完成'},tools).includes('unexpected_text'))
  assert.ok(score({calls:[],text:'required',textAny:['就绪']},{calls:[],text:'不知道'},tools).includes('missing_answer_evidence'))
  assert.ok(score({calls:[{name:'dispatch',contains:{instruction:['不修改业务逻辑']}}],text:'forbidden'},
    {calls:[{name:'dispatch',arguments:{executor:'codex',instruction:'改样式'}}],text:''},tools).includes('invalid_arguments'))
  assert.equal(summary([]).accepted,false)
  assert.equal(summary([{status:'passed'},{status:'blocked'}]).accepted,false)
  assert.equal(summary([{status:'passed'}]).accepted,true)
})

test('runner missing credentials writes blocked report and exits nonzero without a network call', () => {
  const directory = mkdtempSync(join(tmpdir(),'nova-live-contract-'))
  try {
    const output = join(directory,'report.json')
    const result = spawnSync(process.execPath,[fileURLToPath(new URL('../live-smoke.mjs',import.meta.url)),
      '--provider','qwen','--case','greeting','--output',output], {env:{PATH:process.env.PATH},encoding:'utf8'})
    assert.equal(result.status,2,result.stderr)
    const report = JSON.parse(readFileSync(output,'utf8'))
    assert.equal(report.summary.blocked,1)
    assert.equal(report.summary.accepted,false)
    assert.equal(report.results[0].reason,'missing_selected_llm_key')
    assert.ok(report.finishedAt)
  } finally { rmSync(directory,{recursive:true,force:true}) }
})


test('continuation reuses call id, validates the answer, and preserves partial protocol failure evidence', async () => {
  let closed = 0, calls = 0
  const entry = {text:'fixture',context:'fixture',steps:[
    {expect:{calls:[{name:'confirm',args:{id:'p',accepted:true}}],text:'forbidden'},result:{ok:true}},
    {expect:{calls:[],text:'required',textAny:['成功']}}]}
  const factory = () => ({open:() => ({
    async *stream(input) {
      if (++calls === 1) yield {kind:'tool_call',call_id:'call-1',name:'confirm',arguments:{id:'p',accepted:true}}
      else { assert.deepEqual(input.inputs,[{kind:'tool_result',call_id:'call-1',output:{ok:true}}]); yield {kind:'text_delta',text:'成功'} }
      yield {kind:'response_completed'}
    },close:async () => {closed++},
  })})
  assert.equal((await runTextCase(entry,{},1000,factory)).status,'passed')
  assert.equal(closed,1)
  const broken = () => ({open:() => ({async *stream() {yield {kind:'text_delta',text:'partial'}; yield {kind:'response_failed',code:'protocol'}},close:async () => {closed++}})})
  const result = await runTextCase(entry,{},1000,broken)
  assert.equal(result.status,'failed')
  assert.equal(result.reason,'protocol')
  assert.equal(result.observations[0].text,'partial')
  assert.equal(closed,2)
})


test('catalogue paths exist and retired targets have no executable', () => {
  const catalog = JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url)))
  assert.equal(new Set(catalog.suites.map(suite => suite.id)).size,catalog.suites.length)
  for (const suite of catalog.suites) {
    if (suite.retired) {
      assert.equal(suite.entry,undefined,suite.id)
      const directory = mkdtempSync(join(tmpdir(),'nova-retired-live-'))
      try {
        const output = join(directory,'report.json')
        const result = spawnSync(process.execPath,[fileURLToPath(new URL('../live-smoke.mjs',import.meta.url)),
          `--target=${suite.id}`,'--output',output], {env:{PATH:process.env.PATH},encoding:'utf8'})
        assert.equal(result.status,2,result.stderr)
        const report = JSON.parse(readFileSync(output,'utf8'))
        assert.equal(report.results[0].reason,'retired_suite')
        assert.equal(report.summary.accepted,false)
      } finally { rmSync(directory,{recursive:true,force:true}) }
      continue
    }
    if (suite.entry === 'text-tools') continue
    const entry = new URL('../../'+suite.entry,import.meta.url)
    assert.ok(existsSync(entry),suite.id)
  }
})


test('knowledge continuation fixtures match the real in-process MCP adapter handoff', async () => {
  const {KnowledgeMcpAdapter} = await import('../../dist/src/knowledge/mcp.js')
  for (const id of ['knowledge','knowledge-injection','knowledge-failure']) {
    const expected = fixture.cases.find(entry => entry.id === id).steps[0].result
    const adapter = new KnowledgeMcpAdapter({
      recall:async () => {if (id === 'knowledge-failure') throw new Error('synthetic unavailable'); return expected.content.hits},
      getChunk:async () => ({status:'gone'}),
    })
    try {
      const actual = await adapter.dispatch('recall',{query:'蓝色',k:3},{signal:AbortSignal.timeout(2000)})
      // RealtimeService serializes sync non-search handoffs as {state: outcome, content}.
      assert.deepEqual({state:actual.outcome,content:actual.content},expected,id)
    } finally { await adapter.close() }
  }
})


test('semantic alternatives preserve constraints and ungrounded date/false execution claims fail', () => {
  const tools = surface().tools
  const steer = fixture.cases.find(entry => entry.id === 'coding-steer').steps[0].expect
  const call = {name:'dispatch',arguments:{executor:'codex',instruction:'只修改样式，不修改业务逻辑。',origin_ref:'conversation:1'}}
  assert.deepEqual(score(steer,{calls:[call],text:''},tools),[])
  assert.deepEqual(score(steer,{calls:[{...call,arguments:{...call.arguments,instruction:'只改样式，不要修改业务逻辑。'}}],text:''},tools),[])
  assert.ok(score(steer,{calls:[{...call,arguments:{...call.arguments,instruction:'修改样式和业务逻辑'}}],text:''},tools).includes('missing_meaning:instruction'))
  const search = fixture.cases.find(entry => entry.id === 'search').steps[0].expect
  assert.ok(score(search,{calls:[{name:'search__search',arguments:{query:'2024年航天新闻',k:3,origin_ref:'conversation:1'}}],text:''},tools).includes('unsupported_argument:query'))
  const disabled = fixture.cases.find(entry => entry.id === 'camera-disabled').steps[0].expect
  assert.ok(score(disabled,{calls:[],text:'我正在查看摄像头前的情况。'},tools).includes('forbidden_answer'))
  assert.deepEqual(score(disabled,{calls:[],text:'当前无法访问摄像头。'},tools),[])
  assert.deepEqual(score(disabled,{calls:[],text:'摄像头查看功能现在没法用。'},tools),[])
  assert.deepEqual(score(disabled,{calls:[],text:'摄像头现在用不了。'},tools),[])
  assert.deepEqual(score(steer,{calls:[{...call,arguments:{...call.arguments,instruction:'只修改样式，不得改动任何业务逻辑。'}}],text:''},tools),[])
})

test('optional memory fallback accepts an honest direct limitation or validates the final recall answer', async () => {
  const entry = {id:'optional-recall',text:'搜索新闻',context:'synthetic',steps:[
    {expect:{calls:[{name:'memory__recall'}],text:'forbidden'},
      otherwise:{calls:[],text:'required',textAll:[['搜索'],['不可用']]},
      result:{matches:[],raw_scanned:0,searched_count:0}},
    {expect:{calls:[],text:'required',textAll:[['没有记录'],['搜索不可用']]}}]}
  validateFixtures({version:1,cases:[entry]})
  const factory = (replies) => () => ({open:() => ({
    async *stream() { for (const event of replies.shift()) yield event; yield {kind:'response_completed'} },
    close:async () => {},
  })})
  const reply = text => [{kind:'text_delta',text}]
  const recall = [{kind:'tool_call',call_id:'r',name:'memory__recall',arguments:{query:'新闻',scope:'recent',source:'session'}}]
  assert.equal((await runTextCase(entry,{},1000,factory([reply('搜索不可用')]))).status,'passed')
  assert.equal((await runTextCase(entry,{},1000,factory([reply('正在搜索')]))).status,'failed')
  assert.equal((await runTextCase(entry,{},1000,factory([recall,reply('没有记录，搜索不可用')]))).status,'passed')
  assert.equal((await runTextCase(entry,{},1000,factory([recall,reply('没有记录')]))).status,'failed')
  assert.equal((await runTextCase(entry,{},1000,factory([recall,reply('搜索不可用')]))).status,'failed')
})

 test('clarification fixtures preserve user turns and refuse tool calls before the answer', async () => {
   const entry = validateFixtures(fixture).cases.find(item => item.id === 'coding-clarify-before-dispatch')
   let turn = 0
   const result = await runTextCase(entry, {provider:'qwen',model:'test'}, 1000, () => ({open: () => ({
     async *stream(input) {
       turn++
       assert.deepEqual(input.inputs, [{kind:'user_text',text:turn === 1 ? entry.text : entry.steps[0].user}])
       if (turn === 1) yield {kind:'text_delta',text:'要网页还是桌面版？'}
       else yield {kind:'tool_call',name:'dispatch',call_id:'d1',arguments:{executor:'codex',instruction:'贪吃蛇网页，方向键控制，显示分数，不安装依赖',origin_ref:'conversation:1',source_refs:['conversation:1']}}
       yield {kind:'response_completed'}
     },
     close:async () => {},
   })}))
   assert.equal(result.status, 'passed')
   assert.equal(turn, 2)
 })


test('module acceptance requires matching completed evidence, not merely exit zero',()=>{
 const report={version:1,module:'memory-reading',layer:'model-runtime',synthetic:true,status:'passed',checks:['current state read'],coverage:['synthetic only'],started_at:'2026-09-21T00:00:00Z',finished_at:'2026-09-21T00:01:00Z'}
 assert.equal(validateModuleReport(report,'memory-reading').status,'passed')
 assert.throws(()=>validateModuleReport(report,'memory-reading',Date.parse('2026-09-22T00:00:00Z')))
 for(const change of [{module:'memory-desktop'},{status:'running'},{checks:[]},{finished_at:undefined},{synthetic:false}])assert.throws(()=>validateModuleReport({...report,...change},'memory-reading'))
 assert.equal(validateModuleReport({...report,status:'blocked',checks:[]},'memory-reading').status,'blocked')
})
test('a model module without credentials produces a structured blocked artifact',()=>{
 const directory=mkdtempSync(join(tmpdir(),'nova-memory-module-contract-'))
 try{
  const output=join(directory,'report.json')
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../live-smoke.mjs',import.meta.url)),'--target=memory-daily','--output',output],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:15000})
  assert.equal(result.status,2,result.stderr);const report=JSON.parse(readFileSync(output,'utf8'))
  assert.equal(report.summary.blocked,1);assert.equal(report.summary.accepted,false)
  const evidence=JSON.parse(readFileSync(report.results[0].artifact,'utf8'));assert.equal(evidence.module,'memory-daily');assert.equal(evidence.status,'blocked');assert.deepEqual(evidence.calls,[])
 }finally{rmSync(directory,{recursive:true,force:true})}
})
