import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
export async function waitForNativeWorkbench(window){
 for(let attempt=0;attempt<60;attempt++){
  if(window&&!window.isDestroyed()&&await window.webContents.executeJavaScript("Boolean(document.querySelector('.rail-pages [data-page=\"todos\"]'))").catch(()=>false))return
  await new Promise(resolve=>setTimeout(resolve,250))
 }
 throw Error('acceptance_workbench_not_ready')
}
export async function captureNativeWorkbench(window,outputDirectory,tag='final'){
 if(!window||window.isDestroyed())throw Error('acceptance_native_window_missing')
 const js=source=>window.webContents.executeJavaScript(source)
 const shots=[],cards={todos:0,ideas:0,goals:0},profile={work_items:0,has_about:false}
 for(const page of ['todos','ideas','goals','feeds','tasks','profile']){
  const found=await js(`(()=>{const tab=document.querySelector('.rail-pages [data-page="${page}"]');if(!tab)return false;tab.click();return true})()`)
  if(!found)throw Error('acceptance_production_tab_missing')
  await new Promise(resolve=>setTimeout(resolve,250))
  if(page==='todos'||page==='ideas'||page==='goals')cards[page]=await js("document.querySelectorAll('.workbench-suggestions > article.card').length")
  if(page==='profile')Object.assign(profile,await js("({work_items:document.querySelectorAll('.profile-work-item').length,has_about:Boolean(document.querySelector('.profile-preview')?.textContent?.trim())})"))
  const path=resolve(outputDirectory,`${tag}-${page}.png`)
  writeFileSync(path,(await window.webContents.capturePage()).toPNG(),{mode:0o600});shots.push(path)
 }
 const expanded=await js("(()=>{const section=document.querySelector('details.memory-section');if(!section)return false;section.open=true;const records=section.querySelector('details.memory-group-details');if(records)records.open=true;(records??section).scrollIntoView({block:'start'});return true})()")
 if(!expanded)throw Error('acceptance_memory_detail_missing')
 await new Promise(resolve=>setTimeout(resolve,250))
 const path=resolve(outputDirectory,`${tag}-profile-memory.png`)
 writeFileSync(path,(await window.webContents.capturePage()).toPNG(),{mode:0o600});shots.push(path)
 return {screenshots:shots,dom_cards:cards,dom_profile:profile}
}

/** Bind to the production window's partition before any page is loaded. */
export function installAcceptanceWindowGate(window,assertUrl){
 installAcceptanceSessionGate(window.webContents.session,assertUrl)
}
export function installAcceptanceSessionGate(session,assertUrl){
 session.webRequest.onBeforeRequest((details,callback)=>{
  try{assertUrl(details.url);callback({cancel:false})}catch{callback({cancel:true})}
 })
}
export function acceptanceWakeSettings(settings,enabled){
 return enabled?{...settings,wakeWordEnabled:false}:settings
}

export function acceptanceBackendSettings(settings,manifest){
 if(!manifest)return settings
 const allowed=manifest.providers?.some(provider=>provider.origin==='https://dashscope.aliyuncs.com'&&provider.models.includes('qwen3-vl-plus'))
 if(!allowed)throw Error('acceptance_text_model_missing')
 return {...settings,pipelineMode:'cascaded',cascadedLlmProvider:'qwen',cascadedLlmModels:{...settings.cascadedLlmModels,qwen:'qwen3-vl-plus'}}
}

export function waitForAcceptanceRuntimeGate(child,expected,timeoutMs=10000){
 return new Promise((resolve,reject)=>{
  const finish=error=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);error?reject(error):resolve()}
  const message=value=>{if(value?.type!=='nova:acceptance:gate-ready')return;finish(value.buildCommit===expected.buildCommit&&value.runtimeHash===expected.runtimeHash&&value.probeBlocked===true&&value.probeTransport==='fetch'&&value.blockedAttempts===1?undefined:Error('acceptance_gate_proof_mismatch'))}
  const exit=()=>finish(Error('acceptance_gate_proof_missing'))
  const timer=setTimeout(exit,timeoutMs)
  child.on('message',message);child.once('exit',exit)
 })
}
