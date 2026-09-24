import {WebSocket} from 'ws'
import {setTimeout as delay} from 'node:timers/promises'
import type {AsrClient,AsrSession,AsrTranscript} from './ports.js'
import {Output} from './http-speech.js'
import {servingEndpoint} from '../../config/local-serving.js'

/** One socket per utterance; ordered PCM frames, replaceable hypotheses, one final. */
export class StreamingAsrClient implements AsrClient {
  constructor(readonly options:{endpoint:string;apiKey:string}) {servingEndpoint.parse(options.endpoint)}
  async open(signal?:AbortSignal):Promise<AsrSession>{
    for(let attempt=0;;attempt++){
      try{return await this.connect(signal)}catch(error){
        if(!(error instanceof Error)||error.message!=='ASR busy'||attempt>=10)throw error
        await delay(100,undefined,signal?{signal}:undefined)
      }
    }
  }
  private async connect(signal?:AbortSignal):Promise<AsrSession>{
    signal?.throwIfAborted()
    const url=new URL(this.options.endpoint);url.protocol=url.protocol==='https:'?'wss:':'ws:'
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
        const value=JSON.parse(bytes.toString())
        if(value.type==='ready'){
          if(ready||value.sampleRate!==16000||value.format!=='s16le')throw Error('invalid ASR ready')
          ready=true;clearTimeout(readyTimeout);resolveReady();return
        }
        if(value.error)throw Error('ASR server: '+String(value.error).slice(0,200))
        if(!ready||final||typeof value.text!=='string'||value.text.length>4000||typeof value.final!=='boolean'||value.replace!==true||value.final&&!finished)throw Error('invalid ASR transcript')
        for(const key of ['audioMs','inferenceMs'])if(value[key]!==undefined&&(!Number.isFinite(value[key])||value[key]<0))throw Error('invalid ASR timing')
        output.push({text:value.text,final:value.final,replace:true,audioMs:value.audioMs,inferenceMs:value.inferenceMs})
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
      close:async()=>{closed=true;clearTimeout(timeout);clearTimeout(readyTimeout);signal?.removeEventListener('abort',abort);output.end();socket.terminate()},
    }
  }
}
