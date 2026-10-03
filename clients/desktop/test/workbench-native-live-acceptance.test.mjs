import test from 'node:test'
import assert from 'node:assert/strict'
import {assertOriginalProfilePaths, assertNoProfileLock, countOnlyReport, assertProvider} from '../scripts/workbench-native-live-acceptance.mjs'
const original={userData:'/tmp/daily-electron',blackboardPath:'/tmp/daily-runtime/blackboard.sqlite'}
test('separate original Electron and runtime identities, never a profile copy',()=>{
 assert.doesNotThrow(()=>assertOriginalProfilePaths(original,original))
 assert.throws(()=>assertOriginalProfilePaths({...original,userData:'/tmp/copy'},original),/user_data/)
 assert.throws(()=>assertOriginalProfilePaths({...original,blackboardPath:'/tmp/copy/blackboard.sqlite'},original),/blackboard/)
})
test('held profile lock is rejected',()=>assert.throws(()=>assertNoProfileLock(true),/profile_locked/))
test('provider identity must be explicitly authorized',()=>{
 assert.throws(()=>assertProvider('unknown',['known']),/provider_not_authorized/)
 assert.doesNotThrow(()=>assertProvider('known',['known']))
})
test('count-only report separates DOM cards from source-grounded cards and cannot copy private fields',()=>{
 const report=countOnlyReport({build_commit:'a'.repeat(40),profile_hash:'b'.repeat(64),pre_sources:1,post_sources:2,eligible_candidates:3,model_calls:4,todos:5,ideas:6,goals:1,source_grounded_cards:3,source_grounded_todos:1,source_grounded_ideas:1,source_grounded_goals:1,remaining_queue:7,screenshots:['/tmp/evidence/todos.png'],privateExcerpt:'PRIVATE EXCERPT'})
 assert.equal(report.profile_kind,'original');assert.equal(report.native_main,true)
 assert.equal(report.source_to_card.dom_rendered,report.dom_cards.todos+report.dom_cards.ideas+report.dom_cards.goals)
 assert.equal(report.source_to_card.verified_source_grounded,3)
 assert.deepEqual(report.source_to_card.verified_source_grounded_by_tab,{todos:1,ideas:1,goals:1})
 assert.equal(JSON.stringify(report).includes('PRIVATE EXCERPT'),false)
 assert.throws(()=>countOnlyReport({build_commit:'a'.repeat(40),profile_hash:'b'.repeat(64),pre_sources:0,post_sources:0,eligible_candidates:0,model_calls:0,todos:0,ideas:0,goals:0,source_grounded_cards:1,source_grounded_todos:0,source_grounded_ideas:0,source_grounded_goals:0,remaining_queue:0,screenshots:[]}),/source_card_count_mismatch/)
 assert.equal(countOnlyReport({build_commit:'a'.repeat(40),profile_hash:'b'.repeat(64),pre_sources:0,post_sources:0,eligible_candidates:0,model_calls:0,todos:0,ideas:0,goals:0,source_grounded_cards:0,source_grounded_todos:0,source_grounded_ideas:0,source_grounded_goals:0,remaining_queue:0,screenshots:[]}).source_to_card.verified_source_grounded,0)
})

test('harness cannot replace the profile, delete context, or construct a window',async()=>{
 const {readFile}=await import('node:fs/promises')
 for(const path of ['../scripts/workbench-native-live-acceptance.mjs','../src/main/workbench-native-acceptance.mjs']){
  const source=await readFile(new URL(path,import.meta.url),'utf8')
  assert.doesNotMatch(source,/copyFile|cpSync|rmSync|unlink|setPath|new BrowserWindow/u)
 }
})

