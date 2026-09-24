// Real prerecorded voice acceptance through the production Nova voice assembly.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {loadSettings} from '../../dist/src/config/config.js'
import {buildConversationVoiceProvider} from '../../dist/src/conversation-voice-provider.js'
import {RealClock} from '../../dist/src/core/clock.js'
const directory=process.argv[2]
if(!directory)throw Error('Usage: node live-voice.mjs <fixture/output-directory>')
await mkdir(directory,{recursive:true})
const profile={llm:{baseUrl:'http://127.0.0.1:18101/v1',model:'Qwen/Qwen3.5-4B'},asr:{endpoint:'http://127.0.0.1:18102/v1/audio/transcriptions',referenceAudio:join(directory,'reference.wav')},tts:{endpoint:'http://127.0.0.1:18103/v1/audio/speech'},embedding:{baseUrl:'http://127.0.0.1:18104/v1',model:'Qwen/Qwen3-Embedding-0.6B'}}
const settings=loadSettings({NOVA_AUDIO_AGENT_LOCAL_SERVING:JSON.stringify(profile),NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS:'1500'})
const telemetry=[],events=[],audio=[]
const provider=buildConversationVoiceProvider({settings,clock:new RealClock(),idFactory:randomUUID,telemetry:{record:(name,fields)=>(telemetry.push({name,fields}),name.includes('capability')&&console.error(name,JSON.stringify(fields)))}})
const keepAlive=setInterval(()=>{},1000)
const started=performance.now(),signal=AbortSignal.timeout(120000)
const stamp=()=>Math.round(performance.now()-started)
function dataChunk(wav){for(let offset=12;offset+8<=wav.length;){const size=wav.readUInt32LE(offset+4);if(wav.toString('ascii',offset,offset+4)==='data')return wav.subarray(offset+8,offset+8+size);offset+=8+size+(size%2)}throw Error('missing WAV data')}
function wave(pcm){const out=Buffer.alloc(44+pcm.length);out.write('RIFF');out.writeUInt32LE(36+pcm.length,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(24000,24);out.writeUInt32LE(48000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(pcm.length,40);pcm.copy(out,44);return out}
let reader,passed=false
try{
 await provider.connect({tools:[],signal})
 // Synthetic test preference; use LONG_REPLY=1 to exercise unconstrained answers.
 if(process.env.LONG_REPLY!=='1')await provider.replaceResponseAdaptation({revision:1,content:'测试用户明确偏好：每次只用一句简短中文回答，不超过二十个字。'},signal)
 reader=(async()=>{
  for await(const event of provider.events(signal)){
   if(event.kind==='response_audio_delta'){audio.push(Buffer.from(event.pcm));events.push({kind:event.kind,bytes:event.pcm.length,ms:stamp()})}
   else {events.push({...event,ms:stamp()});console.error(event.kind,JSON.stringify(event))}
   if(event.kind==='user_transcript_final')await provider.ensureResponse(signal,event.item_id)
   if(event.kind==='provider_error')throw Error('provider error: '+event.code)
   if(event.kind==='response_terminal'){assert.equal(event.status,'completed');return}
  }
 })();void reader.catch(()=>{})
 const pcm=dataChunk(await readFile(join(directory,'target.wav')))
 for(let i=0;i<pcm.length;i+=3200){await provider.sendAudio(pcm.subarray(i,i+3200),signal);await delay(100)}
 for(let i=0;i<40;i++){await provider.sendAudio(new Uint8Array(3200),signal);await delay(100)}
 await reader
 signal.throwIfAborted()
 assert.ok(events.some(e=>e.kind==='response_terminal'&&e.status==='completed'),'no completed response terminal')
 assert.ok(events.some(e=>e.kind==='user_transcript_final'&&e.text?.includes('AI')),'missing real ASR transcript')
 assert.ok(audio.length,'missing synthesized speech')
 await writeFile(join(directory,'nova-reply.wav'),wave(Buffer.concat(audio)))
 passed=true
 console.log(JSON.stringify({passed:true,milliseconds:stamp(),audioBytes:Buffer.concat(audio).length,events,telemetry},null,2))
}finally{clearInterval(keepAlive);await provider.close();await reader?.catch(()=>{});await writeFile(join(directory,'nova-voice-events.json'),JSON.stringify({passed,shortReply:process.env.LONG_REPLY!=='1',events,telemetry},null,2))}
