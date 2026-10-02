import {readFile,writeFile} from 'node:fs/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {HostApprovalController} from '../dist/src/core/approval.js';
import {RealClock} from '../dist/src/core/clock.js';
import {MobileExecutor,loadMobileConfig} from '../dist/src/executors/mobile.js';
import {loadSettings} from '../dist/src/config/config.js';
import {parseCapabilityRegistry} from '../dist/src/config/capability-registry.js';
import {buildProductionRealtimeAssembly} from '../dist/src/composition/cascaded-realtime-assembly.js';
import {NullTelemetry} from '../dist/src/realtime/telemetry.js';
// Opt-in real Nova text frontend -> host.dispatch -> mobile -> Midscene -> ADB.
// Arguments: env-file, private-model-json, device-serial, instruction, output-json.
const [envFile,modelFile,serial,instruction,output]=process.argv.slice(2);
if(!envFile||!modelFile||!serial||!instruction||!output) throw Error('usage: node accept-mobile-android.mjs env-file model-json serial instruction output-json');
const secret=JSON.parse(await readFile(modelFile,'utf8'));
const env={...process.env,...parseEnv(await readFile(envFile,'utf8')),PIPELINE_MODE:'cascaded',EXECUTORS:'mobile',MOBILE_DEVICE_TYPE:'android',MOBILE_DEVICE_ID:serial,MOBILE_BASE_URL:secret.baseUrl,MOBILE_MODEL:secret.model,MOBILE_MODEL_FAMILY:secret.modelFamily,MOBILE_API_KEY:secret.apiKey,MOBILE_MAX_STEPS:'15',MOBILE_TIMEOUT_SECONDS:'900'};
const config=loadMobileConfig(env),settings=loadSettings(env),clock=new RealClock(),telemetry=new NullTelemetry({clock});
const approvals=new HostApprovalController({clock,idFactory:randomUUID}),executor=new MobileExecutor(config,approvals);
const evidence={started:new Date().toISOString(),kind:'Nova-production-text-input-real-frontend-Midscene-ADB',instruction,scope:'Text task, real models and physical phone; digital audio acknowledgements, no microphone/speaker or desktop UI acceptance',device:config.deviceId,frontend:settings.cascade_llm_provider,model:config.model,approvals:[],events:[],spoken:[]};
mkdirSync(dirname(output),{recursive:true,mode:0o700});
const checkpoint=()=>writeFileSync(output,JSON.stringify(evidence,null,2),{mode:0o600});
checkpoint();
const originalRecord=telemetry.record.bind(telemetry);telemetry.record=(kind,payload)=>{originalRecord(kind,payload);evidence.events.push(telemetry.diagnostics().records.at(-1));if(/tool.call|executor|error|failed/.test(kind))console.log(JSON.stringify({event:kind,payload:telemetry.diagnostics().records.at(-1).payload}));};
const rl=createInterface({input:process.stdin});let pending=null,assembly;
rl.on('line',line=>{if(pending){const decision=line.trim()==='accept'?'accept':'decline';evidence.approvals.push({...pending,decision});checkpoint();approvals.release();approvals.acceptDecision({approvalId:pending.id,decision});pending=null;} else if(assembly) { void assembly.service.submitText(line.trim()).catch(error=>console.log(error.message)); }});
let stopping=false;process.on('SIGINT',()=>{stopping=true;void executor.close();});
const seen=new Set();approvals.observe(view=>{if(view.pending_approval&&!view.pending_approval_busy&&!seen.has(view.pending_approval_id)){seen.add(view.pending_approval_id);pending={id:view.pending_approval_id,summary:view.operation_summary,detail:view.local_detail};approvals.hold();console.log(JSON.stringify({approval:pending}));}});
const capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:false},camera:{enabled:false},search:{enabled:false},knowledge:{enabled:false}}},{});
try {
 assembly=buildProductionRealtimeAssembly({settings,capabilities,clock,telemetry,executors:[executor],agentDescriptors:[executor.descriptor],additionalAgentControllers:port=>[executor.controller({...port,dispatch:request=>{evidence.dispatch={channel:request.channel,op:request.op,request:request.request};checkpoint();return port.dispatch(request);}})],executorApproval:approvals,
 onSpoken:text=>{evidence.spoken.push(text);console.log(JSON.stringify({spoken:text}));},
 onAudioFrame:frame=>assembly.service.playbackStarted(frame.utterance_id,frame.generation_epoch),
 onAudioClear:(id,epoch)=>queueMicrotask(()=>assembly.service.playbackCleared(id,epoch,0)),
 onAudioTerminal:(id,epoch)=>queueMicrotask(()=>assembly.service.playbackDone(id,epoch,null))});
 await assembly.start();console.log('NOVA_STARTED');
 await assembly.service.submitText(instruction);
 const deadline=Date.now()+960000;
 while(Date.now()<deadline&&!stopping){const terminal=assembly.runtime.memory.channels.get('mobile')?.items.findLast(item=>item.outcome!=null);if(terminal){evidence.terminal=terminal;console.log(JSON.stringify({terminal}));break;}await delay(200);}
 if(!evidence.terminal)throw Error('mobile_terminal_timeout');
 if(evidence.terminal.outcome!=='ok')process.exitCode=1;
} catch(error){evidence.error=String(error.message);console.log(JSON.stringify({error:evidence.error}));process.exitCode=1;}
finally {await executor.close();await assembly?.stop();rl.close();evidence.finished=new Date().toISOString();await writeFile(output,JSON.stringify(evidence,null,2),{mode:0o600});}
