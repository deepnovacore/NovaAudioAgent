/** Launches the package's NORMAL main entry with a controller-attested original profile. */
import {spawn,execFileSync} from 'node:child_process'
import {existsSync,lstatSync,realpathSync,readFileSync,writeFileSync,readdirSync,openSync,closeSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'

export function assertOriginalProfilePaths(actual,expected){
 const canonical=path=>existsSync(path)?realpathSync(path):resolve(path)
 if(canonical(actual.userData)!==canonical(expected.userData))throw Error('acceptance_wrong_user_data')
 if(canonical(actual.blackboardPath)!==canonical(expected.blackboardPath))throw Error('acceptance_wrong_blackboard')
}
export function assertNoProfileLock(held){if(held)throw Error('acceptance_profile_locked')}
export function assertProvider(identity,allowed){if(!allowed.includes(identity))throw Error('acceptance_provider_not_authorized')}
export function countOnlyReport(input){
 const count=key=>{const value=input[key];if(!Number.isSafeInteger(value)||value<0)throw Error('acceptance_invalid_count');return value}
 if(!/^[a-f0-9]{40}$/u.test(input.build_commit)||!/^[a-f0-9]{64}$/u.test(input.profile_hash))throw Error('acceptance_invalid_identity')
 const grounded=count('source_grounded_cards'),groundedTodos=count('source_grounded_todos'),groundedIdeas=count('source_grounded_ideas'),groundedGoals=count('source_grounded_goals')
 if(grounded!==groundedTodos+groundedIdeas+groundedGoals)throw Error('acceptance_source_card_count_mismatch')
 return {profile_kind:'original',native_main:true,build_commit:input.build_commit,original_profile_path_hash:input.profile_hash,pre_sources:count('pre_sources'),post_sources:count('post_sources'),eligible_candidates:count('eligible_candidates'),model_calls:count('model_calls'),dom_cards:{todos:count('todos'),ideas:count('ideas'),goals:count('goals')},source_to_card:{dom_rendered:count('todos')+count('ideas')+count('goals'),verified_source_grounded:grounded,verified_source_grounded_by_tab:{todos:groundedTodos,ideas:groundedIdeas,goals:groundedGoals}},remaining_queue:count('remaining_queue'),screenshots:input.screenshots.map(path=>String(path))}
}
const existsIncludingDangling=path=>{try{lstatSync(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
export function preflightLocks(manifest,query=execFileSync){
 const owned=[manifest.originalBlackboardPath,manifest.originalBlackboardPath+'.personal.json.owner.sqlite',manifest.originalBlackboardPath+'.personal.json.sources.json.owner.sqlite'].flatMap(path=>[path,path+'-wal',path+'-shm'])
 let output=''
 try{output=query('lsof',['-t','--',...owned],{encoding:'utf8',stdio:['ignore','pipe','ignore']})}catch(error){assertNoProfileLock(String(error.stdout??'').trim().length>0);if(error.status!==1)throw error}
 assertNoProfileLock(String(output).trim().length>0)
 for(const path of [resolve(manifest.originalUserData,'SingletonLock'),manifest.originalBlackboardPath+'.personal.json.lock',manifest.originalBlackboardPath+'.personal.json.sources.json.lock'])assertNoProfileLock(existsIncludingDangling(path))
}
export function assertFreshArtifacts(directory){
 if(readdirSync(directory).some(name=>['counts.ndjson','capture.json','report.json','native.log'].includes(name)||/^(?:initial|final)-.*\.png$/u.test(name)))throw Error('acceptance_fresh_output_required')
}
async function launch(manifestPath){
 if(!manifestPath)throw Error('usage: workbench-native-live-acceptance.mjs /absolute/manifest.json')
 let manifest=JSON.parse(readFileSync(manifestPath,'utf8'))
 const repository=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'../../..'))
 if(realpathSync(manifest.repository)!==repository)throw Error('acceptance_wrong_repository')
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim()
 if(commit!==manifest.buildCommit)throw Error('acceptance_wrong_build_commit')
 if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repository,encoding:'utf8'}).trim())throw Error('acceptance_dirty_build')
 preflightLocks(manifest)
 assertFreshArtifacts(manifest.outputDirectory)
 execFileSync('npm',['run','build','--workspace','@nova-audio-agent/desktop'],{cwd:repository,stdio:'ignore'})
 const require=createRequire(resolve(repository,'clients/desktop/package.json'))
 if(realpathSync(require.resolve('@nova-audio-agent/runtime/desktop'))!==realpathSync(resolve(repository,'runtime/dist/src/desktop.js')))throw Error('acceptance_wrong_runtime_build')
 if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repository,encoding:'utf8'}).trim())throw Error('acceptance_dirty_build')
 const report=resolve(manifest.outputDirectory,'counts.ndjson')
 if(existsSync(report))throw Error('acceptance_fresh_output_required')
 const runtime=await import(pathToFileURL(resolve(repository,'runtime/dist/src/desktop/workbench-acceptance.js')).href)
 const environment={...process.env,NOVA_WORKBENCH_ACCEPTANCE_MANIFEST:resolve(manifestPath),NOVA_WORKBENCH_ACCEPTANCE_REPORT:report,BLACKBOARD_PATH:manifest.originalBlackboardPath}
 manifest=runtime.loadAcceptanceManifest(environment)
 if(environment.DEV_BACKEND_ENTRY&&realpathSync(environment.DEV_BACKEND_ENTRY)!==realpathSync(resolve(repository,'runtime/dist/src/desktop-entry.js')))throw Error('acceptance_wrong_runtime_entry')
 const electron=(await import('electron')).default
 preflightLocks(manifest)
 assertFreshArtifacts(manifest.outputDirectory)
 const diagnosticLog=openSync(resolve(manifest.outputDirectory,'native.log'),'wx',0o600)
 let child
 try{child=spawn(electron,[resolve(repository,'clients/desktop'),`--user-data-dir=${manifest.originalUserData}`],{cwd:repository,env:environment,stdio:['ignore',diagnosticLog,diagnosticLog]})}
 finally{closeSync(diagnosticLog)}
 const timer=setTimeout(()=>child.kill('SIGTERM'),(manifest.runCapSeconds+90)*1000)
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 clearTimeout(timer)
 if(code!==0)throw Error('acceptance_native_exit_failed')
 const capturePath=resolve(manifest.outputDirectory,'capture.json')
 if(!existsSync(capturePath)||!existsSync(report))throw Error('acceptance_evidence_incomplete')
 const samples=readFileSync(report,'utf8').trim().split('\n').map(line=>JSON.parse(line))
 const source=samples.filter(row=>row.kind==='source_state'),context=samples.filter(row=>row.kind==='context_state')
 if(!samples.some(row=>row.kind==='runtime_gate_verified'&&row.counts.verified===1))throw Error('acceptance_gate_proof_missing')
 if(!source.length||!context.length)throw Error('acceptance_runtime_counts_missing')
 if(samples.filter(row=>row.kind==='egress_blocked').length>samples.filter(row=>row.kind==='gate_installed').length)throw Error('acceptance_unexpected_egress')
 const last=source.at(-1).counts,capture=JSON.parse(readFileSync(capturePath,'utf8'))
 const finalContext=context.at(-1).counts
 const result=countOnlyReport({build_commit:commit,profile_hash:createHash('sha256').update(realpathSync(manifest.originalUserData)).digest('hex'),pre_sources:source[0].counts.sources,post_sources:last.sources,eligible_candidates:finalContext.eligible_candidates,model_calls:samples.filter(row=>row.kind==='context_model').length,todos:capture.dom_cards.todos,ideas:capture.dom_cards.ideas,goals:capture.dom_cards.goals,source_grounded_cards:finalContext.source_grounded_cards,source_grounded_todos:finalContext.source_grounded_todos,source_grounded_ideas:finalContext.source_grounded_ideas,source_grounded_goals:finalContext.source_grounded_goals,remaining_queue:last.remaining_queue,screenshots:capture.screenshots})
 writeFileSync(resolve(manifest.outputDirectory,'report.json'),JSON.stringify({...result,termination:'run_cap',quiescence_verified:false,source_counts:{pre:source[0].counts,post:last},outbound_model_calls:samples.filter(row=>row.kind==='model_call').length,blocked_outbound:samples.filter(row=>row.kind==='egress_blocked').length,gate_probes:samples.filter(row=>row.kind==='gate_installed').length,profile:{enabled:manifest.profileGeneration,model_calls:samples.filter(row=>row.kind==='profile_model').length,last_model_input:samples.filter(row=>row.kind==='profile_model').at(-1)?.counts??null,last_state:samples.filter(row=>row.kind==='profile_state').at(-1)?.counts??null,dom:capture.dom_profile??null},news:{enabled:manifest.news===true,fetches:samples.filter(row=>row.kind==='news_fetch').length,fetch_ok:samples.filter(row=>row.kind==='news_fetch'&&row.counts.ok===1).length,last_state:samples.filter(row=>row.kind==='news_state').at(-1)?.counts??null},disabled_modules:[...(manifest.news!==true?['news']:[]),'proactive','connectors','phone','external_mcp','coding','voice_activation',...(!manifest.profileGeneration?['profile_generation']:[]),'understanding','memory_overview','search','camera_capability','wake_word']},null,2)+'\n',{mode:0o600})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))launch(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1})
