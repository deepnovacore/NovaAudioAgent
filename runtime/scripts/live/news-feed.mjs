import assert from 'node:assert/strict'
import {mkdir,writeFile,realpath,chmod} from 'node:fs/promises'
import {resolve} from 'node:path'
import {NewsService} from '../../dist/src/news/service.js'
import {createJevNewsRanker} from '../../dist/src/news/jev-ranking.js'
import {loadSettings} from '../../dist/src/config/config.js'
const output=resolve(process.argv[2]??'output/news-live');await mkdir(output,{recursive:true,mode:0o700});await chmod(output,0o700);const directory=await realpath(output)
const settings=loadSettings();assert.ok(settings.openrouter_api_key,'OpenRouter credential required')
const report={model:'typesafe/jev-1.13',started_at:new Date().toISOString(),checks:[],sources:[],limitations:['No 24-hour soak or human-blinded relevance evaluation in this run.','Synthetic explicit interests only; no private profile or memory opened.']}
const rank=createJevNewsRanker({apiKey:settings.openrouter_api_key??''})
const make=()=>new NewsService({path:directory+'/news.json',rank:async(...args)=>{try{return await rank(...args)}catch(error){report.ranking_error={name:error.name,message:String(error.message).slice(0,500)};throw error}}})
let service=make();await service.open()
try{
 await service.configure({enabled:true,interests:['人工智能和语音交互','科技产品与创业'],explore:true});await service.refresh()
 let snapshot=service.snapshot();report.sources=snapshot.sources;report.pending=snapshot.pending;report.mode=snapshot.mode;report.top_ids=snapshot.items.map(i=>i.id)
 assert.ok(snapshot.total>0,'no real articles');report.checks.push('real RSS acquisition');
 assert.ok(snapshot.items.some(a=>a.ranking),'no validated real model rankings');report.checks.push('real model ranking with validated interest IDs and excerpt quotes')
 const article=snapshot.items[0];await service.action({action:'save',id:article.id,value:true});await service.action({action:'read',id:article.id,value:true})
 const before=JSON.stringify(snapshot.interests);assert.equal(JSON.stringify(service.snapshot().interests),before);report.checks.push('read/save do not change explicit interests')
 const topic=snapshot.interests[0];await service.action({action:'weight',interest_id:topic.id,value:0.5});assert.equal(service.snapshot().interests[0].weight,0.5)
 await service.close();service=make();await service.open();snapshot=service.snapshot();assert.ok(snapshot.saved.find(a=>a.id===article.id)?.read);assert.equal(snapshot.interests[0].weight,0.5);report.checks.push('feedback and read/save survive reopen')
 await service.action({action:'block',source_id:article.source_id,value:true});assert.ok(service.snapshot().items.every(a=>a.source_id!==article.source_id));await service.action({action:'block',source_id:article.source_id,value:false});report.checks.push('blocked source excluded')
 report.finished_at=new Date().toISOString();report.status='passed';await writeFile(directory+'/snapshot.json',JSON.stringify(service.snapshot(),null,2))
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1}finally{await service.close();await writeFile(directory+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))}
