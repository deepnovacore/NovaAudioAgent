import {app,BrowserWindow,ipcMain} from 'electron'
import {mkdtemp,realpath,writeFile,copyFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import assert from 'node:assert/strict'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {PersonalAgentHost} from '../../../runtime/dist/src/personal-agent/host.js'
import {createUnderstandingPipeline} from '../../../runtime/dist/src/understanding/pipeline.js'
import {createJevJudge} from '../../../runtime/dist/src/understanding/jev.js'
import {createJevNewsRanker} from '../../../runtime/dist/src/news/jev-ranking.js'
import {loadSettings,resolveModelApiKey} from '../../../runtime/dist/src/config/config.js'
import {OpenAIModelGateway} from '../../../runtime/dist/src/model/model-gateway.js'
import {RealClock} from '../../../runtime/dist/src/core/clock.js'
import {SuggestionPool} from '../../../runtime/dist/src/core/suggestions.js'
import {newsArticleUrl} from '../src/main/security.mjs'
async function main(){
const root=fileURLToPath(new URL('../../../',import.meta.url)),output=resolve(process.env.NOVA_SPACE_LIVE_OUTPUT??join(root,'output/personal-space-live'))
await mkdir(output,{recursive:true});const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-space-electron-'));app.setPath('userData',join(dir,'electron'))
const path=join(dir,'personal.json'),newsData=process.env.NOVA_SPACE_NEWS_DATA
if(newsData)await copyFile(newsData,path+'.news.json')
let understand,rankNews,extractionModel
if(process.env.NOVA_SPACE_LIVE_MODEL==='1'){
 process.loadEnvFile(process.env.NOVA_SPACE_ENV_FILE);if(process.env.NOVA_SPACE_JEV_ENV_FILE)process.loadEnvFile(process.env.NOVA_SPACE_JEV_ENV_FILE)
 const settings=loadSettings(),key=resolveModelApiKey(settings);extractionModel=settings.fast_model;assert.ok(key,'model credentials required')
 const gateway=new OpenAIModelGateway({baseUrl:settings.model_base_url,apiKey:key,clock:new RealClock()});const jev={apiKey:settings.openrouter_api_key??''};understand=createUnderstandingPipeline({gateway,model:settings.fast_model,judge:createJevJudge(jev)});const rank=createJevNewsRanker(jev);rankNews=async(...args)=>{try{return await rank(...args)}catch(error){console.log('news ranking rejected:',error.name,String(error.message).slice(0,500));throw error}}
}
const make=()=>new PersonalAgentHost({path,userScope:'synthetic-live',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null,...(understand?{understand,rankNews}:{})})
let host=make(),window;const report={extraction_model:extractionModel??null,judgment_model:understand?'typesafe/jev-1.13':null,checks:[],errors:[],opened:[],data_directory:dir,news_provenance:newsData??null}
await app.whenReady();console.log('electron ready');await host.open();console.log('host ready');if(host.news.snapshot().interests.length)await host.news.configure({enabled:false,explore:true,interests:host.news.snapshot().interests.map(i=>i.text)})
let unsubscribe=()=>{};function subscribe(){unsubscribe=host.subscribe(()=>window?.webContents.send('space-frame',host.snapshot()))}
ipcMain.handle('space-command',async(_event,frame)=>{if(frame.type==='input.text'){await host.submitConversationText(frame.conversation_id,frame.text,frame.request_id);return {type:'input.text_result',request_id:frame.request_id,ok:true}}return host.command(frame)})
ipcMain.handle('space-state',()=>host.snapshot())
ipcMain.handle('space-open',(_event,url)=>{report.opened.push(newsArticleUrl(url));return true})
const preload=join(dir,'preload.cjs');await writeFile(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('space',{command:f=>ipcRenderer.invoke('space-command',f),state:()=>ipcRenderer.invoke('space-state'),open:u=>ipcRenderer.invoke('space-open',u),listen:cb=>ipcRenderer.on('space-frame',(_,f)=>cb(f))});")
const module=pathToFileURL(join(root,'clients/desktop/src/renderer/personal-view.mjs')).href,css=pathToFileURL(join(root,'clients/desktop/src/renderer/workbench.css')).href
const html=join(dir,'index.html');await writeFile(html,`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${css}"><div id="shell"></div><script type="module">import {mountPersonalView} from '${module}';window.view=mountPersonalView({send:f=>{window.space.command(f).then(r=>window.view.receive(r));return true},start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction:()=>{},results:()=>[],openResults:()=>{},api:{personal:{setUnread(){},openArticle:u=>window.space.open(u)},orbMenu:{openSettings(){}}}});window.view.controller.connect();window.view.receive({type:'client.ready',input_instance_id:'synthetic-live-input',capabilities:['text_input']});window.space.listen(f=>window.view.receive(f));window.view.receive(await window.space.state());window.ready=true;</script>`)
await app.whenReady();window=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});subscribe();window.webContents.on('console-message',(_e,level,message)=>{if(level>=3)report.errors.push(message)})
const js=code=>window.webContents.executeJavaScript(code)
const wait=async predicate=>{for(let i=0;i<4000;i++){if(await js(predicate))return;await new Promise(r=>setTimeout(r,50))}throw Error('UI wait failed: '+predicate)}
const click=label=>js(`(()=>{const b=[...document.querySelectorAll('button')].findLast(b=>b.textContent===${JSON.stringify(label)});if(!b)throw Error('missing button '+${JSON.stringify(label)});b.click();b.blur()})()`)
const fill=(label,value)=>js(`(()=>{const i=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');if(!i)throw Error('missing input');i.value=${JSON.stringify(value)};i.dispatchEvent(new Event('input',{bubbles:true}));i.blur()})()`)
try{
 await window.loadFile(html);await wait('window.ready===true')
 assert.deepEqual(await js("[...document.querySelectorAll('.rail-pages button')].map(b=>b.textContent)"),['Todos','Ideas','Goals','Feeds','任务','Profile']);assert.equal(await js("[...document.querySelectorAll('button')].some(b=>b.textContent==='整理最新发言')"),false);report.checks.push('five real renderer tabs mounted in Electron, no extraction button')
 await click('Goals');await click('添加目标');await fill('目标标题','学习日语');await fill('怎样算达成','能独立完成旅行日常对话');await click('保存');await wait("window.view.controller.snapshot.life.goals.length===1")
 await click('Ideas');await click('添加想法');await fill('想法标题','每天十分钟听力');await fill('补充说明','从旅行场景开始');await click('保存');await wait('window.view.controller.snapshot.life.ideas.length===1')
 await click('转为待办');await wait('window.view.controller.snapshot.life.todos.length===1');const idea=host.life.snapshot().ideas[0];await host.command({type:'personal.command',request_id:'repeat-convert',method:'life.mutate',params:{op:'convert',id:idea.id,target:'todo',expected_version:idea.version}});assert.equal(host.life.snapshot().todos.length,1);report.checks.push('idea creation and idempotent conversion')
 await click('Todos');await click('编辑');const goal=host.life.snapshot().goals[0];await js(`(()=>{const i=document.querySelector('[aria-label="关联目标"]');i.value=${JSON.stringify(goal.id)};i.dispatchEvent(new Event('change',{bubbles:true}));i.blur()})()`);await click('保存修改');await wait('window.view.controller.snapshot.life.todos[0].goal_id!==null')
 await js("(()=>{const i=document.querySelector('[aria-label=\"每天十分钟听力状态\"]');i.value='done';i.dispatchEvent(new Event('change',{bubbles:true}));i.blur()})()");await wait("window.view.controller.snapshot.life.todos[0].status==='done'")
 await click('Goals');assert.ok(await js("document.querySelector('.workbench-page').textContent.includes('1/1')"));assert.equal(host.life.snapshot().goals[0].status,'active');report.checks.push('todo edit/completion and explicit goal completion boundary')
 await click('Profile');await click('自己写一段');await fill('关于我','验收专用：喜欢语言学习和科技资讯');await click('保存介绍');await wait("window.view.controller.snapshot.life.profile.about.includes('验收专用')");report.checks.push('profile editing')
 await click('Feeds');if(newsData){await wait("document.querySelectorAll('.news-card').length>0");await click('阅读原文');await wait('window.view.controller.snapshot.news.items.some(i=>i.read)');assert.equal(report.opened.length,1);report.checks.push('real acquired news rendered, article-open IPC validated (external browser intercepted)');await click('收藏');await wait('window.view.controller.snapshot.news.saved.length>0');report.checks.push('news save action persisted')}
 await click('Feeds');await wait("document.querySelector('.workbench-page h2')?.textContent.includes('Feeds')");await new Promise(r=>setTimeout(r,150));
 await writeFile(join(output,'five-tabs.png'),(await window.webContents.capturePage()).toPNG())
 unsubscribe();await host.close();host=make();await host.open();subscribe();await window.loadFile(html);await wait('window.ready===true');assert.equal(host.life.snapshot().todos[0].status,'done');assert.equal(host.life.snapshot().goals[0].progress.done,1);assert.ok(host.life.snapshot().profile.about.includes('验收专用'));report.checks.push('runtime reopen and renderer reload preserve all personal objects')
 if(understand){host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'收到'}),close:()=>Promise.resolve()}),()=>{});await fill('消息草稿','请记下明天比较三门日语课。');await click('↑');console.log('synthetic user message sent');await wait("window.view.controller.snapshot.understanding.status==='ready'");await wait('window.view.controller.snapshot.life.todos.length===2');assert.ok(host.understanding.snapshot().recorded.length);await wait("document.querySelector('.workbench-page').textContent.includes('已记下待办')");await click('撤销记录');await wait('window.view.controller.snapshot.life.todos.length===1');report.checks.push('new message automatically captured by real model and undone through Electron; conversation reply is a test stub')
  await click('Profile');await click('开启资讯');await wait('window.view.controller.snapshot.news.enabled===true');await click('Feeds');await wait("window.view.controller.snapshot.news.mode==='personalized'&&!window.view.controller.snapshot.news.refreshing");assert.ok(host.news.snapshot().items.some(i=>i.ranking));report.news_status={rank_error:host.news.snapshot().rank_error,pending:host.news.snapshot().pending,sources:host.news.snapshot().sources};report.checks.push('Profile interests -> real RSS/model refresh -> visible personalized Feeds via actual Electron commands');await writeFile(join(output,'five-tabs.png'),(await window.webContents.capturePage()).toPNG())
}

 report.status='passed'
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1}
finally{unsubscribe();await host.close();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));window.destroy();app.exit(report.status==='passed'?0:1)}

}
void main().catch(error=>{console.error(error);app.exit(1)})
