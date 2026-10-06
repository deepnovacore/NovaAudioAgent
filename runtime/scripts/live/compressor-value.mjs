/** Real-model positive acceptance; synthetic conversation, no ACP backend or personal data. */
import assert from 'node:assert/strict'
import {writeFile, readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
if (process.env.NOVA_LIVE_COMPRESSOR_VALUE !== '1' || !process.env.DASHSCOPE_API_KEY) throw Error('Requires explicit live opt-in and DASHSCOPE_API_KEY')
const dist = resolve(process.env.NOVA_ACP_AFTER_DIST ?? 'runtime/dist')
const load = name => import(pathToFileURL(resolve(dist, 'src', name + '.js')).href)
const [{CausalRuntime}, {RealClock}, {MonotonicIdFactory}, {OpenAIModelGateway}, {GatewayCompressor, compressorPrompt}, {compileContextView}, {renderContextView}] = await Promise.all(['core/causal-runtime','core/clock','core/ids','model/model-gateway','model/model-adapters','core/context-view','model/prompting'].map(load))
const report = {scope: 'Synthetic conversation through real runtime watermark, qwen-flash compressor and downstream model. No ACP/GUI acceptance.', source: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), scriptHash: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), modelCalls: [], jobs: [], rounds: []}
report.distHashes = Object.fromEntries(await Promise.all(['core/runtime','core/context-view','model/model-adapters','model/prompting'].map(async name => [name,createHash('sha256').update(await readFile(resolve(dist,'src',name+'.js'))).digest('hex')])))
let purpose = 'compressor'
const clock = new RealClock()
const gateway = new OpenAIModelGateway({baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey:process.env.DASHSCOPE_API_KEY, clock, metrics:{record(row){report.modelCalls.push({purpose,...row}); console.log(JSON.stringify({purpose,...row}))}}})
const compressor = new GatewayCompressor({gateway,model:'qwen-flash'})
const stop = new AbortController(), timeout = setTimeout(()=>stop.abort(),180000)
const runtime = new CausalRuntime({clock,ids:new MonotonicIdFactory(),models:{compress:{async complete(call,signal){
  assert.ok(report.jobs.length < 2, 'two-call compression budget')
  const job = {start:clock.now(),items:call.compression_items.length}; report.jobs.push(job)
  const summary = await compressor.compress(call.compression_items,signal); job.end = clock.now()
  return {channel:call.channel,summary}
}}}})
const serving = runtime.serve(stop.signal)
async function waitFor(test){while(!test()){if(stop.signal.aborted)throw Error('deadline'); await delay(100)}}
const questions = 'Return JSON only, with keys owner, port, deadline, status, blocker, rollback. Use null for unknown. What are the current owner, port, deadline, release status, unresolved blocker, and rollback artifact for project LANTERN? Use the latest corrections.'
const normalize = answer => ({...answer, blocker: typeof answer.blocker === 'string' && /checksum audit/i.test(answer.blocker) && (/pending|unresolved|not.*(?:complete|resolved)/i.test(answer.blocker) || (answer.status === 'blocked' && /^checksum audit$/i.test(answer.blocker))) ? 'checksum audit pending' : answer.blocker})
const expected = {owner:'Mira',port:7319,deadline:'2026-11-18',status:'blocked',blocker:'checksum audit pending',rollback:'lantern-r17.zip'}
const facts = [
  'Project LANTERN: initial owner Theo; initial port 7001; initial deadline 2026-11-10.',
  'Project LANTERN correction: owner is now Mira, replacing Theo.',
  'Project LANTERN correction: final port is 7319, replacing 7001.',
  'Project LANTERN correction: deadline moved to 2026-11-18, replacing 2026-11-10.',
  'Project LANTERN: release status is blocked; unresolved blocker is checksum audit pending. Do not call the release complete.',
  'Project LANTERN: rollback artifact is lantern-r17.zip. The checksum audit is not yet resolved.',
]
try {
  for(let i=0;i<40;i++) await runtime.ingestUserInput({text:facts[i] ?? `Independent fixture ITEM-${i}: verified ${i*17} records on shard S${i}, with ${i%3} retries; output item-${i}.csv. This result concerns only ITEM-${i}, and gives no release authorization for other projects.`})
  const channel = runtime.memory.channels.get('conversation')
  await waitFor(()=>channel.summaryThroughSequence===40)
  assert.equal(report.jobs.length,1); assert.equal(channel.uncompressed,0); console.log('first summary applied')
  assert.equal(channel.items.length,40); assert.equal(runtime.memory.channels.size,1)
  report.summary = channel.summary
  const verifyExcerpt = summary => {
    const selected = JSON.parse(summary.slice(summary.indexOf('\n') + 1))
    const originals = JSON.parse(compressorPrompt(channel.items))
    assert.ok(selected.length > 0 && selected.length <= 16)
    for (const record of selected) assert.deepEqual(record, originals.find(item => item.ref === record.ref))
    return selected.map(record => record.ref)
  }
  report.firstVerifiedRefs = verifyExcerpt(channel.summary)
  const view = compileContextView(runtime.memory,runtime.core.floor.state,clock.now(),{freshWindow:0})
  const variants = {
    recent: {...view,channels:view.channels.map(c=>({...c,summary:null}))},
    compressed:view,
    full:{...view,channels:view.channels.map(c=>({...c,summary:null,recent:channel.items,omitted:0}))},
  }
  for(const [name,context] of Object.entries(variants)){
    purpose=name
    const response = await gateway.complete({model:'qwen-flash',system:'Answer exclusively from supplied records. Preserve unresolved uncertainty. Return JSON only.',prompt:renderContextView(context)+'\n'+questions,maxTokens:256,signal:stop.signal})
    const answer = normalize(JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g,'')))
    const score = Object.entries(expected).filter(([key,value])=>answer[key]===value).length
    report.rounds.push({variant:name,rawAnswer:response.text,answer,score,promptBytes:Buffer.byteLength(renderContextView(context))})
    if(name!=='recent') assert.deepEqual(answer,expected)
  }
  assert.equal(report.rounds[0].score,0,'recent-only control must lack older facts')
  purpose='compressor'
  for(let i=40;i<80;i++) await runtime.ingestUserInput({text:`New verification CHECK-${i}: dataset batch-${i}.csv has ${i*23} rows and validation passed; reviewed by reviewer-${i%4}.`})
  await delay(1000)
  assert.equal(channel.uncompressed,40)
  assert.equal(report.jobs.length,1,'cooldown prevents immediate repeat')
  const coolingView=compileContextView(runtime.memory,runtime.core.floor.state,clock.now())
  report.cooldownGap={uncompressed:channel.uncompressed, recentSequences:coolingView.channels[0].recent.map(item=>item.seq), summaryThrough:channel.summaryThroughSequence, check40Visible:renderContextView(coolingView).includes('CHECK-40')}
  assert.equal(report.cooldownGap.check40Visible,true)
  assert.deepEqual(report.cooldownGap.recentSequences,Array.from({length:40},(_,i)=>i+41))
  purpose='cooldown-verification'
  const coolingAnswer=await gateway.complete({model:'qwen-flash',system:'Extract facts from supplied records only. Return exactly JSON {"rows":number|null}.',prompt:renderContextView(coolingView)+'\nQuestion: Find the new verification CHECK-40 (dataset batch-40.csv) in the records above. How many rows does it have? Return {"rows":number}, or {"rows":null} only if the record is absent.',maxTokens:128,signal:stop.signal})
  report.cooldownAnswer=JSON.parse(coolingAnswer.text)
  assert.equal(report.cooldownAnswer.rows,920)
  purpose='compressor'
  await waitFor(()=>channel.summaryThroughSequence===80)
  assert.equal(report.jobs.length,2); assert.deepEqual(report.jobs.map(job=>job.items),[40,80])
  report.cooldownSeconds=report.jobs[1].start-report.jobs[0].end
  assert.ok(report.cooldownSeconds>=59.9)
  assert.equal(channel.uncompressed,0)
  report.secondSummary=channel.summary
  report.secondVerifiedRefs=verifyExcerpt(channel.summary)
  purpose='compressed-second'
  const response=await gateway.complete({model:'qwen-flash',system:'Answer exclusively from supplied records. Preserve unresolved uncertainty. Return JSON only.',prompt:renderContextView(compileContextView(runtime.memory,runtime.core.floor.state,clock.now(),{freshWindow:0}))+'\n'+questions,maxTokens:256,signal:stop.signal})
  report.secondRawAnswer=response.text; report.secondAnswer=normalize(JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g,''))); assert.deepEqual(report.secondAnswer,expected)
  const metric=name=>report.modelCalls.find(c=>c.purpose===name)
  const saved=metric('full').input_tokens-metric('compressed').input_tokens
  assert.ok(saved>0)
  report.inputSavingsPerRead=saved
  report.firstCompressionInputTokens=metric('compressor').input_tokens
  report.inputOnlyBreakEvenReads=Math.ceil(report.firstCompressionInputTokens/saved)
  purpose='unsupported-count'
  const countAnswer=await gateway.complete({model:'qwen-flash',system:'Use supplied records only. Return JSON {"total_fixture_count":number|null}. What is the exact total number of independent ITEM fixtures across the entire history? Selected excerpts are incomplete: if no explicit total exists, return null; never extrapolate from selected references or ranges.',prompt:renderContextView(compileContextView(runtime.memory,runtime.core.floor.state,clock.now())),maxTokens:128,signal:stop.signal})
  report.unsupportedCount=JSON.parse(countAnswer.text); assert.equal(report.unsupportedCount.total_fixture_count,null)
  report.ok=report.modelCalls.every(c=>c.error_type===null)
} catch(error){report.ok=false;report.error=String(error)} finally {
  clearTimeout(timeout);stop.abort();await serving
  await writeFile(process.env.NOVA_VALUE_REPORT ?? '/tmp/nova-compressor-value.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2)); process.exitCode=report.ok?0:1
}
