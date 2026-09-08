import assert from 'node:assert/strict'
import {readFile, mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

// Optional manual QA: use an installed Playwright module and isolated browser profile.
const {chromium} = await import(process.env.NOVA_PLAYWRIGHT_MODULE || 'playwright')
import {bubbleWindowLayout, confirmationWindowLayout} from '../src/main/window-position.mjs'
import {DEFAULT_SETTINGS, publicSettings} from '../src/main/settings-store.mjs'
import {settingsWindowOptions} from '../src/main/security.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = resolve(process.env.NOVA_RENDERER_SMOKE_OUTPUT || `${root}/desktop/nova-audio-agent-desktop/build/renderer-smoke`)
await mkdir(output, {recursive:true})
const browser = await chromium.launch({headless:true, ...(process.env.NOVA_BROWSER_EXECUTABLE ? {executablePath:process.env.NOVA_BROWSER_EXECUTABLE} : {})})
try {
  const context = await browser.newContext({deviceScaleFactor:2, reducedMotion:'reduce'})
  await context.route('http://nova.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!/^\/[\w.-]+\.(html|css|mjs)$/.test(path)) return route.abort()
    const body = await readFile(`${root}/desktop/nova-audio-agent-desktop/src/renderer${path}`)
    await route.fulfill({body, contentType:path.endsWith('.mjs')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'})
  })
  const page = await context.newPage()
  const errors=[]
  page.on('pageerror', error=>errors.push(error.message))
  let zoom=1, rows=0, confirmation=false, inSettings=false
  let position={x:400,y:400,width:160,height:160}
  async function layout() {
    const area={x:0,y:0,width:1920,height:1080}
    const result=rows?bubbleWindowLayout({normalBounds:position,rows,zoomFactor:zoom,scaleFactor:2,workArea:area,confirmationActive:confirmation})
      :confirmation?confirmationWindowLayout({normalBounds:position,zoomFactor:zoom,workArea:area}):{bounds:position}
    const shape={...result,rows,suppressed:result.suppressed??false}
    if (!inSettings) await page.setViewportSize({width:result.bounds.width,height:result.bounds.height})
    return shape
  }
  await page.exposeFunction('__reserve',async next=>{rows=next;return layout()})
  await page.exposeFunction('__confirm',async active=>{confirmation=active;return layout()})
  await page.addInitScript(view=>{
    const noop=()=>{}, listen=()=>noop
    window.__sent=[]
    window.__frame=frame=>window.__socket.onmessage?.({data:JSON.stringify(frame)})
    window.WebSocket=class {
      static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=0
      constructor(){window.__socket=this;setTimeout(()=>{this.readyState=1;this.onopen?.({})},0)}
      send(data){window.__sent.push(data)}close(){this.readyState=3}
    }
    const emitLayout=layout=>{
      window.__placement?.(layout.confirmationPlacement||layout.placement||'below')
      window.__bubbleLayout?.(layout)
      return layout
    }
    window.novaAudioAgentDesktop={
      bootstrap:async()=>({backend:{endpoint:'ws://127.0.0.1:9999/',token:'0'.repeat(32)},settings:{palette:'ember'},platform:'darwin',audioMode:'browser',cameraSource:'local',nativeAvailable:false,backendStatus:'connected'}),
      onBackendExit:listen,onBackendReady:listen,onBackendStatus:listen,
      microphone:{requestPermission:async()=>({status:'denied'}),report:noop,onRetry:listen},
      camera:{requestPermission:async()=>({status:'denied'})},
      nativeAudio:{onEvent:listen,clear:async()=>{},setCaptureEnabled:async()=>false},
      orbMenu:{show:noop,openSettings:noop},windowDrag:{start:noop,move:noop,end:noop},
      executorResult:{open:async result=>{window.__openedResult=result}},
      windowLayout:{onConfirmationPlacement:cb=>(window.__placement=cb,noop),
        onBubbleLayout:cb=>(window.__bubbleLayout=cb,noop),
        reserveBubbleArea:async next=>emitLayout(await window.__reserve(next)),
        setConfirmationMode:active=>{void window.__confirm(active).then(emitLayout)}},
      settings:{get:async()=>view,onChanged:listen,set:async patch=>({...view,...patch,saved:true,operationStatus:'applied',rejectedSecrets:[]})},
    }
  },{...publicSettings(DEFAULT_SETTINGS),backendStatus:'connected',settingsApplyStatus:'idle',secretsPresent:{},keyringAvailable:true,codexStatus:{state:'ready'},managedWorkspaces:{health:'ready',current:null,all:[]}})
  await page.setViewportSize({width:160,height:160})
  await page.goto('http://nova.test/index.html')
  await page.waitForFunction(()=>window.__socket?.readyState===1)
  for (const factor of [1,1.25,1.5]) {
    zoom=factor
    await page.evaluate(z=>document.documentElement.style.zoom=z,zoom)
    await page.evaluate(()=>window.__frame({type:'executor.approval',executor:'codex',display_name:'Codex',pending_approval:true,pending_approval_busy:false,pending_approval_id:'approval',kind:'network',local_detail:{kind:'network',command:'npm install',cwd:'/workspace',scope:'网络：registry.npmjs.org'},operation_summary:'Codex 请求访问网络。',expires_in_seconds:60,allowed_decisions:['accept','acceptForSession','decline']}))
    await page.waitForFunction(()=>!document.querySelector('#codex-allow-session').hidden)
    await page.waitForTimeout(150)
    for(let i=0;i<3;i++) await page.evaluate(i=>window.__frame({type:'executor.progress',delegate_id:`d-${i}`,executor:'codex',phase:'working',summary:['已开始处理任务','正在检查测试结果','已完成代码修改'][i],level:'milestone',ts:i+1}),i)
    await page.waitForFunction(()=>document.querySelectorAll('.progress-bubble').length===3)
    const boxes=await page.locator('.progress-bubble, #codex-label, #codex-confirm, #codex-allow-session, #codex-cancel, #orb').evaluateAll(nodes=>nodes.map(n=>({id:n.id||n.className,rect:n.getBoundingClientRect().toJSON(),scroll:n.scrollWidth,client:n.clientWidth})))
    const viewport=page.viewportSize()
    for(const b of boxes) assert.ok(b.rect.x>=-1&&b.rect.y>=-1&&b.rect.right<=viewport.width+1&&b.rect.bottom<=viewport.height+1,`${factor} clipped ${JSON.stringify(b)} within ${JSON.stringify(viewport)}`)
    await page.screenshot({path:`${output}/approval-bubbles-${factor}.png`,omitBackground:false})
    console.log(`approval and bubbles: zoom=${factor}, viewport=${viewport.width}x${viewport.height}`)
    await page.locator('.progress-bubble').first().click()
    await page.waitForFunction(()=>document.querySelectorAll('.progress-bubble').length===2)
    await page.evaluate(()=>window.__frame({type:'executor.approval',executor:'codex',display_name:'Codex',pending_approval:false,pending_approval_busy:false,kind:null,local_detail:null,operation_summary:null,expires_in_seconds:null}))
    await page.locator('.progress-bubble').first().click()
    await page.locator('.progress-bubble').first().click()
    await page.waitForFunction(()=>document.querySelectorAll('.progress-bubble').length===0)
  }
  await page.evaluate(()=>window.__frame({type:'executor.approval',executor:'codex',display_name:'Codex',pending_approval:true,pending_approval_busy:false,pending_approval_id:'expiring',kind:'permissions',local_detail:{kind:'permissions',scope:'网络：请求访问'},operation_summary:'Codex 请求提升权限。',expires_in_seconds:.1,allowed_decisions:['accept','acceptForSession','decline']}))
  await page.waitForFunction(()=>document.querySelector('#codex-confirm').disabled && document.querySelector('#codex-allow-session').disabled && document.querySelector('#codex-cancel').disabled)
  const count = await page.evaluate(()=>window.__sent.length)
  await page.locator('#codex-confirm').dispatchEvent('click')
  assert.equal(await page.evaluate(()=>window.__sent.length),count)
  await page.evaluate(()=>window.__frame({type:'executor.approval',executor:'codex',display_name:'Codex',pending_approval:false,pending_approval_busy:false,kind:null,local_detail:null,operation_summary:null,expires_in_seconds:null}))
  // No progress frames are required: the result affordance also works when the runtime filters bubbles off.
  await page.evaluate(() => {
    const roster = [{name: '<alpha>', last_used_at: 1, running: [{work_id: 'a', title: '<img src=x>'}]}, {name: 'beta', last_used_at: 2, running: [{work_id: 'b', title: 'B title'}]}]
    window.__frame({type: 'project.state', workspace_display_name: '<alpha>', session_title: null, roster,
      pending_confirmation: false, pending_confirmation_busy: false, pending_action: null,
      pending_workspace_display_name: null, pending_session_title: null, pending_expires_in_seconds: null})
    window.__frame({type: 'executor.results.reset'})
    for (const id of ['a', 'b']) window.__frame({type: 'executor.result', work_id: id, result: {
      delegate_id: id, executor: 'codex', project: id === 'a' ? '<alpha>' : 'beta', title: id === 'a' ? '<img src=x>' : 'B result',
      outcome: 'ok', summary: '<b>done</b>', started_at: 0, ended_at: 5, changed_files: 2}})
  })
  await page.locator('#last-result').click()
  assert.equal(await page.evaluate(() => window.__openedResult.results.length), 2)
  assert.equal(await page.evaluate(() => window.__openedResult.roster[0].running[0].title), '<img src=x>')
  assert.equal(await page.evaluate(() => window.__openedResult.results[0].project), '<alpha>')
  assert.equal(await page.locator('img').count(), 0, 'source markup must remain text')
  await page.evaluate(() => window.__frame({type: 'executor.result', work_id: 'a', result: null}))
  await page.locator('#last-result').click()
  assert.deepEqual(await page.evaluate(() => window.__openedResult.results.map(result => result.delegateId)), ['b'])
  // A reconnect snapshot must remove previously retained entries, then replay the current set.
  await page.evaluate(() => {
    window.__frame({type: 'executor.results.reset'})
    window.__frame({type: 'executor.result', work_id: 'c', result: {delegate_id: 'c', executor: 'codex', outcome: 'cancelled', summary: 'Stopped', started_at: 0, ended_at: 5, changed_files: 0}})
  })
  await page.locator('#last-result').click()
  assert.deepEqual(await page.evaluate(() => window.__openedResult.results.map(result => result.delegateId)), ['c'])
  console.log('project roster and keyed results: concurrent, clear, reconnect, progress off, plain text')
  zoom=1
  position={x:400,y:0,width:160,height:160}
  await page.evaluate(()=>document.documentElement.style.zoom=1)
  await page.evaluate(()=>window.__frame({type:'executor.progress',delegate_id:'below',executor:'codex',phase:'working',summary:'正在核对结果',level:'detail',ts:100}))
  await page.waitForFunction(()=>document.querySelectorAll('.progress-bubble').length===1)
  const lower = await page.locator('.progress-bubble').boundingBox()
  const last = await page.locator('#last-result').boundingBox()
  assert.ok(last.y+last.height <= lower.y, 'last-result overlaps below bubble')
  await page.locator('#last-result').click()
  await page.screenshot({path:`${output}/below-last-result.png`})
  await page.locator('.progress-bubble').click()
  inSettings=true
  zoom=1
  const settingsBounds = settingsWindowOptions(resolve(root, 'desktop/nova-audio-agent-desktop/src/preload/preload.cjs'), 'smoke')
  await page.setViewportSize({width:settingsBounds.width,height:settingsBounds.height})
  await page.goto('http://nova.test/settings.html')
  await page.locator('label:has(input[name="codexApprovalMode"][value="yolo"])').click()
  assert.equal(await page.locator('#codex-yolo-warning').isVisible(),true)
  const choices = await page.locator('#plan-readback label').evaluateAll(nodes => nodes.map(node=>node.getBoundingClientRect().y))
  assert.equal(new Set(choices).size,1,'readback choices should share a row')
  await page.screenshot({path:`${output}/settings-yolo.png`,fullPage:true})
  assert.deepEqual(errors,[])
  console.log('UI smoke passed')
} finally {await browser.close()}
