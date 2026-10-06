/* eslint-disable @typescript-eslint/require-await -- Async ports reject validation errors as promises, including before network work starts. */
/** Gemini generateContent speech stages. Utterances and speech segments use bounded native requests. */
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import {abortable} from '../../core/camera-session.js'
import {readBoundedResponse} from '../../http/bounded-response.js'
import {reportUsage, type UsageReporter} from '../usage.js'
import type {AsrFactory, TtsFactory} from './ports.js'

interface SpeechOptions {
  readonly endpoint: string
  readonly apiKey: string
  readonly model: string
  readonly voice: string
  readonly fetchImpl?: typeof fetch
  readonly onUsage?: UsageReporter
}
const failure=(code:string)=>new Error(`Gemini speech ${code}`)
const resultSchema=z.object({candidates:z.array(z.object({finishReason:z.literal('STOP'),content:z.object({parts:z.array(z.object({
  text:z.string().optional(),thought:z.boolean().optional(),inlineData:z.object({mimeType:z.string(),data:z.string()}).optional(),
})).default([])})})).length(1),usageMetadata:z.object({promptTokenCount:z.number().int().nonnegative().optional(),candidatesTokenCount:z.number().int().nonnegative().optional()}).optional()})

async function generate(options:SpeechOptions,body:unknown,signal:AbortSignal) {
  const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(60_000)])
  try {
    const response=await abortable((options.fetchImpl??fetch)(`${options.endpoint}/models/${encodeURIComponent(options.model)}:generateContent`,{
      method:'POST',headers:{'x-goog-api-key':options.apiKey,'content-type':'application/json'},body:JSON.stringify(body),signal:requestSignal,
    }),requestSignal)
    if(!response.ok){void response.body?.cancel().catch(()=>{ /* Best-effort body cleanup. */ });throw failure(`http_${response.status}`)}
    const bytes=await readBoundedResponse(response,{limit:20*1024*1024,signal:requestSignal,failure})
    return resultSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
  } catch(error) {
    if(requestSignal.aborted)throw failure('aborted')
    // Never leak upstream text, keys or audio in errors.
    if(error instanceof Error && /^Gemini speech http_\d+$/.test(error.message))throw error
    throw failure('invalid_response')
  }
}

