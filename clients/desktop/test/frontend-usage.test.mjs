import assert from 'node:assert/strict'
import test from 'node:test'
import {createFrontendUsage, publicUsageReport, priceUsage} from '../src/main/frontend-usage.mjs'
const report = {id:'one', provider:'qwen', service:'llm', model:'qwen-flash', pricingRegion:'cn-beijing', status:'complete', inputTokens:1000, outputTokens:100, cachedTokens:0}
test('validates IPC and projects no arbitrary data', () => {
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(publicUsageReport({...report,inputTokens:value}),null)
  assert.equal(publicUsageReport({...report,provider:'other'}),null)
  assert.equal(publicUsageReport({...report,model:'x'.repeat(257)}),null)
  assert.equal(publicUsageReport({...report,secret:'no'}).secret,undefined)
})
test('deduplicates a backend generation but retains totals after restart and model switch', () => {
  const usage = createFrontendUsage()
  assert.equal(usage.add(1,report),true)
  assert.equal(usage.add(1,report),false)
  usage.add(2,report)
  usage.add(2,{...report,id:'two',model:'unknown'})
  usage.add(2,{...report,id:'three',status:'missing'})
  const view = usage.snapshot()
  assert.equal(view.requests,4)
  assert.equal(view.missingReports,1)
  assert.equal(view.unpricedReports,1)
  assert.equal(view.rows.length,2)
  assert.ok(Math.abs(view.costCny-0.0006)<1e-10)
  view.rows[0].inputTokens = 99
  assert.equal(usage.snapshot().rows[0].inputTokens,3000)
})
test('uses per request input tiers and implicit cache discount; unknown regions stay unpriced', () => {
  assert.equal(priceUsage({...report,inputTokens:128001,outputTokens:0,cachedTokens:1}).costCny,(128000*.6+.12)/1e6)
  assert.equal(priceUsage({...report,pricingRegion:'unknown'}).costCny,null)
  assert.equal(priceUsage({...report,cachedTokens:1001}).costCny,null)
})
test('audio output text is free and missing modality counts are never guessed', () => {
  const audio = {...report,service:'realtime',model:'qwen-audio-3.0-realtime-plus',inputTextTokens:100,inputAudioTokens:200,outputTextTokens:300,outputAudioTokens:400}
  assert.equal(priceUsage(audio).costCny,(100*5+200*40+400*150)/1e6)
  assert.equal(priceUsage({...audio,outputAudioTokens:undefined}).costCny,null)
})
test('read-only UI distinguishes no reports, partial estimates and actual service units', async () => {
  const {frontendUsageText} = await import('../src/renderer/frontend-usage.mjs')
  assert.match(frontendUsageText(undefined),/暂无用量报告/)
  const usage = createFrontendUsage()
  usage.add(1,report)
  usage.add(1,{...report,id:'missing',status:'missing'})
  usage.add(1,{...report,id:'asr',provider:'volcengine',service:'asr',model:'unknown',audioDurationMs:1200,characters:20})
  const text = frontendUsageText(usage.snapshot())
  for (const phrase of ['部分费用','缺失用量 1 次','未配置价格','音频 1.200 秒','计费字符 20','价格来源：https://help.aliyun.com']) assert.ok(text.includes(phrase),phrase)
})
test('Volc 2.0 list prices use exact service units and request tiers', () => {
  const volc = {...report,provider:'volcengine'}
  assert.equal(priceUsage({...volc,service:'asr',model:'volc.seedasr.sauc.duration',audioDurationMs:3600000}).costCny,1)
  assert.equal(priceUsage({...volc,service:'tts',model:'seed-tts-2.0',characters:10000}).costCny,3)
  assert.equal(priceUsage({...volc,service:'asr',model:'volc.seedasr.sauc.concurrent',audioDurationMs:3600000}).costCny,null)
  const ark = {...report,provider:'ark',model:'doubao-seed-2-0-pro-260215',outputTokens:1000,cachedTokens:100}
  assert.equal(priceUsage({...ark,inputTokens:32000}).costCny,(31900*3.2+100*.64+1000*16)/1e6)
  assert.equal(priceUsage({...ark,inputTokens:32001}).costCny,(31901*4.8+100*.96+1000*24)/1e6)
  assert.equal(priceUsage({...ark,inputTokens:128001}).costCny,(127901*9.6+100*1.92+1000*48)/1e6)
  assert.equal(priceUsage({...ark,inputTokens:256001}).costCny,null)
})
test('aggregate refuses unsafe counter overflow and preserves custom model identities', () => {
  const usage = createFrontendUsage()
  assert.equal(usage.add(1,{...report,model:'org/custom',inputTokens:Number.MAX_SAFE_INTEGER}),true)
  assert.equal(usage.add(1,{...report,id:'overflow',model:'org/custom',inputTokens:1}),true)
  assert.equal(usage.snapshot().rows[0].inputTokens,Number.MAX_SAFE_INTEGER)
})
test('caps identity storage visibly and frees child dedupe on restart without accepting stale reports', () => {
  const usage = createFrontendUsage()
  for (let i=0;i<100001;i++) usage.add(1,{...report,id:String(i),inputTokens:0,outputTokens:0})
  assert.equal(usage.snapshot().requests,100000)
  assert.equal(usage.snapshot().truncated,true)
  usage.add(2,report)
  assert.equal(usage.add(1,{...report,id:'stale'}),false)
  assert.equal(usage.snapshot().requests,100001)
  assert.equal(usage.snapshot().truncated,true)
})

test('retains runtime-valid custom identities and records overflow loss once', () => {
  const usage = createFrontendUsage()
  assert.equal(usage.add(1, {...report, id:'request with spaces', model:'custom 模型 (preview)'}), true)
  assert.equal(usage.snapshot().unpricedReports, 1)
  usage.add(1, {...report, id:'max', inputTokens:Number.MAX_SAFE_INTEGER})
  assert.equal(usage.add(1, {...report, id:'overflow', inputTokens:1}), true)
  assert.equal(usage.add(1, {...report, id:'overflow', inputTokens:0}), false)
  assert.equal(usage.snapshot().truncated, true)
})
test('realtime cache without published rates stays unknown; text-only is billed', async () => {
  const audio = {...report,service:'realtime',model:'qwen-audio-3.0-realtime-plus',inputTextTokens:100,inputAudioTokens:200,outputTextTokens:300,outputAudioTokens:0}
  assert.equal(priceUsage({...audio,outputModality:'text'}).costCny,(100*5+200*40+300*40)/1e6)
  const usage = createFrontendUsage()
  usage.add(1,{...audio,cachedTokens:20})
  assert.equal(usage.snapshot().unpricedReports,1)
  const {frontendUsageText} = await import('../src/renderer/frontend-usage.mjs')
  assert.match(frontendUsageText(usage.snapshot()),/暂不可估算/)
  assert.doesNotMatch(frontendUsageText(usage.snapshot()),/¥0/)
})

test('small known charges never round down to a displayed zero', async () => {
  const {frontendUsageText} = await import('../src/renderer/frontend-usage.mjs')
  const usage = createFrontendUsage()
  usage.add(1,{...report,inputTokens:1,outputTokens:0})
  assert.match(frontendUsageText(usage.snapshot()),/< ¥0.0001/)
})
