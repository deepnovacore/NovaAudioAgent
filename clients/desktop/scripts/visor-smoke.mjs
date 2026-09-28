// Production HUD windows + real OS data; isolated settings, no microphone or provider calls.
import {app, BrowserWindow, ipcMain, net, protocol, session, desktopCapturer, systemPreferences} from 'electron'
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {registerAppScheme,installAppProtocol,buildRendererAssetGraph} from '../src/main/app-protocol.mjs'
import {createVisor} from '../src/main/visor.mjs'
const fixture=mkdtempSync(join(tmpdir(),'nova-visor-smoke-'))
app.setPath('userData',join(fixture,'profile'));registerAppScheme(protocol)
app.on('window-all-closed',()=>{})
const delay=ms=>new Promise(r=>setTimeout(r,ms))
const keep=process.argv.includes('--visor-preview')
const deadline=setTimeout(()=>{console.error('Visor smoke timeout');app.exit(1)},60000)
async function run(){
 const partition='visor-smoke',root=resolve(import.meta.dirname,'../src/renderer'),errors=[]
 installAppProtocol(session.fromPartition(partition).protocol,{rendererRoot:root,rendererFiles:await buildRendererAssetGraph(root),fetchFile:file=>net.fetch(pathToFileURL(file).href)})
 let ai={backend:'stopped',state:'inactive',muted:false,activated:false,model:null,usage:{requests:0,rows:[],pricedReports:0}}
 let orbClicks=0
 const file=join(fixture,'visor.json')
 const visor=createVisor({file,partition,preload:resolve(import.meta.dirname,'../src/preload/visor.cjs'),readAI:()=>ai,onOrb:()=>orbClicks++,onError:e=>errors.push(e)})
 ipcMain.handle('nova:visor:get',()=>visor.snapshot())
 ipcMain.handle('nova:visor:configure',(_e,patch)=>visor.configure(patch))
 ipcMain.handle('nova:visor:orb',()=>{orbClicks++})
 assert.throws(()=>visor.configure({opacity:9}));assert.throws(()=>visor.configure({script:'bad'}))
 visor.configure({enabled:true,mode:'showcase'})
 const [hud,controls]=visor.windows()
 for(const w of [hud,controls]){w.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});w.webContents.on('preload-error',(_e,_p,e)=>errors.push(e.message))}
 await delay(3200)
 assert.equal(hud.isVisible(),true);assert.equal(hud.isFocusable(),false)
 assert.equal(await hud.webContents.executeJavaScript("document.querySelector('#ai-state').textContent"),'未连接')
 assert.match(await hud.webContents.executeJavaScript("document.querySelector('#ram').textContent"),/GB/)
 const out=resolve(import.meta.dirname,'../../../output/visor-validation');mkdirSync(out,{recursive:true})
 writeFileSync(join(out,'showcase.png'),(await hud.webContents.capturePage()).toPNG())
 const bitmap=(await hud.webContents.capturePage()).toBitmap();let clear=0;for(let i=3;i<bitmap.length;i+=4)if(bitmap[i]===0)clear++
 assert.ok(clear/(bitmap.length/4)>.75,'most pixels must be completely transparent')
 await controls.webContents.executeJavaScript("document.getElementById('focus').click()")
 await delay(150);assert.equal(visor.preferences().mode,'focus')
 await controls.webContents.executeJavaScript("document.getElementById('orb').click()")
 await delay(100);assert.equal(orbClicks,1)
 ai={...ai,backend:'connected',state:'muted',muted:true,activated:true}
 await delay(2100);assert.equal(await hud.webContents.executeJavaScript("document.querySelector('#ai-state').textContent"),'已闭麦')
 visor.configure({motion:false,hardware:false,ai:false,opacity:.5})
 await delay(100);assert.equal(await hud.webContents.executeJavaScript("document.querySelector('#visor').classList.contains('hardware-hidden')"),true)
 assert.equal(JSON.parse(readFileSync(file)).opacity,.5)
 visor.configure({enabled:false});await delay(100);assert.equal(visor.windows()[0],null)
 for(let i=0;i<5;i++){visor.configure({enabled:true});visor.configure({enabled:false});visor.configure({enabled:true})}
 await delay(1000);assert.equal(BrowserWindow.getAllWindows().length,2,'rapid toggles never leave orphan windows')
 visor.configure({hardware:true,ai:true,motion:true,opacity:.8,mode:'showcase'})
 ai={...ai,backend:'stopped',state:'inactive',muted:false,activated:false}
 await delay(2200)
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,clearPixelRatio:clear/(bitmap.length/4),errors,hardware:visor.snapshot().hardware},null,2))
 assert.deepEqual(errors,[])
 console.log('PASS Visor: real telemetry, transparency, modes, persistence, unavailable/muted state, reduced motion, hide, rapid lifecycle, no renderer errors')
 clearTimeout(deadline)
 if(keep){
  const target=new BrowserWindow({width:950,height:610,x:260,y:145,title:'Visor · Click-through validation',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}})
  await target.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<body style="background:#eef2f5;color:#152a3c;font:18px system-ui;padding:50px"><h1>Nova Visor · 桌面交互验收</h1><p>这是测试窗口。覆盖层保持打开时，在下方输入并点击。</p><input id="input" placeholder="输入穿透测试文字" style="font-size:24px;padding:12px;width:85%"><p><button onclick="this.textContent='点击成功 · PASS'" style="font-size:22px;padding:16px">点击验证</button></p><p>验证：点击、输入、拖动窗口、切换模式、收起。</p></body>`))
  target.on('moved',()=>writeFileSync(join(out,'target-bounds.json'),JSON.stringify(target.getBounds())))
  writeFileSync(join(out,'target-bounds.json'),JSON.stringify(target.getBounds()))
  if(systemPreferences.getMediaAccessStatus('screen')==='granted'){
    const captures=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1920,height:1200}})
    if(captures[0])writeFileSync(join(out,'desktop.png'),captures[0].thumbnail.toPNG())
  }
  app.getAppMetrics();await delay(5000)
  writeFileSync(join(out,'metrics.json'),JSON.stringify(app.getAppMetrics().map(m=>({type:m.type,cpu:m.cpu,memory:m.memory})),null,2))
  console.log('INSPECT: HUD running, isolated settings.');return
 }
 visor.dispose();assert.equal(BrowserWindow.getAllWindows().length,0);app.quit()
}
app.whenReady().then(run).catch(e=>{console.error(e);app.exit(1)})
