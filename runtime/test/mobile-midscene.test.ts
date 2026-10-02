import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import sharp from 'sharp'
import {runMobileIos} from '../src/executors/mobile-ios.js'

for (const scenario of ['dynamic_home', 'dynamic_tap', 'window_before', 'window_after', 'geometry_before', 'geometry_after', 'window_transition', 'decline', 'cancel', 'timeout', 'disconnect', 'unknown_write', 'step_limit'] as const) test(`real Midscene: ${scenario}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-midscene-'))
  const oldPath = process.env.PATH
  process.env.PATH = `${root}:${oldPath}`
  t.after(async () => {process.env.PATH = oldPath; await rm(root,{recursive:true,force:true})})
  await writeFile(join(root,'state'),'0')
  await writeFile(join(root,'focus'),'com.example.app/.Main')
  for (const [i,background] of ['white','blue','green','red','yellow'].entries()) {
    await sharp({create:{width:((scenario === 'geometry_before' && i === 1) || (scenario === 'geometry_after' && i === 2)) ? 201 : 200,height:300,channels:3,background}}).png().toFile(join(root,`${i}.png`))
  }
  await writeFile(join(root,'adb'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),root=${JSON.stringify(root)};
const args=process.argv.slice(2);if(args[0]!=='-s'||args[1]!=='test-phone')process.exit(2);
const c=args.slice(2).join(' '),state=Number(fs.readFileSync(path.join(root,'state'),'utf8'));
if(c==='get-state'){if(${JSON.stringify(scenario)}==='disconnect'&&state>0)process.exit(1);console.log('device');}
else if(c==='shell getprop ro.serialno')console.log('HW-1');
else if(c==='shell dumpsys window')console.log('mCurrentFocus=Window{0 u0 '+fs.readFileSync(path.join(root,'focus'),'utf8')+'}');
else if(c==='exec-out screencap -p')process.stdout.write(fs.readFileSync(path.join(root,state+'.png')));
else if(c==='shell input keyevent 3'||c==='shell input tap 100 150'){fs.writeFileSync(path.join(root,'state'),String(state+1));if(${JSON.stringify(scenario)}==='unknown_write')process.exit(1);if(${JSON.stringify(scenario)}==='window_transition')fs.writeFileSync(path.join(root,'focus'),'com.example.app/.Other');}
else process.exit(2);
`,{mode:0o700})
  let requests = 0, approvals = 0
  const server = createServer((req,res) => { void (async () => {
    let body = ''; for await(const part of req)body += String(part)
    const parsed = JSON.parse(body) as {messages: {content: unknown}[]}
    assert.ok(parsed.messages.some(m=>Array.isArray(m.content) && m.content.some((p: {type?:string})=>p.type==='image_url')))
    if (requests === 0) {
      await writeFile(join(root,'state'),'1')
      if (scenario === 'window_before') await writeFile(join(root,'focus'),'com.example.app/.Other')
    }
    const action = ++requests <= 2 ? (scenario === 'dynamic_home' ? 'do(action="Home")' : 'do(action="Tap", element=[500,500])') : 'finish(message="done")'
    res.writeHead(200,{'Content-Type':'application/json'})
    res.end(JSON.stringify({choices:[{index:0,message:{role:'assistant',content:action},finish_reason:'stop'}]}))
  })().catch(error => {res.destroy(error as Error)}) })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>{server.closeAllConnections();server.close()})
  const address = server.address();assert.ok(address && typeof address!=='string')
  const controller = new AbortController()
  const result = await runMobileIos({deviceId:'test-phone',deviceType:'android',wdaUrl:'http://127.0.0.1:8100',
    baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'scripted',modelFamily:'auto-glm',apiKey:'local',maxSteps:scenario === 'step_limit' ? 1 : 3,
    budgetMs:scenario === 'timeout' ? 3000 : 30_000,settleMs:0,lockRoot:root},'Home twice',{
    signal:controller.signal,approve:async()=>{
      if (++approvals === 1) {
        await writeFile(join(root,'state'),'2')
        if (scenario === 'window_after') await writeFile(join(root,'focus'),'com.example.app/.Other')
      }
      if (scenario === 'cancel') controller.abort()
      if (scenario === 'timeout') return new Promise<boolean>(() => undefined)
      return scenario !== 'decline'
    },progress:()=>undefined,
  })
  if (scenario.startsWith('dynamic') || scenario === 'window_transition') {
    assert.deepEqual(result,{code:'model_finished',steps:2})
    assert.equal(approvals,2);assert.equal(requests,3)
    assert.equal(await readFile(join(root,'state'),'utf8'),'4')
  } else {
    const expected = {decline:'declined', cancel:'cancelled', timeout:'timeout', disconnect:'action_failed', unknown_write:'cleanup_unknown', step_limit:'step_limit'}
    const code = expected[scenario as keyof typeof expected] ?? 'screen_changed'
    const writes = scenario === 'unknown_write' || scenario === 'step_limit' ? 1 : 0
    assert.deepEqual(result,{code,steps:writes})
    assert.equal(approvals,['window_before','geometry_before','disconnect'].includes(scenario) ? 0 : 1)
    assert.equal(requests,scenario === 'step_limit' ? 2 : 1)
    assert.equal(await readFile(join(root,'state'),'utf8'),String(writes ? 3 : approvals ? 2 : 1))
  }
})
