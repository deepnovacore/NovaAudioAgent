import test from 'node:test'
import assert from 'node:assert/strict'
import {cpuSample,cpuPercent,parseBattery,visorPreferences,createHardwareSampler} from '../src/main/visor-data.mjs'
test('CPU uses interval deltas rather than lifetime totals, bounded and no division by zero',()=>{
 const a=cpuSample([{times:{idle:900,user:100,sys:0}}]),b=cpuSample([{times:{idle:950,user:150,sys:0}}])
 assert.equal(cpuPercent(a,b),50);assert.equal(cpuPercent(a,a),null)
})
test('battery handles charging, discharging and desktop computers without battery',()=>{
 assert.deepEqual(parseBattery('InternalBattery-0 86%; discharging; 3:21 remaining'),{percent:86,charging:false})
 assert.deepEqual(parseBattery('InternalBattery-0 100%; charged;'),{percent:100,charging:true})
 assert.equal(parseBattery("Now drawing from 'AC Power'"),null)
})
test('persisted theme configuration rejects unknown values and bounds opacity',()=>{
 assert.deepEqual(visorPreferences({enabled:'yes',mode:'bad',opacity:8,motion:false,script:'bad'}),{enabled:false,mode:'focus',opacity:1,motion:false,hardware:true,ai:true})
 assert.equal(visorPreferences({opacity:NaN}).opacity,.8)
})
test('real hardware sample is finite or explicitly unavailable, without credentials',async()=>{
 const value=await createHardwareSampler()();assert.ok(value.memoryTotal>0);assert.ok(value.memoryUsed>=0);assert.ok(value.disk===null||(value.disk>=0&&value.disk<=100));assert.ok(value.updatedAt>0)
})

test('Visor IPC admits only its exact windows/main frames and excludes settings from orb state reporting',async()=>{
 const {readFile}=await import('node:fs/promises'),{default:vm}=await import('node:vm')
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const handlers=new Map(),listeners=new Map(),settings={mainFrame:{}},orb={mainFrame:{}},hud={mainFrame:{}},controls={mainFrame:{}}
 const context=vm.createContext({visor:null,visorAI:null,app:{getPath:()=>'/tmp'},resolve:(...v)=>v.join('/'),packageRoot:'/tmp',
  createVisor:()=>({snapshot:()=>({ok:true}),configure:()=>true,owns:s=>s===hud||s===controls,controlsOwns:s=>s===controls,showOrb:()=>true}),
  settingsWindow:{webContents:settings},mainWindow:{webContents:orb},ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on:(name,fn)=>listeners.set(name,fn)},sourceStartupSmoke:true,sendToOrb:()=>{}})
 vm.runInContext(source.slice(source.indexOf('function initializeVisor('),source.indexOf('function toggleVisor(')),context)
 vm.runInContext("initializeVisor('test')",context)
 const event=sender=>({sender,senderFrame:sender.mainFrame})
 assert.equal(handlers.get('nova:visor:get')(event(settings)).ok,true)
 assert.throws(()=>handlers.get('nova:visor:get')({sender:settings,senderFrame:{}}),/denied/)
 assert.throws(()=>handlers.get('nova:visor:configure')(event(hud),{}),/denied/)
 assert.equal(handlers.get('nova:visor:configure')(event(controls),{}),true)
 assert.throws(()=>handlers.get('nova:visor:orb')(event(settings)),/denied/)
 const report=listeners.get('nova:visor:state')
 report(event(settings),{state:'speaking'});assert.equal(context.visorAI,null)
 report(event(orb),{state:'speaking',muted:true});assert.equal(context.visorAI.state,'speaking')
})
