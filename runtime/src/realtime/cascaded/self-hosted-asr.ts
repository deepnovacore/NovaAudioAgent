import {WebSocket} from 'ws'
import {setTimeout as delay} from 'node:timers/promises'
import type {AsrClient,AsrSession,AsrTranscript} from './ports.js'
import {Output} from './self-hosted-tts.js'
import {selfHostedEndpoint} from '../../config/self-hosted.js'

const BUSY_RETRIES=40,BUSY_RETRY_MS=125 // about 5 s

/** One socket per utterance; ordered PCM frames, replaceable hypotheses, one final. */
export class SelfHostedAsrClient implements AsrClient {
  constructor(readonly options:{endpoint:string;apiKey:string}) {selfHostedEndpoint(options.endpoint, 'ws', 'SELF_HOSTED_ASR_URL')}
  async open(signal?:AbortSignal):Promise<AsrSession>{
    // The server keeps its single slot until an in-flight decode returns, which a cancelled utterance cannot interrupt.
    for(let attempt=0;;attempt++){
      try{return await this.connect(signal)}catch(error){
        if(!(error instanceof Error)||error.message!=='ASR busy'||attempt>=BUSY_RETRIES)throw error
        await delay(BUSY_RETRY_MS,undefined,signal?{signal}:undefined)
      }
    }
  }
  private async connect(signal?:AbortSignal):Promise<AsrSession>{
    signal?.throwIfAborted()
    const url=new URL(this.options.endpoint)
    const socket=new WebSocket(url,{headers:this.options.apiKey?{authorization:`Bearer ${this.options.apiKey}`}:{},maxPayload:32768,followRedirects:false,handshakeTimeout:10000})
    const output=new Output<AsrTranscript>()
    let closed=false,finished=false,final=false,ready=false,size=0
    let resolveReady!:()=>void,rejectReady!:(error:Error)=>void
    const connected=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject})
    const fail=(error:Error)=>{rejectReady(error);output.end(error);socket.terminate()}
    const abort=()=>fail(new Error('ASR aborted'))
    const timeout=setTimeout(()=>fail(new Error('ASR timeout')),120000)
    const readyTimeout=setTimeout(()=>fail(new Error('ASR ready timeout')),10000)
    signal?.addEventListener('abort',abort,{once:true})
    socket.on('message',(bytes,binary)=>{
      try{
        if(binary)throw Error('invalid ASR message')
        const decoded:unknown=JSON.parse((Buffer.isBuffer(bytes) ? bytes : Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes)).toString('utf8'))
        if(decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))throw Error('invalid ASR message')
        const value=decoded as Record<string,unknown>
        if(value.type==='ready'){
          if(ready||value.sampleRate!==16000||value.format!=='s16le')throw Error('invalid ASR ready')
          ready=true;clearTimeout(readyTimeout);resolveReady();return
        }
        if(value.error)throw Error('ASR server failure')
        if(!ready||final||typeof value.text!=='string'||value.text.length>4000||typeof value.final!=='boolean'||value.replace!==true||value.final&&!finished)throw Error('invalid ASR transcript')
        for(const key of ['audioMs','inferenceMs'])if(value[key]!==undefined&&(typeof value[key] !== 'number'||!Number.isFinite(value[key])||value[key]<0))throw Error('invalid ASR timing')
        output.push({text:value.text,final:value.final,replace:true})
        if(value.final){final=true;output.end();socket.close()}
      }catch(error){fail(error instanceof Error?error:new Error('ASR protocol error'))}
    })
    socket.on('error',fail)
    socket.on('close',code=>{
      clearTimeout(timeout);clearTimeout(readyTimeout);signal?.removeEventListener('abort',abort)
      if(!closed&&!final){const error=new Error(!ready&&code===1013?'ASR busy':'ASR closed before final');rejectReady(error);output.end(error)}
    })
    if(signal?.aborted)abort()
    await connected
    const send=(data:Uint8Array|string,requestSignal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
      requestSignal?.throwIfAborted();signal?.throwIfAborted()
      if(closed||socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>2080000){reject(new Error('ASR unavailable'));return}
      socket.send(data,error=>error?reject(error):resolve())
    })
    return {
      append:async(pcm,requestSignal)=>{
        if(finished||!pcm.length||pcm.length%2||pcm.length>64000||size+pcm.length>2080000)throw Error('invalid ASR input')
        size+=pcm.length;await send(pcm,requestSignal)
      },
      finish:async requestSignal=>{if(finished||!size)throw Error('invalid ASR finish');finished=true;await send('finish',requestSignal)},
      events:requestSignal=>output.events(requestSignal??signal),
      close:()=>{closed=true;clearTimeout(timeout);clearTimeout(readyTimeout);signal?.removeEventListener('abort',abort);output.end();socket.terminate();return Promise.resolve()},
    }
  }
}
