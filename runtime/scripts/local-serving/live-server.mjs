// Real authenticated Nova server; prerecorded PCM and simulated renderer acknowledgements.
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {randomUUID} from 'node:crypto'
import WebSocket from 'ws'
import {decodeAudioFrame} from '../../dist/src/desktop/desktop-wire.js'
const [state,fixtures,port='18100']=process.argv.slice(2)
if(!state||!fixtures)throw Error('Usage: live-server.mjs <state-dir> <fixtures-dir> [port]')
const token=(await readFile(`${state}/server.token`,'utf8')).trim(),url=`ws://127.0.0.1:${port}/client/v1`
const result={scope:'real server/models, prerecorded PCM, simulated renderer acknowledgements; no speaker playback',events:[],audioBytes:0}
const started=performance.now(),now=()=>Math.round(performance.now()-started)
const bad=new WebSocket(url)
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{bad.terminate();reject(Error('bad token not rejected'))},5000);bad.on('open',()=>bad.send(JSON.stringify({type:'hello',protocol_version:1,token:'0'.repeat(32)})));bad.on('close',code=>{clearTimeout(timer);assert.equal(code,4003);result.authRejection=true;resolve()});bad.on('error',reject)})
const socket=new WebSocket(url),chunks=[],seen=new Set(),receipts=new Map(),startedAcks=[]
let connection,readyResolve,doneResolve,fail
const ready=new Promise(resolve=>{readyResolve=resolve})
const done=new Promise((resolve,reject)=>{doneResolve=resolve;fail=reject});void done.catch(()=>{})
const timer=setTimeout(()=>fail(Error('server acceptance deadline')),180000)
const command=payload=>new Promise((resolve,reject)=>{const request_id=randomUUID();receipts.set(request_id,{resolve,reject,type:payload.type});socket.send(JSON.stringify({type:'client.command',request_id,connection_id:connection,payload}))})
socket.on('error',fail)
socket.on('open',()=>socket.send(JSON.stringify({type:'hello',protocol_version:1,token,language:'zh-CN'})))
socket.on('message',(raw,binary)=>{
 try{
  if(binary){const frame=decodeAudioFrame(new Uint8Array(raw));chunks.push(Buffer.from(frame.pcm));result.audioBytes+=frame.pcm.length;if(result.firstAudioMs===undefined)result.firstAudioMs=now();if(!seen.has(frame.utterance_id)){seen.add(frame.utterance_id);const ack=command({type:'playback.started',utterance_id:frame.utterance_id,generation_epoch:frame.generation_epoch,t_render_ms:performance.now()});void ack.catch(fail);startedAcks.push(ack)}return}
  const event=JSON.parse(raw.toString())
  result.events.push({ms:now(),...event})
  if(event.type==='client.command_result'){const receipt=receipts.get(event.request_id);if(receipt){receipts.delete(event.request_id);if(event.status==='applied')receipt.resolve();else receipt.reject(Error(receipt.type+' '+event.status))}}
  if(event.type==='client.ready'){connection=event.connection_id;assert.equal(event.media.pipeline,'cascaded');readyResolve()}
  if(event.type==='caption')console.log('caption',event.role,event.final,event.text)
  if(event.type==='playback.terminal'){
   assert.ok(result.audioBytes>0)
   const ack=command({type:'playback.done',utterance_id:event.utterance_id,generation_epoch:event.generation_epoch,played_ms:Math.round(result.audioBytes/48),t_render_ms:performance.now()})
   result.terminalMs=now();Promise.all([...startedAcks,ack]).then(()=>{result.playbackAcksAccepted=true;doneResolve()},fail)
  }
 }catch(error){fail(error)}
})
try{
 await Promise.race([ready,done]);await Promise.race([command({type:'input.audio'}),done]);await delay(1000)
 const wav=await readFile(`${fixtures}/target.wav`);let pcm
 for(let i=12;i+8<=wav.length;){const n=wav.readUInt32LE(i+4);if(wav.toString('ascii',i,i+4)==='data'){pcm=wav.subarray(i+8,i+8+n);break}i+=8+n+(n%2)}
 assert.ok(pcm)
 for(let i=0;i<pcm.length;i+=3200){socket.send(pcm.subarray(i,i+3200));await delay(100)}
 for(let i=0;i<40;i++){socket.send(Buffer.alloc(3200));await delay(100)}
 await done;await delay(500)
 assert.ok(result.events.some(e=>e.type==='caption'&&e.role==='user'&&e.text.includes(process.env.EXPECT_TEXT??'欢迎')),'no user transcript')
 assert.ok(result.events.some(e=>e.type==='caption'&&e.role==='assistant'&&e.final),'no final assistant caption')
 assert.ok(result.events.some(e=>e.type==='client.command_result'&&e.status==='applied'),'no control acknowledgement')
 result.passed=true
}finally{
 clearTimeout(timer);socket.close();await writeFile(`${fixtures}/server-live.json`,JSON.stringify(result,null,2));await writeFile(`${fixtures}/server-reply.pcm`,Buffer.concat(chunks));console.log(JSON.stringify({passed:result.passed??false,audioBytes:result.audioBytes,firstAudioMs:result.firstAudioMs,terminalMs:result.terminalMs,types:[...new Set(result.events.map(e=>e.type))]}))
}
