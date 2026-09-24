import {readFile, stat} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import type {AsrClient, AsrSession, AsrTranscript, TtsAudio, TtsClient, TtsSession} from './ports.js'
import {servingEndpoint} from '../../config/local-serving.js'

type HttpOptions = {readonly endpoint:string; readonly apiKey:string; readonly fetch?:typeof fetch}
const aborted = () => new DOMException('Speech session closed', 'AbortError')
const signalFor = (owner:AbortSignal, signal?:AbortSignal) => signal ? AbortSignal.any([owner,signal]) : owner
const headers = (key:string):Record<string,string> => key ? {authorization:`Bearer ${key}`} : {}

/** Bounded queue shared by the two HTTP adapters; no provider state escapes the session. */
class Output<T> {
  #controller!:ReadableStreamDefaultController<T>
  #ended=false
  readonly stream = new ReadableStream<T>({start:c=>{this.#controller=c},cancel:()=>{this.#ended=true}}, {highWaterMark:128})
  push(value:T):void {
    if(this.#ended)return
    if((this.#controller.desiredSize??0)<=0)throw new Error('speech output overflow')
    this.#controller.enqueue(value)
  }
  end(error?:unknown):void {
    if(this.#ended)return
    this.#ended=true
    if(error)this.#controller.error(error);else this.#controller.close()
  }
  async *events(signal?:AbortSignal):AsyncIterable<T>{
    const reader=this.stream.getReader()
    const cancel=()=>{void reader.cancel(signal?.reason).catch(()=>{})}
    signal?.addEventListener('abort',cancel,{once:true})
    try {
      signal?.throwIfAborted()
      for(;;){const item=await reader.read();signal?.throwIfAborted();if(item.done)return;yield item.value}
    }finally{signal?.removeEventListener('abort',cancel);reader.releaseLock()}
  }
}

function wav(pcm:Uint8Array):Uint8Array<ArrayBuffer>{
  const bytes=new Uint8Array(44+pcm.byteLength),view=new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('RIFF'),0);view.setUint32(4,36+pcm.byteLength,true)
  bytes.set(new TextEncoder().encode('WAVEfmt '),8);view.setUint32(16,16,true)
  view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true)
  view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true)
  bytes.set(new TextEncoder().encode('data'),36);view.setUint32(40,pcm.byteLength,true);bytes.set(pcm,44)
  return bytes
}

export class CocktailAsrClient implements AsrClient {
  constructor(readonly options:HttpOptions & {readonly referenceAudio:string}) {servingEndpoint.parse(options.endpoint)}
  async open(signal?:AbortSignal):Promise<AsrSession>{
    signal?.throwIfAborted()
    const info=await stat(this.options.referenceAudio)
    if(!info.isFile()||info.size>2*1024*1024||info.size<44)throw new Error('invalid ASR reference audio')
    const reference=new Uint8Array(await readFile(this.options.referenceAudio))
    signal?.throwIfAborted()
    const controller=new AbortController(),output=new Output<AsrTranscript>(),chunks:Uint8Array[]=[]
    let size=0,finished=false,closed=false,task=Promise.resolve()
    const combined=signalFor(controller.signal,signal)
    return {
      append:async(pcm,requestSignal)=>{
        combined.throwIfAborted();requestSignal?.throwIfAborted()
        if(finished||closed||pcm.byteLength%2||size+pcm.byteLength>16000*2*60)throw new Error('invalid ASR input')
        chunks.push(new Uint8Array(pcm));size+=pcm.byteLength
      },
      finish:async requestSignal=>{
        if(finished||closed)throw new Error('ASR already finished')
        finished=true
        // Submission must not hold the adapter's speech-admission queue during inference.
        task=(async()=>{try {
          if(!size)throw new Error('empty ASR input')
          const pcm=new Uint8Array(size);let offset=0
          for(const chunk of chunks){pcm.set(chunk,offset);offset+=chunk.byteLength}chunks.length=0
          const body=new FormData();body.set('file',new Blob([wav(pcm)],{type:'audio/wav'}),'utterance.wav')
          body.set('reference_audio',new Blob([reference],{type:'audio/wav'}),'reference.wav')
          const response=await (this.options.fetch??fetch)(this.options.endpoint,{method:'POST',body,headers:headers(this.options.apiKey),redirect:'error',signal:AbortSignal.any([signalFor(combined,requestSignal),AbortSignal.timeout(120000)])})
          if(!response.ok){await response.body?.cancel();throw new Error(`ASR HTTP ${response.status}`)}
          if(!response.body)throw new Error('ASR missing body')
          const reader=response.body.getReader();let raw=''
          const decoder=new TextDecoder()
          try {for(;;){const part=await reader.read();if(part.done)break;raw+=decoder.decode(part.value,{stream:true});if(raw.length>32768)throw new Error('ASR response overflow')}}
          finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
          raw+=decoder.decode()
          const result:unknown=JSON.parse(raw)
          if(typeof result!=='object'||result===null||!('text' in result)||typeof result.text!=='string'||result.text.length>4000)throw new Error('invalid ASR response')
          combined.throwIfAborted();requestSignal?.throwIfAborted()
          output.push({text:result.text,final:true});output.end()
        }catch(error){output.end(error)}})()
      },
      events:requestSignal=>output.events(signalFor(combined,requestSignal)),
      close:async()=>{closed=true;controller.abort(aborted());chunks.length=0;output.end();await task},
    }
  }
}

export class BreezeTtsClient implements TtsClient {
  constructor(readonly options:HttpOptions & {readonly instruction:string}) {servingEndpoint.parse(options.endpoint)}
  async open(signal?:AbortSignal):Promise<TtsSession>{
    signal?.throwIfAborted()
    const controller=new AbortController(),combined=signalFor(controller.signal,signal),output=new Output<TtsAudio>()
    let buffer='',total=0,finished=false,tail=Promise.resolve(),timer:ReturnType<typeof setTimeout>|undefined
    const fail=(error:unknown)=>{if(timer)clearTimeout(timer);timer=undefined;buffer='';controller.abort(error);output.end(error)}
    const synthesize=async(text:string)=>{
      combined.throwIfAborted()
      const body=new FormData();body.set('text',text);body.set('instruction',this.options.instruction)
      const requestSignal=AbortSignal.any([combined,AbortSignal.timeout(60000)])
      let response:Response
      // A disconnected Breeze request may still be finishing its current GPU chunk.
      for(let attempt=0;;attempt++){
        response=await (this.options.fetch??fetch)(this.options.endpoint,{method:'POST',body,headers:headers(this.options.apiKey),redirect:'error',signal:requestSignal})
        if(response.status!==409||attempt>=15)break
        await response.body?.cancel();await delay(200,undefined,{signal:requestSignal})
      }
      if(!response.ok||!response.body){await response.body?.cancel();throw new Error(`TTS HTTP ${response.status}`)}
      if(response.headers.get('x-sample-rate')!=='24000'||response.headers.get('x-sample-format')!=='s16le'||!response.headers.get('content-type')?.startsWith('audio/pcm')){await response.body.cancel();throw new Error('invalid TTS audio format')}
      const reader=response.body.getReader();let leftover:Uint8Array=new Uint8Array(),bytes=0
      try {
        for(;;){
          const part=await reader.read();combined.throwIfAborted();if(part.done)break
          bytes+=part.value.byteLength;if(bytes>24000*2*120)throw new Error('TTS audio overflow')
          const joined=new Uint8Array(leftover.length+part.value.length);joined.set(leftover);joined.set(part.value,leftover.length)
          const even=joined.length-(joined.length%2)
          for(let start=0;start<even;start+=32768)output.push({pcm:joined.slice(start,Math.min(start+32768,even))})
          leftover=joined.slice(even)
        }
        if(leftover.length||!bytes)throw new Error('incomplete TTS audio')
      }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
    }
    const enqueue=(text:string)=>{if(!text.trim())return;tail=tail.then(()=>synthesize(text));void tail.catch(fail)}
    const flush=()=>{if(timer)clearTimeout(timer);timer=undefined;const text=buffer;buffer='';enqueue(text)}
    const stop=async()=>{if(timer)clearTimeout(timer);buffer='';finished=true;controller.abort(aborted());output.end();await tail.catch(()=>{})}
    return {
      sendText:async(text,requestSignal)=>{
        combined.throwIfAborted();requestSignal?.throwIfAborted()
        if(finished||total+text.length>32000)throw new Error('invalid TTS text')
        total+=text.length;buffer+=text
        for(;;){const match=buffer.match(/^([\s\S]*?[。！？!?\n]|[\s\S]{160})/u);if(!match)break;buffer=buffer.slice(match[0].length);enqueue(match[0])}
        if(buffer&&!timer)timer=setTimeout(flush,250)
      },
      finish:async requestSignal=>{requestSignal?.throwIfAborted();combined.throwIfAborted();if(finished)throw new Error('TTS already finished');finished=true;flush();await tail;combined.throwIfAborted();output.end()},
      cancel:stop,close:stop,
      events:requestSignal=>output.events(signalFor(combined,requestSignal)),
    }
  }
}