test('a held Electron singleton is rejected using a synthetic profile directory',async()=>{
 const {mkdtempSync,mkdirSync,symlinkSync,rmSync}=await import('node:fs')
 const {tmpdir}=await import('node:os')
 const {join}=await import('node:path')
 const {preflightLocks}=await import('../scripts/workbench-native-live-acceptance.mjs')
 const root=mkdtempSync(join(tmpdir(),'native-lock-test-'))
 try{
  mkdirSync(join(root,'electron'))
  symlinkSync('synthetic-owner',join(root,'electron/SingletonLock'))
  assert.throws(()=>preflightLocks({originalUserData:join(root,'electron'),originalBlackboardPath:join(root,'blackboard.sqlite')},()=>''),/profile_locked/)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('Chromium gate covers default and actual production sessions and counts both blocked requests',async()=>{
 const {installAcceptanceWindowGate,installAcceptanceSessionGate}=await import('../src/main/workbench-native-acceptance.mjs')
 const {browserWindowOptions}=await import('../src/main/security.mjs')
 const partition=browserWindowOptions('/synthetic/preload','synthetic').webPreferences.partition
 const sessions=new Map([[partition,{webRequest:{onBeforeRequest(handler){this.handler=handler}}}],['default',{webRequest:{onBeforeRequest(handler){this.handler=handler}}}]])
 let blocked=0
 installAcceptanceWindowGate({webContents:{session:sessions.get(partition)}},url=>{if(url!=='nova://orb/index.html'){blocked++;throw Error('blocked')}})
 installAcceptanceSessionGate(sessions.get('default'),()=>{blocked++;throw Error('blocked')})
 sessions.get('default').webRequest.handler({url:'https://unknown.invalid'},decision=>assert.equal(decision.cancel,true))
 const handler=sessions.get(partition).webRequest.handler
 handler({url:'https://unknown.invalid'},decision=>assert.equal(decision.cancel,true))
 handler({url:'nova://orb/index.html'},decision=>assert.equal(decision.cancel,false))
 assert.equal(blocked,2)
})
test('initial acceptance wake configuration starts no worker and does not change saved settings',async()=>{
 const {acceptanceWakeSettings}=await import('../src/main/workbench-native-acceptance.mjs')
 const {WakeWordRuntime}=await import('../src/main/wake-word/runtime.mjs')
 let workers=0
 const wake=new WakeWordRuntime({modelRoot:'/synthetic/models',WorkerClass:class{constructor(){workers++;throw Error('worker must not start')}}})
 const saved=Object.freeze({wakeWordEnabled:true,autoHideSeconds:30})
 wake.configure(acceptanceWakeSettings(saved,true));wake.start()
 assert.equal(workers,0);assert.equal(wake.status,'off');assert.equal(saved.wakeWordEnabled,true)
 assert.equal(acceptanceWakeSettings(saved,false),saved)
})
test('acceptance text backend uses only the granted Dashscope model without changing saved settings',async()=>{
 const {acceptanceBackendSettings}=await import('../src/main/workbench-native-acceptance.mjs')
 const saved=Object.freeze({pipelineMode:'cascaded',cascadedLlmProvider:'deepseek',cascadedLlmModels:Object.freeze({deepseek:'deepseek-flash',qwen:'qwen3.8-max'})})
 const grant={providers:[{origin:'https://dashscope.aliyuncs.com',models:['qwen3-vl-plus']}],allowedIdentities:['granted']}
 const projected=acceptanceBackendSettings(saved,grant)
 assert.equal(projected.pipelineMode,'cascaded')
 assert.equal(projected.cascadedLlmProvider,'qwen')
 assert.equal(projected.cascadedLlmModels.qwen,'qwen3-vl-plus')
 assert.equal(saved.cascadedLlmProvider,'deepseek')
 assert.equal(saved.cascadedLlmModels.qwen,'qwen3.8-max')
 assert.equal(acceptanceBackendSettings(saved,null),saved)
 assert.throws(()=>acceptanceBackendSettings(saved,{providers:[]}),/acceptance_text_model_missing/)
})

test('partial lsof errors still reject an observed owner PID',async()=>{
 const {preflightLocks}=await import('../scripts/workbench-native-live-acceptance.mjs')
 assert.throws(()=>preflightLocks({originalUserData:'/synthetic',originalBlackboardPath:'/synthetic/blackboard.sqlite'},()=>{throw Object.assign(Error('partial paths'),{status:1,stdout:'1234\n'})}),/profile_locked/)
})
test('runtime gate proof is mandatory and bound to this build',async()=>{
 const {EventEmitter}=await import('node:events')
 const {waitForAcceptanceRuntimeGate}=await import('../src/main/workbench-native-acceptance.mjs')
 const child=new EventEmitter(),expected={buildCommit:'a'.repeat(40),runtimeHash:'c'.repeat(64)}
 const valid={type:'nova:acceptance:gate-ready',...expected,probeBlocked:true,probeTransport:'fetch',blockedAttempts:1}
 const proof=waitForAcceptanceRuntimeGate(child,expected,20)
 child.emit('message',valid)
 await proof
 await assert.rejects(waitForAcceptanceRuntimeGate(new EventEmitter(),expected,5),/gate_proof_missing/)
 for(const mismatch of [{buildCommit:'b'.repeat(40)},{runtimeHash:'d'.repeat(64)},{probeTransport:'assertion'},{blockedAttempts:0}]){
  const wrong=new EventEmitter(),bad=waitForAcceptanceRuntimeGate(wrong,expected,20)
  wrong.emit('message',{...valid,...mismatch})
  await assert.rejects(bad,/gate_proof_mismatch/)
 }
})

test('stale capture manifests and PNGs cannot satisfy a new acceptance run',async()=>{
 const {mkdtempSync,writeFileSync,unlinkSync,rmSync}=await import('node:fs')
 const {tmpdir}=await import('node:os')
 const {join}=await import('node:path')
 const {assertFreshArtifacts}=await import('../scripts/workbench-native-live-acceptance.mjs')
 const root=mkdtempSync(join(tmpdir(),'native-fresh-test-'))
 try{for(const name of ['capture.json','final-todos.png','initial-profile.png','counts.ndjson','report.json','native.log']){writeFileSync(join(root,name),'stale');assert.throws(()=>assertFreshArtifacts(root),/fresh_output_required/);unlinkSync(join(root,name))}assert.doesNotThrow(()=>assertFreshArtifacts(root))}finally{rmSync(root,{recursive:true,force:true})}
})
test('production main installs partition gate before loading and overrides every wake configuration',async()=>{
 const {readFile}=await import('node:fs/promises')
 const main=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const creation=main.slice(main.indexOf('async function createWindow('),main.indexOf('function openMemoryBoard('))
 assert.match(creation,/installAcceptanceWindowGate\(window,assertAcceptanceUrl\)/u)
 assert.match(main,/installAcceptanceSessionGate\(session\.defaultSession,assertAcceptanceUrl\)/u)
 assert.doesNotMatch(main,/wakeWord\??\.configure\(currentSettings\)/u)
 assert.equal([...main.matchAll(/wakeWord\??\.configure\(acceptanceWakeSettings/g)].length,3)
})