/** One result per session; cancellation also releases readers when a fetch ignores abort. */
class BatchResult<T> {
  readonly controller=new AbortController()
  readonly signal:AbortSignal
  readonly done:Promise<void>
  #settle!:()=>void
  #value:T|undefined
  #error:Error|undefined
  #started=false
  #closed=false
  constructor(signal?:AbortSignal){
    this.signal=signal?AbortSignal.any([signal,this.controller.signal]):this.controller.signal
    this.done=new Promise(resolve=>{this.#settle=resolve})
    this.signal.addEventListener('abort',()=>this.#settle(),{once:true})
  }
  assertWritable(signal?:AbortSignal){this.signal.throwIfAborted();signal?.throwIfAborted();if(this.#closed||this.#started)throw failure('session_finished')}
  async run(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal){
    this.assertWritable(signal);this.#started=true
    const owned=signal?AbortSignal.any([this.signal,signal]):this.signal
    try {const value=await abortable(work(owned),owned);owned.throwIfAborted();if(!this.#closed)this.#value=value}
    catch(error){this.#error=error instanceof Error?error:failure('request_failed');throw this.#error}finally{this.#settle()}
  }
  async value(signal?:AbortSignal):Promise<T|undefined>{
    if(signal)await abortable(this.done,signal);else await this.done
    if(this.#closed)return undefined
    this.signal.throwIfAborted();if(this.#error)throw this.#error
    return this.#value
  }
  close(){this.#closed=true;this.#value=undefined;this.controller.abort();this.#settle()}
}

export function createGeminiAsrFactory(options:SpeechOptions):AsrFactory {
  return {openClient:()=>({open:async signal=>{
    signal?.throwIfAborted();const job=new BatchResult<string>(signal);let chunks:Uint8Array[]=[];let size=0
    return {
      append:async(pcm,signal)=>{job.assertWritable(signal);if(pcm.length%2||size+pcm.length>16000*2*64)throw failure('invalid_audio');chunks.push(pcm.slice());size+=pcm.length},
      finish:signal=>job.run(async owned=>{
        if(!size)return ''
        const audio=Buffer.concat(chunks);chunks=[]
        const result=await generate(options,{contents:[{parts:[{text:'Transcribe the spoken audio verbatim in its original language. Output only the transcript, with no commentary or translation. If there is no speech, output an empty string.'},{inlineData:{mimeType:'audio/wav',data:pcmWav(audio,16000).toString('base64')}}]}],generationConfig:{temperature:0}},owned)
        const text=result.candidates[0]!.content.parts.filter(p=>!p.thought).map(p=>p.text??'').join('').trim()
        if(text.length>4000)throw failure('transcript_too_large')
        reportUsage(options.onUsage,{id:randomUUID(),provider:'gemini',service:'asr',model:options.model,status:'complete',audioDurationMs:Math.round(size/32),...(result.usageMetadata?.promptTokenCount===undefined?{}:{inputTokens:result.usageMetadata.promptTokenCount}),...(result.usageMetadata?.candidatesTokenCount===undefined?{}:{outputTokens:result.usageMetadata.candidatesTokenCount})})
        return text
      },signal),
      events:async function*(signal){const text=await job.value(signal);if(text!==undefined)yield {text,final:true}},
      close:async()=>{chunks=[];job.close()},
    }
  }})}
}
export function createGeminiTtsFactory(options:SpeechOptions):TtsFactory {
  return {openClient:()=>({open:async signal=>{
    signal?.throwIfAborted()
    const controller=new AbortController(),owned=signal?AbortSignal.any([signal,controller.signal]):controller.signal
    const queue:BatchResult<Uint8Array>[]=[]
    let wake:(()=>void)|undefined,finished=false,closed=false,sending=false,characters=0
    const close=()=>{closed=true;controller.abort();for(const job of queue)job.close();queue.length=0;wake?.()}
    return {
      sendText:async(text,signal)=>{
        owned.throwIfAborted();signal?.throwIfAborted()
        if(finished||sending)throw failure('session_finished')
        const points=[...text];characters+=points.length
        if(characters>4000)throw failure('text_too_large')
        if(!text.trim())return
        sending=true
        try {
          // The host already supplies speech segments. Bound direct callers too, without interpreting intent.
          for(let offset=0;offset<points.length;offset+=256){
            if(queue.length>=8)throw failure('audio_backlog')
            const chunk=points.slice(offset,offset+256).join(''),job=new BatchResult<Uint8Array>(owned)
            queue.push(job);wake?.()
            await job.run(async requestSignal=>{
              const result=await generate(options,{contents:[{parts:[{text:chunk}]}],generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:options.voice}}}}},requestSignal)
              reportUsage(options.onUsage,{id:randomUUID(),provider:'gemini',service:'tts',model:options.model,status:'complete',characters:[...chunk].length,...(result.usageMetadata?.promptTokenCount===undefined?{}:{inputTokens:result.usageMetadata.promptTokenCount}),...(result.usageMetadata?.candidatesTokenCount===undefined?{}:{outputTokens:result.usageMetadata.candidatesTokenCount})})
              const parts=result.candidates[0]!.content.parts.filter(p=>!p.thought&&p.inlineData).map(p=>p.inlineData!)
              if(!parts.length)throw failure('missing_audio')
              return Buffer.concat(parts.map(part=>decodeAudio(part.mimeType,part.data)))
            },signal)
          }
        }finally{sending=false}
      },
      finish:async(signal)=>{owned.throwIfAborted();signal?.throwIfAborted();if(sending||finished)throw failure('session_finished');finished=true;wake?.()},
      events:async function*(signal){
        const readSignal=signal?AbortSignal.any([owned,signal]):owned
        for(;;){
          if(closed)return
          readSignal.throwIfAborted()
          const job=queue.shift()
          if(!job){if(finished)return;await abortable(new Promise<void>(resolve=>{wake=resolve}),readSignal).catch(error=>{if(!closed)throw error});continue}
          const pcm=await job.value(signal).catch(error=>{if(!closed)throw error;return undefined})
          if(pcm)for(let i=0;i<pcm.length;i+=24000){if(closed)return;readSignal.throwIfAborted();yield {pcm:pcm.slice(i,i+24000)}}
        }
      },
      cancel:async()=>close(),close:async()=>close(),
    }
  }})}
}

function pcmWav(pcm:Uint8Array,rate:number):Buffer {
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40)
  return Buffer.concat([header,pcm])
}
function decodeAudio(mime:string,data:string):Uint8Array {
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw failure('invalid_audio')
  const raw=Buffer.from(data,'base64')
  // Gemini labels little-endian PCM as L16; keep the provider's byte order.
  if(/^audio\/(pcm|L16);(?:codec=pcm;)?rate=24000$/i.test(mime.replace(/\s+/g,''))){if(!raw.length||raw.length%2)throw failure('invalid_audio');return raw}
  if(!['audio/wav','audio/x-wav'].includes(mime)||raw.length<44||raw.toString('ascii',0,4)!=='RIFF'||raw.toString('ascii',8,12)!=='WAVE'||raw.readUInt32LE(4)!==raw.length-8)throw failure('invalid_wav')
  let valid=false;const chunks:Buffer[]=[]
  for(let pos=12;pos+8<=raw.length;){
    const tag=raw.toString('ascii',pos,pos+4),length=raw.readUInt32LE(pos+4),start=pos+8
    if(start+length>raw.length)throw failure('invalid_wav')
    if(tag==='fmt '){if(length<16||raw.readUInt16LE(start)!==1||raw.readUInt16LE(start+2)!==1||raw.readUInt32LE(start+4)!==24000||raw.readUInt16LE(start+14)!==16)throw failure('unsupported_wav');valid=true}
    if(tag==='data')chunks.push(raw.subarray(start,start+length))
    pos=start+length+(length%2)
  }
  const pcm=Buffer.concat(chunks);if(!valid||!pcm.length||pcm.length%2)throw failure('invalid_wav');return pcm
}
