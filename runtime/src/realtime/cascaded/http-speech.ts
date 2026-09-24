import {setTimeout as delay} from 'node:timers/promises'
import type {TtsAudio, TtsClient, TtsSession} from './ports.js'
import {servingEndpoint} from '../../config/local-serving.js'

type HttpOptions = {readonly endpoint:string; readonly apiKey:string; readonly fetch?:typeof fetch}
const aborted = () => new DOMException('Speech session closed', 'AbortError')
const signalFor = (owner:AbortSignal, signal?:AbortSignal) => signal ? AbortSignal.any([owner,signal]) : owner
const headers = (key:string):Record<string,string> => key ? {authorization:`Bearer ${key}`} : {}

/** Bounded queue shared by the two HTTP adapters; no provider state escapes the session. */
export class Output<T> {
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
