import {readFile,writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {cascadedProviderRegistries} from '../../dist/src/composition/cascaded-realtime-assembly.js'
import {RealClock} from '../../dist/src/core/clock.js'
import {acousticBounds,wavPcm} from './metrics.mjs'
const [input,output]=process.argv.slice(2)
if(!input||!output)throw Error('Usage: live-endpointing.mjs target.wav output.json')
const original=wavPcm(await readFile(input)),pause=Buffer.alloc(800*32)
const clips={speech:original,pause800:Buffer.concat([original.subarray(0,3*32000),pause,original.subarray(3*32000)]),silence:Buffer.alloc(32000*3)}
const base={vadThreshold:.5,vadPreRollMs:260,vadMinSpeechMs:250,vadSilenceEndMs:600,vadSpeechPadMs:30,vadMaxUtteranceMs:60000,maxSilenceMs:1200}
const configs=process.env.BALANCED_ONLY==='1'?[{name:'balanced',...base,vadMinSpeechMs:100,vadSilenceEndMs:250}]:[{name:'baseline',...base},{name:'faster',...base,vadMinSpeechMs:100,vadSilenceEndMs:250,maxSilenceMs:600},{name:'higher_threshold',...base,vadThreshold:.6,vadMinSpeechMs:100,vadSilenceEndMs:250,maxSilenceMs:600}]
const results=[];const keepAlive=setInterval(()=>{},1000)
try{
for(const config of configs)for(const [clip,pcm] of Object.entries(clips)){
 const events=[],telemetry=[],bounds=acousticBounds(pcm),signal=AbortSignal.timeout(30000)
 let started=performance.now()
 const endpoint=await cascadedProviderRegistries.endpointing.auto({config,clock:new RealClock()})({signal,telemetry:{record:(name,fields)=>telemetry.push({name,fields,ms:performance.now()-started})}})
 started=performance.now();const feed=Buffer.concat([pcm,Buffer.alloc(32000*2)])
 try{for(let i=0;i<feed.length;i+=640){
  for(const e of await endpoint.feed(feed.subarray(i,i+640),signal))events.push({kind:e.kind,ms:performance.now()-started,inputMs:(i+640)/32})
  await delay(Math.max(0,started+(i+640)/32-performance.now()))
 }}finally{await endpoint.close()}
 const ends=events.filter(e=>e.kind==='speech_end')
 const row={config:config.name,clip,bounds,events,telemetry,ends:ends.length,firstEndAfterAcousticMs:ends.length&&bounds.endMs!==null?ends[0].ms-bounds.endMs:null}
 results.push(row);console.log(JSON.stringify({config:config.name,clip,ends:row.ends,firstEndAfterAcousticMs:row.firstEndAfterAcousticMs,decisions:telemetry.filter(t=>t.name.endsWith('.decision'))}))
 await writeFile(output,JSON.stringify(results,null,2))
}
}finally{clearInterval(keepAlive)}
