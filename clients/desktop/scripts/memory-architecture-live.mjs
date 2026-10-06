import {app,BrowserWindow,ipcMain} from 'electron'
import {mkdtemp,realpath,writeFile,mkdir,readFile,readdir,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,basename,isAbsolute} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
import {PersonalAgentHost} from '../../../runtime/dist/src/personal-agent/host.js'
import {SuggestionPool} from '../../../runtime/dist/src/core/suggestions.js'
import {SubstrateMemoryResource} from '../../../runtime/dist/src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../../../runtime/dist/src/memory-ledger/store-client.js'

async function main(){
const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-memory-live-'))
const reportPath=process.env.NOVA_LIVE_MODULE_REPORT??join(dir,'report.json')
if(!isAbsolute(reportPath))throw Error('NOVA_LIVE_MODULE_REPORT must be absolute')
await mkdir(dirname(reportPath),{recursive:true});app.setPath('userData',join(dir,'electron'))
const root=fileURLToPath(new URL('../../../',import.meta.url)),ledger=join(dir,'ledger.sqlite'),personal=join(dir,'personal.json')
const report={version:1,module:'memory-desktop',layer:'desktop-live',synthetic:true,started_at:new Date().toISOString(),finished_at:null,status:'running',checks:[],errors:[],screenshots:[],data_directory:dir,coverage:['synthetic worker seed','Electron memory UI','versioned correction','new conversation','host and renderer restart','permanent purge and managed storage verification'],mechanisms:{synthetic_seed:true,real_electron_renderer:true,real_host:true,real_sqlite_markdown_git:true,model:false,microphone:false,external_messages:false}}
const persist=async()=>{await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});await chmod(reportPath,0o600)}
const check=async description=>{report.checks.push(description);await persist()}
await persist()
let host,memory,client,window,unsubscribe=()=>{},modelCalls=0
const gateway={complete:()=>{modelCalls++;throw Error('live module forbids model calls')},stream:()=>{modelCalls++;throw Error('live module forbids model calls')}}
async function open(){client=new MemoryLedgerClient(ledger);memory=new SubstrateMemoryResource({client,userId:'synthetic-memory-live',gateway,model:'disabled-live-model',inputConsent:false,consolidation:{enabled:false}});await memory.open();host=new PersonalAgentHost({path:personal,userScope:'synthetic-memory-live',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null});await host.open();unsubscribe=host.subscribe(()=>window?.webContents.send('memory-live-state',host.snapshot()))}
async function close(){unsubscribe();await host?.close();await memory?.close()}
const screenshot=async name=>{const path=join(dirname(reportPath),`${basename(reportPath)}.${name}.png`);await writeFile(path,(await window.webContents.capturePage()).toPNG(),{mode:0o600});await chmod(path,0o600);report.screenshots.push(path);await persist()}
try{
 await check('checkpoint: before-ready');await app.whenReady();await check('checkpoint: ready');await open();await check('checkpoint: host-open')
 const now=new Date().toISOString(),entryId=memory.prefix+'spicy',evidenceId=memory.prefix+'e:spicy',original='合成验收：我不吃辣',corrected='合成验收：最近可以吃一点辣'
 await client.memory('append_evidence',{id:evidenceId,source_id:memory.prefix+'s:spicy',source_kind:'conversation',locator:'synthetic-live-only',observed_at:now,recorded_at:now,raw_text:original,hash:'synthetic-live-spicy',trust:'trusted_user'})
 await client.memory('merge',{entry_id:entryId,kind:'preference',origin:'stated',written_by:'merge',evidence_refs:[evidenceId],content:{text:original,topic:'饮食'},recorded_at:now})
 const retainedRows=(await client.memory('list',{})).filter(row=>row.entry_id!==entryId);const retainedFiles=await readdir(join(ledger+'.memory','entries'));
 await host.refreshMemory();await check('deterministic synthetic seed through real worker evidence and merge')
 ipcMain.handle('memory-live-command',async(_event,frame)=>{assert.equal(frame.type,'personal.command');const result=await host.command(frame);if(result?.ok===false)report.errors.push(JSON.stringify(result));return result})
 ipcMain.handle('memory-live-state',()=>host.snapshot())
 const preload=join(dir,'preload.cjs');await writeFile(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('memoryLive',{command:f=>ipcRenderer.invoke('memory-live-command',f),state:()=>ipcRenderer.invoke('memory-live-state'),listen:cb=>ipcRenderer.on('memory-live-state',(_,f)=>cb(f))});")
 const module=pathToFileURL(join(root,'clients/desktop/src/renderer/personal-view.mjs')).href,css=pathToFileURL(join(root,'clients/desktop/src/renderer/workbench.css')).href
 const html=join(dir,'index.html');await writeFile(html,`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${css}"><div id="shell"></div><script type="module">import {mountPersonalView} from '${module}';window.view=mountPersonalView({send:f=>{window.memoryLive.command(f).then(r=>window.view.receive(r));return true},start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction:()=>{},results:()=>[],openResults:()=>{},api:{personal:{setUnread(){},openArticle(){throw Error('external navigation forbidden')}},orbMenu:{openSettings(){}}}});window.view.controller.connect();window.view.receive({type:'client.ready',input_instance_id:'synthetic-memory-live',capabilities:['text_input']});window.memoryLive.listen(f=>window.view.receive(f));window.view.receive(await window.memoryLive.state());window.ready=true;</script>`)
 window=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}})
 window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)report.errors.push(message)})
 const js=code=>window.webContents.executeJavaScript(code)
 const wait=async predicate=>{for(let n=0;n<400;n++){if(await js(predicate))return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error('UI wait failed: '+predicate)}
 const click=label=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)throw Error('missing button');b.click();b.blur()})()`)
 const clickEntry=(text,label)=>js(`(()=>{const card=[...document.querySelectorAll('.memory-entry-details')].find(node=>node.textContent.includes(${JSON.stringify(text)}));const button=[...card.querySelectorAll('button')].find(node=>node.textContent===${JSON.stringify(label)});if(!button)throw Error('missing entry action');button.click()})()` )
 const memoryPage=async()=>{await click('Profile');await js("document.querySelectorAll('.memory-section,.memory-group-details').forEach(d=>d.open=true)")}
 await window.loadFile(html);await wait('window.ready===true');await memoryPage();await wait(`document.querySelector('.workbench-page').textContent.includes(${JSON.stringify(original)})`);await screenshot('original');await check('actual renderer memory page displays synthetic stored entry')
 await clickEntry(original,'纠正');await js(`(()=>{const field=document.querySelector('[aria-label="纠正记忆内容"]:not([hidden])');field.value=${JSON.stringify(corrected)};field.dispatchEvent(new Event('input',{bubbles:true}))})()`);await clickEntry(original,'保存纠正');await wait(`window.view.controller.snapshot.memory.entries.some(row=>row.content===${JSON.stringify(corrected)})`)
 assert.equal((await memory.get(entryId)).version,2);await screenshot('corrected');await check('renderer correction updates same entry and version immediately')
 const previous=host.snapshot().conversations.selected_id;await click('新对话');await wait(`window.view.controller.snapshot.conversations.selected_id!==${JSON.stringify(previous)}`);assert.equal((await memory.get(entryId)).content,corrected);await check('new UI conversation sees same corrected memory; no generated reply or model claim')
 await close();await open();await window.loadFile(html);await wait('window.ready===true');await memoryPage();await wait(`window.view.controller.snapshot.memory.entries.some(row=>row.content===${JSON.stringify(corrected)})`);assert.equal((await memory.get(entryId)).version,2);await screenshot('reopened');await check('host/resource reopen and renderer reload retain correction without restoring old state')
 await clickEntry(corrected,'彻底删除');await wait("[...document.querySelectorAll('[aria-label=\"确认彻底删除记忆\"]')].some(node=>!node.hidden)");await screenshot('purge-confirmation');await clickEntry(corrected,'确认彻底删除');await wait(`!window.view.controller.snapshot.memory.entries.some(row=>row.id===${JSON.stringify(entryId)}) && (window.view.controller.snapshot.memory.pending_purges??[]).length===0`)
 assert.equal(await client.memory('evidence',{id:evidenceId}),null);assert.deepEqual(await client.memory('history',{entry_id:entryId}),[]);assert.deepEqual(await client.memory('list',{}),retainedRows)
 assert.equal(execFileSync('git',['-C',ledger+'.memory','rev-list','--count','HEAD'],{encoding:'utf8'}).trim(),'1');assert.equal(execFileSync('git',['-C',ledger+'.memory','fsck','--no-reflogs','--unreachable'],{encoding:'utf8'}).trim(),'');assert.equal((await readdir(join(ledger+'.memory','entries'))).length,retainedFiles.length-1)
 await screenshot('purged');await check('actual delete confirmation removes target from UI, ledger and Git history while preserving other objects')
 await close();host=undefined;memory=undefined
 const bytes=await readFile(ledger);assert.equal(bytes.includes(Buffer.from(original)),false);assert.equal(bytes.includes(Buffer.from(corrected)),false);assert.equal(modelCalls,0);assert.deepEqual(report.errors,[])
 await check('closed SQLite bytes contain neither original nor correction; zero model calls');report.status='passed'
}catch(error){report.status='failed';report.errors.push(error.stack??String(error));if(window)await screenshot('failure').catch(()=>{})}
finally{await close().catch(error=>{report.status='failed';report.errors.push(String(error))});report.finished_at=new Date().toISOString();await persist();console.log(JSON.stringify({status:report.status,report:reportPath}));window?.destroy();app.exit(report.status==='passed'?0:1)}

}
void main().catch(error=>{console.error(error);app.exit(1)})
