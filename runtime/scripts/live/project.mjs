/** Opt-in real project execution. Never log credentials or alter the user's Nova state. */
import {mkdir,mkdtemp,readFile,writeFile,copyFile,chmod,rm} from 'node:fs/promises'
import {realpathSync,statSync,readFileSync,accessSync,constants} from 'node:fs'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {validateProjectResult} from './project-result.mjs'

const root=path.resolve(import.meta.dirname,'../../..')
if(process.env.NOVA_LIVE_PROJECT_EXECUTE!=='1') {
  console.error('project live test requires NOVA_LIVE_PROJECT_EXECUTE=1');process.exit(2)
}
if(process.platform!=='darwin') {console.error('project live host currently supports macOS');process.exit(2)}
if(!process.versions.electron) {console.error('run this suite through live-smoke --target project');process.exit(2)}
const {loadSettings}=await import('../../dist/src/config/config.js')
const {parseCapabilityRegistry}=await import('../../dist/src/config/capability-registry.js')
const {requireSelectedCascadedRealtimeConfig}=await import('../../dist/src/config/cascaded-realtime-config.js')
const {buildProductionRealtimeAssembly,cascadedProviderRegistries}=await import('../../dist/src/composition/cascaded-realtime-assembly.js')
const {createCodexAssemblyResource,createProductionCodexHost,resolveCodexHostConfig,prepareManagedCodexMcp}=await import('../../dist/src/executors/codex/host.js')
const {canonicalInstalledInvocation}=await import('../../../clients/desktop/src/main/desktop-startup.mjs')
const {RealClock}=await import('../../dist/src/core/clock.js')
const {NullTelemetry}=await import('../../dist/src/realtime/telemetry.js')
const runRoot=realpathSync(await mkdtemp(path.join(tmpdir(),'nova-live-project-')))
await mkdir(path.join(runRoot,'initial'));await mkdir(path.join(runRoot,'workspaces'))
const output=process.env.NOVA_LIVE_PROJECT_REPORT??path.join(runRoot,'report.json')
const mode=process.env.NOVA_LIVE_PROJECT_INPUT??'text'
const workspaceScenario=['workspaces','clarification'].includes(process.env.NOVA_LIVE_PROJECT_SCENARIO)
const decision=process.env.NOVA_LIVE_PROJECT_CONFIRMATION??'natural'
if(!['text','audio'].includes(mode)||!['natural','short'].includes(decision))throw Error('invalid project test mode')
const report={version:1,status:'running',input:mode,confirmation:decision,runRoot,steps:[],spoken:[],transcripts:[],result:{},scope:'Production cascaded runtime and real Codex; digital playback acknowledgement; no microphone, speaker or GUI acceptance.'}
const clock=new RealClock(),telemetry=new NullTelemetry({clock})
if(workspaceScenario){
  const record=telemetry.record.bind(telemetry),snapshot=telemetry.diagnostics.bind(telemetry),history=[]
  telemetry.record=(kind,payload)=>{record(kind,payload);history.push(snapshot().records.at(-1))}
  telemetry.diagnostics=()=>({version:1,records:history.slice()})
}
let assembly,resource,view,confirmed=false
const stop=new AbortController()
process.parentPort.on('message',event=>{if((event.data??event)?.type==='nova.live.stop'){stop.abort();void assembly?.stop().catch(()=>undefined)}})
const save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600})
const step=(name)=>{report.steps.push(name);console.log(`project: ${name}`)}
const wait=async(name,predicate,ms=60000)=>{const end=Date.now()+ms;while(!predicate()){
  stop.signal.throwIfAborted()
  if(report.result.replacedProposal)throw Error('proposal_replaced_by_confirmation')
  if(Date.now()>end)throw Error(name+'_timeout')
  await delay(100)
};step(name)}
try {
  if(workspaceScenario){
    const originalFetch=globalThis.fetch
    globalThis.fetch=async(url,options)=>{
      if(typeof options?.body==='string'){
        try{const body=JSON.parse(options.body);if(body.messages&&body.model){(report.modelRequests??=[]).push(body);await save()}}catch{}
      }
      return originalFetch(url,options)
    }
  }
  const invocation=canonicalInstalledInvocation({kind:'native',command:process.env.CODEX_BIN??'/opt/homebrew/bin/codex',prefixArgs:[]},
    {platform:process.platform,arch:process.arch,pathApi:path,realpath:realpathSync,stat:statSync,readFile:readFileSync,access:p=>accessSync(p,constants.X_OK)})
  if(!invocation)throw Error('codex_not_found')
  const settings=loadSettings({...process.env,PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'qwen',
    EXECUTOR:'codex',CODEX_BIN:invocation.command,CODEX_PREWARM:process.env.CODEX_PREWARM??'false',
    CODEX_WORKSPACE:path.join(runRoot,'initial'),CODEX_MANAGED_ROOT:path.join(runRoot,'workspaces'),
    CODEX_PROJECT_STATE_ROOT:runRoot,CONVERSATION_VISION_ENABLED:'false'})
  const capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:true},camera:{enabled:false},search:{enabled:false},knowledge:{enabled:false}}},{})
  const host=createProductionCodexHost(settings,{resourcesPath:process.env.CODEX_RESOURCES_PATH??path.join(root,'clients/desktop/build')})
  const config=resolveCodexHostConfig(settings,workspaceScenario?{...host.catalog,homeDirectory:runRoot}:host.catalog)
  if(workspaceScenario){
    // Share login/provider configuration only; never import the user's session catalog.
    for(const file of ['auth.json','config.toml']){
      try{await copyFile(path.join(host.catalog.homeDirectory,'.codex',file),path.join(runRoot,'.codex',file));await chmod(path.join(runRoot,'.codex',file),0o600)}
      catch(error){if(error.code!=='ENOENT')throw error}
    }
    const {ProjectStore}=await import('../../dist/src/projects/project-store.js')
    const store=await ProjectStore.open({stateRoot:config.stateRoot,managedRoot:config.managedRoot,...host.projectHost,live:true})
    try{for(const name of ['贪吃蛇','笔记工具'])await store.createManaged(name);await store.selectWorkspace('贪吃蛇')}
    finally{await store.close()}
  }
  resource=await createCodexAssemblyResource({config,composition:'realtime',transportFactory:host.transportFactory,
    onDiagnostic:code=>{(report.executorDiagnostics??=[]).push({code,at:clock.now()})},
    projectHost:host.projectHost,clock,idFactory:()=>randomUUID().replaceAll('-',''),managedMcp:prepareManagedCodexMcp(capabilities),
    codexApprovalBroker:{publish:()=>{report.result.approvalRequired=true}}})
  assembly=buildProductionRealtimeAssembly({settings,capabilities,codexResource:resource,telemetry,
    onSpoken:text=>report.spoken.push(text),onProjectView:value=>{view=value;if(confirmed&&value.pending_confirmation_id&&value.pending_confirmation_id!==report.result.proposalId)report.result.replacedProposal=true},
    onAudioFrame:frame=>{report.audioBytes=(report.audioBytes??0)+frame.pcm.length;assembly.service.playbackStarted(frame.utterance_id,frame.generation_epoch)},
    onAudioClear:(id,epoch)=>queueMicrotask(()=>assembly.service.playbackCleared(id,epoch,0)),
    onAudioTerminal:(id,epoch)=>queueMicrotask(()=>assembly.service.playbackDone(id,epoch,null))})
  await assembly.start();step('started')
  const send=async(text)=>{
    if(mode==='text')return assembly.service.submitText(text)
    const config=requireSelectedCascadedRealtimeConfig(settings)
    const client=await cascadedProviderRegistries.tts.volcengine({config:config.tts,ids:{next:()=>randomUUID()}}).openClient().open(AbortSignal.any([stop.signal,AbortSignal.timeout(30000)]))
    const chunks=[],signal=AbortSignal.any([stop.signal,AbortSignal.timeout(60000)])
    const reading=(async()=>{for await(const frame of client.events(signal))chunks.push(Buffer.from(frame.pcm))})()
    try{await client.sendText(text,signal);await client.finish(signal);await reading}finally{await client.close()}
    const original=Buffer.concat(chunks),pcm=Buffer.alloc(Math.floor(original.length/3)*2)
    for(let i=0;i<pcm.length/2;i++){const p=i*1.5,l=Math.floor(p),r=Math.min(l+1,original.length/2-1);pcm.writeInt16LE(Math.round(original.readInt16LE(l*2)*(1-p+l)+original.readInt16LE(r*2)*(p-l)),i*2)}
    for(const part of [Buffer.alloc(16000),pcm,Buffer.alloc(64000)])for(let i=0;i<part.length;i+=1024){await assembly.service.sendAudio(part.subarray(i,i+1024));await delay(32)}
  }
  if(workspaceScenario){
    const {runWorkspaceScenarios}=await import('./workspace-scenarios.mjs')
    await runWorkspaceScenarios({assembly,telemetry,send,wait,report,save,getView:()=>view})
    report.status='passed'
  }else{
  const name='语音验收'+randomUUID().slice(0,6)
  report.request=`新建一个叫“${name}”的工作区，只创建 acceptance.txt，内容为 NOVA_E2E_OK。不安装依赖，不联网，不启动服务器。完成后读取文件验证内容。`
  await send(report.request)
  await wait('initial_frontend_terminal',()=>telemetry.diagnostics().records.some(item=>item.kind==='provider.response_terminal'),60000)
  if(!telemetry.diagnostics().records.some(item=>item.kind==='tool.call'&&item.payload.name==='host.dispatch'))throw Error('clear_request_not_dispatched')
  await wait('proposal',()=>view?.pending_confirmation===true,90000)
  Object.assign(report.result,{proposalId:view.pending_confirmation_id,expectedName:name,proposalName:view.pending_workspace_display_name,managedRoot:path.join(runRoot,'workspaces')})
  if(view.pending_workspace_display_name!==name)throw Error('project_name_mismatch')
  await wait('readback_terminal',()=>assembly.service.session.providerIdle)
  confirmed=true
  await send(decision==='short'?'确认。':'确认创建工作区并执行这个任务。')
  await wait('executor_terminal',()=>assembly.runtime.memory.channels.get('codex')?.items.some(item=>item.outcome!=null),200000)
  const terminal=assembly.runtime.memory.channels.get('codex').items.findLast(item=>item.outcome!=null)
  Object.assign(report.result,{outcome:terminal.outcome,code:terminal.content.code})
  const admission=telemetry.diagnostics().records.find(item=>item.kind==='project_confirmation.commit_admission'&&item.payload.accepted)
  report.result.confirmedId=admission?.payload.proposal_id??null
  const state=JSON.parse(await readFile(path.join(runRoot,'codex-projects-v1.json'),'utf8'))
  const workspace=Object.values(state.workspaces).find(item=>item.origin==='managed')
  if(workspace){Object.assign(report.result,{workspaceName:workspace.display_name,workspacePath:realpathSync(workspace.canonical_path)});report.workspace=workspace.canonical_path;report.sessions=Object.values(state.sessions).filter(item=>item.workspace_id===workspace.workspace_id).map(({codex_thread_id,state,origin})=>({codex_thread_id,state,origin}));try{report.result.file=await readFile(path.join(workspace.canonical_path,'acceptance.txt'),'utf8')}catch{report.result.file=null}}
  report.result.followups=[]
  if(report.result.outcome==='ok' && workspace) {
    let previousThread=state.sessions[workspace.active_session_id]?.codex_thread_id
    for(const [session,file,expected] of [['latest','continued.txt','CONTINUE_OK'],['new','new-session.txt','NEW_SESSION_OK']]) {
      await wait('delivery_idle',()=>assembly.service.session.providerIdle)
      const before=assembly.runtime.memory.channels.get('codex').items.filter(item=>item.outcome!=null).length
      const action=session==='new'?'里新建一个会话执行':'继续执行'
      await send(`在刚创建的工作区“${name}”${action}：只创建 ${file}，内容为 ${expected}，然后读取验证。不安装依赖，不联网，不启动服务器。现在开始。`)
      await wait(`${session}_completed`,()=>assembly.runtime.memory.channels.get('codex').items.filter(item=>item.outcome!=null).length>before,120000)
      const terminal=assembly.runtime.memory.channels.get('codex').items.findLast(item=>item.outcome!=null)
      let actual=null
      try{actual=await readFile(path.join(workspace.canonical_path,file),'utf8')}catch{}
      const after=JSON.parse(await readFile(path.join(runRoot,'codex-projects-v1.json'),'utf8'))
      const currentWorkspace=after.workspaces[workspace.workspace_id]
      const thread=after.sessions[currentWorkspace?.active_session_id]?.codex_thread_id
      const sessionMatches=!!thread&&!!previousThread&&(session==='new'?thread!==previousThread:thread===previousThread)
      report.result.followups.push({session,outcome:terminal.outcome,content:terminal.content,file:actual,expected,thread,sessionMatches})
      previousThread=thread
      if(terminal.outcome!=='ok'||actual!==expected)break
    }
    await wait('final_delivery_idle',()=>assembly.service.session.providerIdle)
  }
  if(process.env.NOVA_LIVE_PROJECT_SNAKE==='1' && report.result.outcome==='ok' && workspace) {
    await wait('snake_delivery_idle',()=>assembly.service.session.providerIdle)
    const before=assembly.runtime.memory.channels.get('codex').items.filter(item=>item.outcome!=null).length
    await send('帮我写一个最简单的网页版贪吃蛇游戏，保存为 snake.html，一个HTML文件，无外部依赖，方向键控制，有开始和重新开始按钮及得分，撞墙或自己结束。只在当前工作区里创建该文件，不修改已有文件。完成后读取验证。')
    await wait('snake_completed',()=>assembly.runtime.memory.channels.get('codex').items.filter(item=>item.outcome!=null).length>before,180000)
    const terminal=assembly.runtime.memory.channels.get('codex').items.findLast(item=>item.outcome!=null)
    const after=JSON.parse(await readFile(path.join(runRoot,'codex-projects-v1.json'),'utf8'))
    const thread=after.sessions[after.workspaces[workspace.workspace_id].active_session_id]?.codex_thread_id
    const previous=report.result.followups.at(-1)?.thread
    const html=await readFile(path.join(workspace.canonical_path,'snake.html'),'utf8')
    report.snake={outcome:terminal.outcome,thread,newSession:thread!==previous,file:path.join(workspace.canonical_path,'snake.html'),bytes:html.length}
    if(terminal.outcome!=='ok'||thread===previous||html.length<100)throw Error('snake_failed')
    await wait('snake_final_delivery_idle',()=>assembly.service.session.providerIdle)
  }
  report.failures=validateProjectResult(report.result)
  report.status=report.failures.length?'failed':'passed'
  }
}catch(error){report.status='failed';report.failure=['clear_request_not_dispatched','codex_not_found','project_name_mismatch','proposal_replaced_by_confirmation','proposal_timeout','readback_terminal_timeout','executor_terminal_timeout','latest_completed_timeout','new_completed_timeout'].includes(error.message)?error.message:'runtime_failure';report.errorType=error.name;if(workspaceScenario)report.scenarioFailure=error.message}
finally {
  if(assembly)report.codingRecords=assembly.runtime.memory.channels.get('codex')?.items??[]
  if(assembly)report.transcripts=assembly.runtime.memory.channels.get('conversation')?.items.filter(i=>i.trust==='trusted_user').map(i=>i.content.text)??[]
  report.telemetry=telemetry.diagnostics()
  try{await assembly?.stop();await resource?.close()}catch{report.status='failed';report.cleanupFailure=true}
  if(workspaceScenario)for(const file of ['auth.json','config.toml'])await rm(path.join(runRoot,'.codex',file),{force:true})
  await save();console.log(`project: ${report.status}; report ${output}`)
}
process.exit(report.status==='passed'?0:1)
