import {app,BrowserWindow,ipcMain} from 'electron'
import {mkdtemp,realpath,writeFile,mkdir,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,basename,isAbsolute} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {PersonalAgentHost} from '../../../runtime/dist/src/personal-agent/host.js'
import {SuggestionPool} from '../../../runtime/dist/src/core/suggestions.js'
import {SubstrateMemoryResource} from '../../../runtime/dist/src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../../../runtime/dist/src/memory-ledger/store-client.js'

async function main(){
const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-life-desktop-live-'))
const reportPath=process.env.NOVA_LIVE_MODULE_REPORT??join(dir,'report.json')
if(!isAbsolute(reportPath))throw Error('NOVA_LIVE_MODULE_REPORT must be absolute')
await mkdir(dirname(reportPath),{recursive:true});app.setPath('userData',join(dir,'electron'))
const root=fileURLToPath(new URL('../../../',import.meta.url)),ledger=join(dir,'ledger.sqlite'),personal=join(dir,'personal.json')
const report={version:1,module:'life-desktop',layer:'desktop-live',synthetic:true,started_at:new Date().toISOString(),finished_at:null,status:'running',checks:[],errors:[],screenshots:[],data_directory:dir,coverage:['actual renderer news conversion','Life date/status editing','public source display','host and renderer restart'],mechanisms:{synthetic_seed:true,real_electron_renderer:true,real_host:true,real_sqlite_markdown_git:true,model:false,microphone:false,external_messages:false}}
const persist=async()=>{await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});await chmod(reportPath,0o600)}
const check=async description=>{report.checks.push(description);await persist()}
await persist()
let host,memory,client,window,unsubscribe=()=>{},modelCalls=0
const gateway={complete:()=>{modelCalls++;throw Error('live module forbids model calls')},stream:()=>{modelCalls++;throw Error('live module forbids model calls')}}
async function open(){client=new MemoryLedgerClient(ledger);memory=new SubstrateMemoryResource({client,userId:'synthetic-memory-live',gateway,model:'disabled-live-model',inputConsent:false,consolidation:{enabled:false}});await memory.open();host=new PersonalAgentHost({path:personal,userScope:'synthetic-memory-live',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null});await host.open();unsubscribe=host.subscribe(()=>window?.webContents.send('memory-live-state',host.snapshot()))}
async function close(){unsubscribe();await host?.close();await memory?.close()}
const screenshot=async name=>{if(name!=='conversion-draft')await window.webContents.executeJavaScript("document.querySelector('[data-life-id]')?.scrollIntoView({block:'center'})");await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const path=join(dirname(reportPath),`${basename(reportPath)}.${name}.png`);await writeFile(path,(await window.webContents.capturePage()).toPNG(),{mode:0o600});await chmod(path,0o600);report.screenshots.push(path);await persist()}
try{
 await check('checkpoint: before-ready');await app.whenReady();await check('checkpoint: ready');await open();await check('checkpoint: host-open')
 host.news.options.fetcher=async()=>new Response('<rss><channel><item><title>Synthetic public article</title><link>https://example.com/synthetic</link><description>Public fixture, not a user fact.</description></item></channel></rss>')
 await host.news.configure({enabled:true,explore:false,interests:['synthetic']});await host.news.refresh();await host.news.configure({enabled:false,explore:false,interests:['synthetic']})
 assert.ok(host.news.snapshot().items.length);await check('synthetic RSS cached by real News service with network disabled')
 ipcMain.handle('memory-live-command',async(_event,frame)=>{assert.equal(frame.type,'personal.command');const result=await host.command(frame);if(result?.ok===false)report.errors.push(JSON.stringify(result));return result})
 ipcMain.handle('memory-live-state',()=>host.snapshot())
 const preload=join(dir,'preload.cjs');await writeFile(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('memoryLive',{command:f=>ipcRenderer.invoke('memory-live-command',f),state:()=>ipcRenderer.invoke('memory-live-state'),listen:cb=>ipcRenderer.on('memory-live-state',(_,f)=>cb(f))});")
 const module=pathToFileURL(join(root,'clients/desktop/src/renderer/personal-view.mjs')).href,css=pathToFileURL(join(root,'clients/desktop/src/renderer/workbench.css')).href
 const html=join(dir,'index.html');await writeFile(html,`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${css}"><div id="shell"></div><script type="module">import {mountPersonalView} from '${module}';window.view=mountPersonalView({send:f=>{window.memoryLive.command(f).then(r=>window.view.receive(r));return true},start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction:()=>{},results:()=>[],openResults:()=>{},api:{personal:{setUnread(){},openArticle(){throw Error('external navigation forbidden')}},orbMenu:{openSettings(){}}}});window.view.controller.connect();window.view.receive({type:'client.ready',input_instance_id:'synthetic-memory-live',capabilities:['text_input']});window.memoryLive.listen(f=>window.view.receive(f));window.view.receive(await window.memoryLive.state());window.ready=true;</script>`)
 window=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}})
 window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)report.errors.push(message)})
 const js=code=>window.webContents.executeJavaScript(code)
 const wait=async predicate=>{for(let n=0;n<400;n++){if(await js(predicate))return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error('UI wait failed: '+predicate)}
 const click=label=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)throw Error('missing button');b.click();b.blur()})()`)
 const field=(label,value,event='input')=>js(`(()=>{const node=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');if(!node)throw Error('missing field');node.value=${JSON.stringify(value)};node.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}))})()`)
 await window.loadFile(html);await wait('window.ready===true');await click('Feeds');await wait("document.querySelectorAll('.news-card').length>0")
 await click('转为个人事项');await field('个人事项类型','todo','change');await field('个人事项标题','Synthetic read article');await field('我的补充说明','My own plan')
 assert.equal(host.life.snapshot().todos.length,0);await screenshot('conversion-draft');await click('保存个人事项');await wait('window.view.controller.snapshot.life.todos.length===1')
 const id=host.life.snapshot().todos[0].id;assert.equal(host.life.snapshot().todos[0].title,'Synthetic read article');await check('renderer conversion waits for explicit save and preserves user-authored title')
 await click('Todos');await wait("document.querySelector('.workbench-page').textContent.includes('由你从公开资讯保存')");await screenshot('source-visible')
 await click('编辑');await field('到期日期','2026-10-03');await click('保存修改');await wait("window.view.controller.snapshot.life.todos[0].due==='2026-10-03'")
 await field('Synthetic read article状态','done','change');await wait("window.view.controller.snapshot.life.todos[0].status==='done'")
 assert.equal((await host.discoverySnapshot()).memory.some(row=>row.life?.id===id),false)
 await click('显示已完成／归档');await wait("document.querySelector('.workbench-page').textContent.includes('Synthetic read article')");await screenshot('completed');await check('native date/status controls persist same object and remove it from discovery')
 await close();await open();await window.loadFile(html);await wait('window.ready===true');await click('Todos');await click('显示已完成／归档');await wait("document.querySelector('.workbench-page').textContent.includes('Synthetic read article')")
 const todo=host.life.snapshot().todos[0];assert.equal(todo.id,id);assert.equal(todo.status,'done');assert.equal(todo.due,'2026-10-03');assert.equal(todo.news_source.url,'https://example.com/synthetic');await screenshot('reopened');await check('host/resource and renderer restart retain source, date, completion and stable ID')
 await close();host=undefined;memory=undefined
 assert.equal(modelCalls,0);assert.deepEqual(report.errors,[]);await check('zero model calls or external navigation');report.status='passed'
}catch(error){report.status='failed';report.errors.push(error.stack??String(error));if(window)await screenshot('failure').catch(()=>{})}
finally{await close().catch(error=>{report.status='failed';report.errors.push(String(error))});report.finished_at=new Date().toISOString();await persist();console.log(JSON.stringify({status:report.status,report:reportPath}));window?.destroy();app.exit(report.status==='passed'?0:1)}

}
void main().catch(error=>{console.error(error);app.exit(1)})
