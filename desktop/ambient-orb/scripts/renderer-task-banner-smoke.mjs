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
const output = resolve(process.env.NOVA_RENDERER_SMOKE_OUTPUT || `${root}/output/playwright/task-banner`)
await mkdir(output, {recursive:true})
const browser = await chromium.launch({headless:true, ...(process.env.NOVA_BROWSER_EXECUTABLE ? {executablePath:process.env.NOVA_BROWSER_EXECUTABLE} : {})})
try {
  const context = await browser.newContext({deviceScaleFactor:2, reducedMotion:'reduce'})
  await context.route('http://nova.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!/^\/[\w.-]+\.(html|css|mjs)$/.test(path)) return route.abort()
    const body = await readFile(`${root}/desktop/ambient-orb/src/renderer${path}`)
    await route.fulfill({body, contentType:path.endsWith('.mjs')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'})
  })
  const page = await context.newPage()
  const errors=[]
  page.on('pageerror', error=>{errors.push(error.message);console.error(error.message)})
  page.on('console', message=>{if(message.type()==='error')console.error(message.text())})
  let zoom=1, rows=0, confirmation=false, inSettings=false, workHeight=1080
  let position={x:400,y:400,width:160,height:160}
  async function layout() {
    const area={x:0,y:0,width:1920,height:workHeight}
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
      wakeWord:{onChanged:listen,activity:noop,report:noop,audio:noop},
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
      settings:{get:async()=>view,onChanged:cb=>(window.__settingsChanged=cb,noop),set:async patch=>({...view,...patch,saved:true,operationStatus:'applied',rejectedSecrets:[]})},
    }
  },{...publicSettings(DEFAULT_SETTINGS),backendStatus:'connected',settingsApplyStatus:'idle',secretsPresent:{},keyringAvailable:true,codexStatus:{state:'ready'},managedWorkspaces:{health:'ready',current:null,all:[]}})
  await page.setViewportSize({width:160,height:160})
  await page.goto('http://nova.test/index.html')
  await page.waitForFunction(()=>window.__socket?.readyState===1)
  const task = (work_id, project, title, summary, phase='working', ts=1) => ({work_id, executor:'codex', project, title, summary, phase, ts})
  const tasks=[task('a','Nova Audio Agent','完善 VoiceMem 的任务检索与验证','已定位到检索结果缺失的原因，正在核对修复后的测试结果。'),task('b','Nova Desktop','检查桌面窗口布局','正在验证窗口在屏幕边缘的位置。')]
  await page.evaluate(tasks=>window.__frame({type:'executor.tasks',revision:1,active_project:'Nova Audio Agent',tasks}),tasks)
  await page.waitForFunction(()=>!document.querySelector('#task-banner').hidden)
  for (const factor of [1,1.5,2]) {
    zoom=factor
    await page.evaluate(z=>document.documentElement.style.zoom=z,zoom)
    const view=await layout()
    await page.evaluate(view=>window.__bubbleLayout(view),view)
    await page.waitForTimeout(120)
    const boxes=await page.locator('#task-banner, #task-banner button, #task-banner h2, #task-banner [data-task-summary], #orb').evaluateAll(nodes=>nodes.map(n=>({id:n.id||n.tagName,rect:n.getBoundingClientRect().toJSON(),font:getComputedStyle(n).fontSize})))
    const viewport=page.viewportSize()
    for(const b of boxes) assert.ok(b.rect.x>=0&&b.rect.y>=0&&b.rect.right<=viewport.width&&b.rect.bottom<=viewport.height,`${factor}: clipped ${JSON.stringify(b)}`)
    await page.screenshot({path:`${output}/banner-${factor}.png`})
    if(factor===1) await page.locator('#task-banner').screenshot({path:`${output}/banner-card.png`})
    console.log(`banner zoom ${factor}: within ${viewport.width}x${viewport.height}`)
  }
  await page.evaluate(()=>window.__frame({type:'executor.progress',executor:'vision',delegate_id:'monitor',phase:'alert',summary:'检测到需要留意的新情况。',level:'milestone',ts:3}))
  await page.waitForFunction(()=>document.querySelectorAll('.progress-bubble').length===1)
  const alertBox=await page.locator('.progress-bubble').boundingBox(), bannerBox=await page.locator('#task-banner').boundingBox()
  assert.ok(alertBox.y+alertBox.height <= bannerBox.y || bannerBox.y+bannerBox.height <= alertBox.y, 'banner overlaps independent alert')
  await page.locator('.progress-bubble').click()
  await page.locator('[data-task-open]').click()
  let action=await page.evaluate(()=>window.__sent.map(s=>{try{return JSON.parse(s)}catch{return {}}}).filter(s=>s.type==='executor.task_action').at(-1))
  assert.equal(action.work_id,'a'); assert.equal(action.action,'open')
  await page.evaluate(a=>window.__frame({...a,type:'executor.task_action_result',status:'opened'}),action)
  await page.locator('[data-task-picker]').selectOption('b')
  await page.locator('[data-task-stop]').click()
  action=await page.evaluate(()=>window.__sent.map(s=>{try{return JSON.parse(s)}catch{return {}}}).filter(s=>s.type==='executor.task_action').at(-1))
  assert.equal(action.work_id,'b'); assert.equal(action.action,'cancel')
  assert.equal(await page.locator('[data-task-stop]').isDisabled(),true)
  await page.evaluate(a=>window.__frame({...a,type:'executor.task_action_result',status:'cancelling'}),action)
  assert.match(await page.locator('[data-task-status]').innerText(),/正在停止/)
  await page.locator('[data-task-hide]').click()
  assert.equal(await page.locator('#task-banner').isVisible(),false)
  await page.locator('#last-result').click()
  assert.equal(await page.locator('#task-banner').isVisible(),true)
  await page.evaluate(()=>window.__settingsChanged({palette:'ember',codingProgressNarration:'continuous'}))
  assert.equal(await page.evaluate(()=>window.__sent.filter(s=>s.includes('coding.progress_narration')).length),1)
  await page.evaluate(()=>window.__settingsChanged({palette:'ember',codingProgressNarration:'continuous'}))
  assert.equal(await page.evaluate(()=>window.__sent.filter(s=>s.includes('coding.progress_narration')).length),1)
  zoom=1;position={x:400,y:0,width:160,height:160}
  await page.evaluate(()=>document.documentElement.style.zoom=1)
  const lower=await layout();await page.evaluate(view=>window.__bubbleLayout(view),lower)
  await page.waitForTimeout(120)
  assert.equal(await page.locator('#task-banner').getAttribute('data-placement'),'below')
  const card=await page.locator('#task-banner').boundingBox(), orb=await page.locator('#orb').boundingBox()
  assert.ok(card.y>=orb.y+orb.height,'card covers Orb')
  await page.screenshot({path:`${output}/banner-below.png`})
  workHeight=340
  await page.evaluate(()=>window.__frame({type:'executor.progress',executor:'vision',delegate_id:'small-monitor',phase:'alert',summary:'检测到需要留意的新情况。',level:'milestone',ts:4}))
  await page.waitForFunction(()=>document.querySelectorAll('.progress-bubble').length===1 && document.querySelector('#task-banner').hidden)
  await page.locator('.progress-bubble').click()
  await page.waitForFunction(()=>!document.querySelector('#task-banner').hidden)
  workHeight=1080
  await page.locator('[data-task-picker]').selectOption('a')
  tasks[0].title='A very long session title checking independent session ownership and termination behavior'
  tasks[0].summary='The first stage is verified. Remaining integration checks require the native host and must not be described as already complete.'
  await page.evaluate(tasks=>window.__frame({type:'executor.tasks',revision:2,active_project:'Nova Audio Agent',tasks}),tasks)
  await page.screenshot({path:`${output}/banner-long-text.png`})
  const contrasts=await page.locator('#task-banner h2, [data-task-summary], [data-task-project], [data-task-status]').evaluateAll(nodes=>{
    const parse=s=>s.match(/[\d.]+/g).map(Number)
    const luminance=rgb=>rgb.slice(0,3).map(c=>c/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0)
    const back=parse(getComputedStyle(document.querySelector('#task-banner')).backgroundColor)
    const bg=back.slice(0,3).map(c=>c*(back[3]??1)+255*(1-(back[3]??1)))
    return nodes.map(n=>(luminance(parse(getComputedStyle(n).color))+.05)/(luminance(bg)+.05))
  })
  assert.ok(contrasts.every(value=>value>=4.5),`insufficient text contrast: ${contrasts}`)
  console.log(`Minimum text contrast over white wallpaper: ${Math.min(...contrasts).toFixed(2)}:1`)
  await page.locator('[data-task-summary]').focus()
  assert.equal(await page.locator('[data-task-summary]').evaluate(e=>getComputedStyle(e).overflowY),'auto')
  await page.evaluate(()=>window.__socket.onclose?.({code:1006,reason:''}))
  await page.waitForTimeout(100)
  assert.equal(await page.locator('[data-task-open]').isDisabled(),true)
  assert.deepEqual(errors,[])
  console.log('Banner UI smoke passed: layout, exact open/cancel, hide/restore, live mode, long text and disconnect')
} finally {await browser.close()}
