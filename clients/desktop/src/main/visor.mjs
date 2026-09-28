import {BrowserWindow, screen, nativeTheme} from 'electron'
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {createHardwareSampler,visorPreferences} from './visor-data.mjs'

export function createVisor({file,partition,preload,readAI,onOrb,onError = console.error}) {
  let preferences
  try { preferences = visorPreferences(JSON.parse(readFileSync(file,'utf8'))) } catch { preferences = visorPreferences() }
  let hud = null, controls = null, timer = null, closing = null, disposed = false, hardware = null, running = false
  const sample = createHardwareSampler()
  const alive = w => w && !w.isDestroyed()
  const send = () => {
    const value = {preferences:{...preferences,motion:preferences.motion},hardware,ai:readAI()}
    for (const w of [hud,controls]) if (alive(w)) w.webContents.send('nova:visor:changed',value)
  }
  const layout = () => {
    if (!alive(hud)) return
    const area = screen.getPrimaryDisplay().workArea
    hud.setBounds(area)
    controls?.setBounds({x:Math.round(area.x+area.width/2-210),y:area.y+area.height-56,width:420,height:48})
  }
  const tick = async () => {
    if (running || !preferences.enabled || disposed) return
    running = true
    try { hardware = await sample(); if (preferences.enabled && !disposed) send() } catch { hardware = null; if (!disposed) send() }
    finally { running = false }
  }
  const make = (page,interactive) => {
    const w = new BrowserWindow({show:false,frame:false,transparent:true,backgroundColor:'#00000000',hasShadow:false,
      resizable:false,movable:false,fullscreenable:false,skipTaskbar:true,focusable:interactive,width:420,height:48,
      webPreferences:{preload,partition,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:true}})
    w.setAlwaysOnTop(true,'floating')
    w.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:false})
    if (!interactive) w.setIgnoreMouseEvents(true)
    w.on('close',event=>{event.preventDefault();try {configure({enabled:false})} catch {destroy();onError('Visor settings could not be saved')} })
    w.webContents.setWindowOpenHandler(()=>({action:'deny'}))
    w.webContents.on('will-navigate',e=>e.preventDefault())
    w.webContents.on('did-finish-load',()=>{ if (preferences.enabled && !disposed) {send();w.showInactive()} })
    w.webContents.on('render-process-gone',()=>{ if (!disposed) { preferences.enabled = false; destroy();onError('Visor renderer stopped; reopen from Themes.') } })
    void w.loadURL(`nova://orb/${page}`).catch(()=>{preferences.enabled=false;destroy();onError('Visor page could not load')})
    return w
  }
  const destroy = () => {
    clearInterval(timer);timer=null; clearTimeout(closing);closing=null
    for (const w of [hud,controls]) if (alive(w)) w.destroy()
    hud=null;controls=null
  }
  const open = () => {
    clearTimeout(closing);closing=null
    if (!alive(hud)) {
      hud=make('visor.html',false);controls=make('visor-controls.html',true);layout()
    }
    send();void tick()
    if (!timer) timer=setInterval(()=>void tick(),2000)
  }
  const persist = next => {
    mkdirSync(dirname(file),{recursive:true})
    const temporary = `${file}.tmp`
    writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600})
    renameSync(temporary,file)
  }
  const configure = patch => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k=>!Object.hasOwn(preferences,k))) throw new Error('Invalid Visor settings')
    for (const [key,value] of Object.entries(patch)) {
      if (key==='mode' ? !['focus','showcase'].includes(value) : key==='opacity' ? !Number.isFinite(value)||value<.3||value>1 : typeof value!=='boolean') throw new Error('Invalid Visor setting')
    }
    const next = visorPreferences({...preferences,...patch});persist(next);preferences=next
    if (preferences.enabled) open()
    else {send();clearInterval(timer);timer=null;clearTimeout(closing);closing=setTimeout(destroy,preferences.motion?650:0)}
    return {...preferences}
  }
  screen.on('display-metrics-changed',layout);screen.on('display-added',layout);screen.on('display-removed',layout)
  nativeTheme.on('updated',send)
  return {
    start(){if(preferences.enabled)open()}, configure,
    preferences:()=>({...preferences}),
    toggle:()=>configure({enabled:!preferences.enabled}),
    owns:sender=>[hud,controls].some(w=>alive(w)&&w.webContents===sender),
    controlsOwns:sender=>alive(controls)&&controls.webContents===sender,
    snapshot:()=>({preferences,hardware,ai:readAI()}),
    showOrb:()=>onOrb(),
    windows:()=>[hud,controls],
    dispose(){disposed=true;destroy();screen.removeListener('display-metrics-changed',layout);screen.removeListener('display-added',layout);screen.removeListener('display-removed',layout);nativeTheme.removeListener('updated',send)},
  }
}
