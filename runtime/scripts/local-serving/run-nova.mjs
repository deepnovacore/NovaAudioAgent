// Isolated headless Nova: explicitly selected local endpoints and explicit reusable experiment state.
import {mkdir,readFile,writeFile,access} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {initializeServerToken} from '../../dist/src/server/server-config.js'
import {localServingSchema} from '../../dist/src/config/local-serving.js'
const [profilePath,statePath,port='18100']=process.argv.slice(2)
if(!profilePath||!statePath||!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw Error('Usage: run-nova.mjs <profile.json> <experiment-state-directory> [port]')
const profile=localServingSchema.parse(JSON.parse(await readFile(profilePath,'utf8')))
const state=resolve(statePath);await mkdir(state,{recursive:true,mode:0o700})
const token=join(state,'server.token'),capabilities=join(state,'capabilities.local-serving.json')
try{await access(token)}catch(error){if(error.code!=='ENOENT')throw error;initializeServerToken(token)}
await writeFile(capabilities,JSON.stringify({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:false}},mcpServers:{}}),{mode:0o600})
const environment={}
for(const name of ['PATH','HOME','TMPDIR','LANG','LD_LIBRARY_PATH'])if(process.env[name]!==undefined)environment[name]=process.env[name]
Object.assign(environment,{
 NOVA_AUDIO_AGENT_REALTIME_TELEMETRY:join(state,'realtime.jsonl'),
 NOVA_AUDIO_AGENT_LOCAL_SERVING:JSON.stringify(profile),NOVA_AUDIO_AGENT_SERVER_TOKEN_FILE:token,NOVA_AUDIO_AGENT_SERVER_PORT:port,
 NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG:capabilities,NOVA_AUDIO_AGENT_MEMORY_CONNECTION:'local',
 NOVA_AUDIO_AGENT_MEMORY_PATH:join(state,'legacy-memory.sqlite'),NOVA_AUDIO_AGENT_MEMORY_LEDGER_PATH:join(state,'ledger.sqlite'),
 NOVA_AUDIO_AGENT_BLACKBOARD_PATH:join(state,'blackboard.sqlite'),NOVA_AUDIO_AGENT_KNOWLEDGE_PATH:join(state,'knowledge.sqlite'),
})
const child=spawn(process.execPath,[fileURLToPath(new URL('../../dist/src/server-entry.js',import.meta.url))],{env:environment,stdio:'inherit'})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal))
child.on('error',error=>{console.error(error.message);process.exitCode=1})
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0)})
