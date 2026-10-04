import {canonicalJson} from '../text/canonical-json.js'
import {randomUUID} from 'node:crypto'
import {abortable} from '../core/camera-session.js'
import {frontendInstructions} from './frontend-instructions.js'
import {committedConversationPairsSchema, dispatchSourceContext, type CommittedConversationPair} from './history.js'
import type {RealtimeAdapterOptions, RealtimeSocket} from './transport.js'
import {ProviderResponseRejectedError, hostContextItemSchema, responseAdaptationContextSchema, type HostContextItem, type HostResponseIntent, type JsonObject, type RealtimeProvider, type RealtimeProviderEvent, type ResponseAdaptationContext, type ResponseOrigin, type WorkspaceContextDeliveryRecord} from './protocol.js'
import {reportUsage} from './usage.js'

const MAX_QUEUE=4096
const MAX_PENDING=128
const MAX_TEXT=4000
const object=(v:unknown):v is JsonObject => v!==null && typeof v==='object' && !Array.isArray(v)
const failure=()=>new Error('Gemini Live protocol or connection failed')

/** Native Live session. Host facts are staged locally, as in the cascaded adapter.
 * Replaceable system context uses a fresh acknowledged setup; it never masquerades as user input.
 * Internal transport replacement retains the host epoch but invalidates every old socket reader.
 */
export class GeminiLiveAdapter implements RealtimeProvider {
  readonly userResponseMode='automatic' as const
  readonly responseAdaptationMode='session_setup' as const
  readonly mediaCapability={originalImageInput:false} as const
  #options:RealtimeAdapterOptions
  readonly #id:()=>string
  #epoch=0
  #socket:RealtimeSocket|undefined
  #controller=new AbortController()
  #queue:(RealtimeProviderEvent|null)[]=[]
  #wake:(()=>void)|undefined
  #tail:Promise<void>=Promise.resolve()
  #tools:readonly JsonObject[]=[]
  #history:readonly CommittedConversationPair[]=[]
  #workspace:HostContextItem|undefined
  #adaptation:ResponseAdaptationContext|undefined
  #pending=new Map<string,{id:string;item:HostContextItem}>()
  #calls=new Map<string,{name:string;socket:RealtimeSocket}>()
  #response:{id:string;text:string;user:string;origin?:ResponseOrigin}|undefined
  #completed=new Map<string,{user:string;assistant:string}>()
  #user:{id:string;text:string}|undefined
  #latestUser=''
  #nextOrigin:ResponseOrigin|undefined
  #used=false
  #visibleResponses=new Map<string,ResponseOrigin|undefined>()
  #audioUsed=false
  #allowToolContinuation=false
  #yieldedId:string|undefined
  #toolUser=''
  #usage:JsonObject|undefined

  constructor(options:RealtimeAdapterOptions) {
    this.#options=options;this.#id=options.idFactory??randomUUID
    if(!options.apiKey || !options.model || !options.voice)throw failure()
    if(options.history)this.#history=committedConversationPairsSchema.parse(options.history)
  }
  async connect(options:{tools:readonly JsonObject[];signal:AbortSignal}) {
    if(this.#socket)throw failure()
    this.#epoch++;this.#controller=new AbortController();this.#queue=[];this.#tools=structuredClone(options.tools)
    this.#visibleResponses.clear();this.#nextOrigin=undefined;this.#audioUsed=false;this.#allowToolContinuation=false;this.#yieldedId=undefined;this.#toolUser=''
    this.#pending.clear();this.#calls.clear();this.#completed.clear();this.#response=undefined;this.#user=undefined;this.#workspace=undefined;this.#adaptation=undefined;this.#used=false
    await this.#serial(()=>this.#open(options.signal))
    return {epoch:this.#epoch,provider_session_id:`gemini-${this.#epoch}-${this.#id()}`}
  }
  async restoreHistory(history:readonly CommittedConversationPair[],signal:AbortSignal):Promise<void> {
    if(this.#used)throw failure()
    this.#history=committedConversationPairsSchema.parse(history)
    await this.#serial(()=>this.#refresh(signal))
  }
  async setLanguage(language:RealtimeAdapterOptions['language']):Promise<void> {
    if(language===this.#options.language)return
    // Language changes require a new setup. Do not mutate other provider configuration.
    this.#options={...this.#options,language:language??'zh-CN'}
    if(this.#socket)await this.#serial(()=>this.#refresh(this.#controller.signal))
  }
  async sendAudio(pcm:Uint8Array,signal:AbortSignal):Promise<void> {
    if(!pcm.length || pcm.length%2 || pcm.length>65536)throw failure()
    const data=Buffer.from(pcm).toString('base64')
    await this.#serial(async()=>{
      this.#used=true;this.#audioUsed=true
      await this.#send({realtimeInput:{audio:{mimeType:'audio/pcm;rate=16000',data}}},signal)
    })
  }
  async submitText(text:string,signal:AbortSignal):Promise<void> {
    if(!text.trim() || [...text].length>MAX_TEXT)throw failure()
    await this.#serial(async()=>{
      if(this.#response || this.#nextOrigin || this.#calls.size)throw new Error('Gemini Live response is busy')
      this.#used=true;this.#latestUser=text
      const id=this.#id();this.#emit({kind:'user_transcript_final',session_epoch:this.#epoch,item_id:id,text,input_kind:'text'})
      this.#nextOrigin={kind:'user_item',item_id:id}
      await this.#send({clientContent:{turns:[{role:'user',parts:[{text}]}],turnComplete:true}},signal)
    })
  }
  injectHostItem(input:HostContextItem,options:{confirmationTimeout:number|null;asUserActivation:boolean;signal:AbortSignal}) {
    this.#assertLocal(options.signal)
    const item=hostContextItemSchema.parse(input)
    if(item.kind==='workspace_context'||this.#pending.has(item.host_item_id)||this.#pending.size>=MAX_PENDING)throw failure()
    if(options.asUserActivation && item.kind!=='progress' && item.kind!=='final')throw failure()
    const id=`staged-${this.#id()}`
    this.#pending.set(item.host_item_id,{id,item:structuredClone(item)})
    return Promise.resolve({session_epoch:this.#epoch,host_item_id:item.host_item_id,provider_item_id:id,delivery:'staged' as const})
  }
  retireHostItem(id:string,signal:AbortSignal):Promise<void> {
    this.#assertLocal(signal)
    for(const [key,value] of this.#pending)if(value.id===id)this.#pending.delete(key)
    return Promise.resolve()
  }
  async injectWorkspaceContext(input:HostContextItem,options:{confirmationTimeout:number|null;signal:AbortSignal}):Promise<WorkspaceContextDeliveryRecord> {
    const item=hostContextItemSchema.parse(input)
    if(item.kind!=='workspace_context'||item.session_epoch!==this.#epoch)throw failure()
    return this.#serial(async()=>{
      if(this.#workspace && item.revision!<=this.#workspace.revision!)throw failure()
      this.#workspace=structuredClone(item)
      await this.#refresh(options.signal)
      return {item,asUserActivation:false,delivery:{capability:'refresh_session',delivered:true,session_epoch:this.#epoch,workspace_instance_id:item.workspace_instance_id!,revision:item.revision!,prior_provider_item_id:null,refresh_id:this.#id()}}
    })
  }
  async replaceResponseAdaptation(input:ResponseAdaptationContext,signal:AbortSignal):Promise<void> {
    const context=responseAdaptationContextSchema.parse(input)
    await this.#serial(async()=>{
      if(this.#adaptation && context.revision<this.#adaptation.revision)throw failure()
      const prior=this.#adaptation;this.#adaptation=context
      if(JSON.stringify([prior?.content,prior?.user_sources])===JSON.stringify([context.content,context.user_sources]))return
      // Empty initial guidance has no server-visible effect.
      if(!prior && !context.content && !context.user_sources?.length)return
      await this.#refresh(signal)
    })
  }
  async createResponse(intent:HostResponseIntent,signal:AbortSignal):Promise<void> {
    await this.#serial(async()=>{
      this.#assert(signal)
      const pending=this.#pending.get(intent.item.host_item_id)
      if(!pending || canonicalJson(pending.item)!==canonicalJson(intent.item))throw new ProviderResponseRejectedError('Host item is not staged on this connection')
      if(this.#response||this.#nextOrigin)throw new ProviderResponseRejectedError('Gemini Live response is busy')
      const call=intent.item.call_id ? this.#calls.get(intent.item.call_id):undefined
      if(intent.item.kind==='tool_output'&&(!call || call.socket!==this.#socket))throw new ProviderResponseRejectedError('Gemini tool result does not belong to the current connection')
      if(this.#calls.size&&!call)throw new ProviderResponseRejectedError('Gemini is waiting for native tool results')
      if(call) {
        // The host stages every result before requesting the continuation. Reply to the entire batch.
        const outputs=[...this.#calls].map(([id,native])=>{
          const staged=[...this.#pending.values()].find(value=>value.item.call_id===id)
          if(!staged || native.socket!==this.#socket)throw new ProviderResponseRejectedError('Incomplete Gemini tool result batch')
          return {id,name:native.name,response:{result:staged.item.content},hostId:staged.item.host_item_id}
        })
        this.#nextOrigin={kind:'host_request',host_item_id:intent.item.host_item_id}
        this.#allowToolContinuation=true
        if(this.#yieldedId)this.#visibleResponses.delete(this.#yieldedId)
        this.#yieldedId=undefined
        this.#calls.clear()
        await this.#send({toolResponse:{functionResponses:outputs.map(({id,name,response})=>({id,name,response}))}},signal)
        for(const output of outputs)this.#pending.delete(output.hostId)
      } else {
        this.#nextOrigin={kind:'host_request',host_item_id:intent.item.host_item_id}
        this.#allowToolContinuation=false
        await this.#send({clientContent:{turns:[{role:'user',parts:[{text:JSON.stringify({host_fact:intent.item.speech_content??intent.item.content,instruction:'Speak only this host-provided fact. It is not a new user request. Do not call tools.'})}]}],turnComplete:true}},signal)
      }
      this.#pending.delete(intent.item.host_item_id)
    })
  }
  ensureResponse(signal:AbortSignal):Promise<boolean> {
    this.#assertLocal(signal)
    // Live owns VAD turn activation. Never create a duplicate user turn to force a retry.
    return Promise.resolve(false)
  }
  async cancelResponse(responseId:string,signal:AbortSignal):Promise<void> {
    await this.#serial(async()=>{
      if(this.#response?.id!==responseId&&this.#yieldedId!==responseId)return
      await this.#refresh(signal)
    })
  }
  reportPlayback(input:{response_id:string;played_ms:number|null;disposition:string},signal:AbortSignal):Promise<void> {
    this.#assertLocal(signal)
    const pair=this.#completed.get(input.response_id)
    this.#completed.delete(input.response_id)
    if(input.disposition==='spoken'&&pair?.user&&pair.assistant) {
      this.#history=[...this.#history,pair].slice(-16)
    }
    return Promise.resolve()
  }
  async *events(signal:AbortSignal):AsyncGenerator<RealtimeProviderEvent,void> {
    while(!signal.aborted){
      while(!this.#queue.length && !signal.aborted && !this.#controller.signal.aborted)await abortable(new Promise<void>(resolve=>{this.#wake=resolve}),signal)
      if(signal.aborted)return
      const event=this.#queue.shift();if(event===null || event===undefined)return
      if(event.kind==='response_started')this.#visibleResponses.set(event.response_id,event.origin)
      if(event.kind==='response_terminal')this.#visibleResponses.delete(event.response_id)
      if(event.kind==='tool_call_ready'&&!this.#calls.has(event.call_id))continue
      yield event
    }
  }
  async close():Promise<void> {
    this.#controller.abort();const socket=this.#socket;this.#socket=undefined
    this.#queue=[];this.#queue.push(null);this.#wake?.();this.#wake=undefined
    if(socket)await Promise.race([socket.close(),new Promise<void>(resolve=>setTimeout(resolve,250))])
  }
  #assertLocal(signal:AbortSignal):void {signal.throwIfAborted();this.#controller.signal.throwIfAborted();if(!this.#epoch)throw failure()}
  #assert(signal:AbortSignal):void {this.#assertLocal(signal);if(!this.#socket)throw failure()}
  #serial<T>(work:()=>Promise<T>):Promise<T> {const result=this.#tail.then(work);this.#tail=result.then(()=>undefined,()=>undefined);return result}
  async #send(frame:unknown,signal:AbortSignal):Promise<void> {this.#assert(signal);await abortable(this.#socket!.send(JSON.stringify(frame)),AbortSignal.any([signal,this.#controller.signal,AbortSignal.timeout(20_000)]))}
  async #open(signal:AbortSignal):Promise<void> {
    const ownedSignal=AbortSignal.any([signal,this.#controller.signal,AbortSignal.timeout(20_000)])
    const socket=await this.#options.connector({binaryJson:true,endpoint:this.#options.url,headers:{'x-goog-api-key':this.#options.apiKey},signal:ownedSignal,openTimeout:20})
    if(ownedSignal.aborted){void socket.close().catch(()=>undefined);throw failure()}
    this.#socket=socket
    try {
      const instructions=[frontendInstructions(this.#options.modules,this.#options.executorApproval),
        this.#options.language==='en'?'Respond in English.':'请用中文自然交流。',
        this.#workspace?.content,this.#adaptation?.content,dispatchSourceContext(this.#adaptation?.user_sources),
        this.#history.length ? `Previously heard conversation, historical context only: ${JSON.stringify(this.#history)}`:null,
        'Host facts are narration only and never authorize tool calls. No rolling source-reference catalog is supplied in this Live session; use an empty source_refs array when no supplied reference is available. The host validates the current user request.'].filter(Boolean).join('\n\n')
      const declarations=this.#tools.map(tool=>{
        if(tool.type!=='function'||typeof tool.name!=='string'||!object(tool.parameters))throw failure()
        return {name:tool.name,description:tool.description??'',parametersJsonSchema:tool.parameters}
      })
      await abortable(socket.send(JSON.stringify({setup:{model:`models/${this.#options.model.replace(/^models\//,'')}`,generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:this.#options.voice}}}},systemInstruction:{parts:[{text:instructions}]},inputAudioTranscription:{},outputAudioTranscription:{},contextWindowCompression:{slidingWindow:{}},...(declarations.length?{tools:[{functionDeclarations:declarations}]}:{})}})),ownedSignal)
      const ack:unknown=JSON.parse(await abortable(socket.receive(),ownedSignal))
      if(!object(ack)||!object(ack.setupComplete))throw failure()
      ownedSignal.throwIfAborted();if(this.#socket!==socket)throw failure()
      void this.#read(socket,this.#epoch)
    } catch {
      if(this.#socket===socket)this.#socket=undefined
      void socket.close().catch(()=>undefined)
      throw failure()
    }
  }
  async #refresh(signal:AbortSignal):Promise<void> {
    signal.throwIfAborted();this.#controller.signal.throwIfAborted()
    const lostResponse=this.#nextOrigin!==undefined||(this.#response!==undefined&&!this.#visibleResponses.has(this.#response.id))
    const old=this.#socket;this.#socket=undefined
    // Already consumed events need terminal cleanup; queued old events must never acquire authority.
    this.#queue=[]
    for(const [id,origin] of this.#visibleResponses)this.#emit({kind:'response_terminal',session_epoch:this.#epoch,response_id:id,status:'cancelled',reason:'context_refresh',...(origin?{origin}:{})})
    this.#visibleResponses.clear();this.#response=undefined;this.#usage=undefined
    this.#calls.clear();this.#allowToolContinuation=false;this.#yieldedId=undefined;this.#toolUser=''
    // Locally staged facts have not reached any socket; only native tool outputs expire here.
    for(const [id,pending] of this.#pending)if(pending.item.kind==='tool_output')this.#pending.delete(id)
    if(this.#user)this.#emit({kind:'user_transcript_failed',session_epoch:this.#epoch,item_id:this.#user.id})
    this.#nextOrigin=undefined;this.#user=undefined;this.#latestUser=''
    if(old)void old.close().catch(()=>undefined)
    try {
      await this.#open(signal)
      if(lostResponse)this.#emit({kind:'provider_error',session_epoch:this.#epoch,code:'context_refresh_pending_response',recoverable:true})
    }catch(error){this.#emit({kind:'provider_error',session_epoch:this.#epoch,code:'context_refresh_failed',recoverable:false});throw error}
  }
  #emit(event:RealtimeProviderEvent):void {
    if(this.#controller.signal.aborted)return
    if(this.#queue.length>=MAX_QUEUE){this.#queue=[{kind:'provider_error',session_epoch:this.#epoch,code:'overflow',recoverable:false},null];this.#controller.abort();void this.#socket?.close().catch(()=>undefined)}else this.#queue.push(event)
    this.#wake?.();this.#wake=undefined
  }
  #finishUser():void {
    const user=this.#user;if(!user)return;this.#user=undefined
    this.#emit({kind:'user_transcript_final',session_epoch:this.#epoch,item_id:user.id,text:user.text,response_expected:false})
  }
  #start():{id:string;text:string;user:string;origin?:ResponseOrigin} {
    if(!this.#response){
      // Native audio/transcription streams have no response-to-input identity. Never infer one.
      const origin=this.#nextOrigin?.kind==='host_request' || !this.#audioUsed ? this.#nextOrigin : undefined
      this.#response={id:this.#id(),text:'',user:origin?.kind==='user_item'?this.#latestUser:origin?.kind==='host_request'&&this.#allowToolContinuation?this.#toolUser:'',origin:origin??{kind:'unknown'}};this.#nextOrigin=undefined
      this.#emit({kind:'response_started',session_epoch:this.#epoch,response_id:this.#response.id,...(this.#response.origin?{origin:this.#response.origin}:{})})
    }
    return this.#response
  }
  #terminal(status:'completed'|'cancelled'|'failed'|'yielded'):void {
    const response=this.#response;if(!response)return
    if(response.text)this.#emit({kind:'response_transcript_final',session_epoch:this.#epoch,response_id:response.id,text:response.text})
    if(status==='yielded'){
      this.#yieldedId=response.id;this.#toolUser=response.user
      this.#emit({kind:'response_yielded',session_epoch:this.#epoch,response_id:response.id,reason:'tool_calls',call_ids:[...this.#calls.keys()]})
      this.#response=undefined
      return
    }
    else this.#emit({kind:'response_terminal',session_epoch:this.#epoch,response_id:response.id,status,reason:status,...(response.origin?{origin:response.origin}:{})})
    if(status==='completed'&&!this.#audioUsed&&response.user && response.text){this.#completed.set(response.id,{user:response.user,assistant:response.text});if(this.#completed.size>32)this.#completed.delete(this.#completed.keys().next().value!)}
    const usage=this.#usage;const inputTokens=tokenCount(usage?.promptTokenCount),outputTokens=tokenCount(usage?.responseTokenCount??usage?.candidatesTokenCount);reportUsage(this.#options.onUsage,{id:response.id,service:'realtime',provider:'gemini',model:this.#options.model,status:usage?'complete':'missing',...(inputTokens===undefined?{}:{inputTokens}),...(outputTokens===undefined?{}:{outputTokens})});this.#usage=undefined
    this.#response=undefined;this.#allowToolContinuation=false;this.#toolUser=''
  }
  async #read(socket:RealtimeSocket,epoch:number):Promise<void> {
    try {
      while(this.#socket===socket&&!this.#controller.signal.aborted){
        const raw=await socket.receive();if(this.#socket!==socket||epoch!==this.#epoch)return
        if(raw.length>2*1024*1024)throw failure()
        const event:unknown=JSON.parse(raw);if(!object(event)||event.error)throw failure()
        if(object(event.usageMetadata))this.#usage=event.usageMetadata
        if(event.goAway){this.#emit({kind:'provider_error',session_epoch:epoch,code:'disconnected',recoverable:true});break}
        if(object(event.toolCallCancellation)) {
          let cancelled=false
          for(const id of array(event.toolCallCancellation.ids)){
            if(typeof id!=='string')throw failure()
            cancelled=this.#calls.delete(id)||cancelled
          }
          if(cancelled&&this.#calls.size){
            // The host owns an atomic batch. A partial cancellation invalidates that batch.
            this.#calls.clear();this.#queue=[]
            this.#emit({kind:'provider_error',session_epoch:epoch,code:'tool_batch_cancelled',recoverable:true})
            break
          }
          if(!this.#calls.size&&this.#yieldedId){
            this.#emit({kind:'response_terminal',session_epoch:epoch,response_id:this.#yieldedId,status:'cancelled',reason:'tool_call_cancelled'})
            this.#yieldedId=undefined
          }
        }
        const content=event.serverContent
        if(object(content)) {
          if(object(content.inputTranscription)&&typeof content.inputTranscription.text==='string') {
            this.#user??={id:this.#id(),text:''}
            this.#user.text+=content.inputTranscription.text;if([...this.#user.text].length>MAX_TEXT)throw failure()
            this.#emit({kind:'user_transcript_delta',session_epoch:epoch,item_id:this.#user.id,text:content.inputTranscription.text})
          }
          if(object(content.inputTranscription)&&content.inputTranscription.finished===true)this.#finishUser()
          if(content.interrupted){
            if(!this.#response&&this.#nextOrigin){
              this.#emit({kind:'provider_error',session_epoch:epoch,code:'interrupted_pending_response',recoverable:true})
              break
            }
            this.#terminal('cancelled');continue
          }
          if(object(content.modelTurn))for(const part of array(content.modelTurn.parts)) {
            if(!object(part))throw failure()
            if(object(part.inlineData)) {
              if(typeof part.inlineData.mimeType!=='string'||!/^audio\/pcm(?:;rate=24000)?$/.test(part.inlineData.mimeType)||typeof part.inlineData.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.inlineData.data))throw failure()
              const pcm=Buffer.from(part.inlineData.data,'base64');if(!pcm.length||pcm.length%2)throw failure()
              const response=this.#start();this.#emit({kind:'response_audio_delta',session_epoch:epoch,response_id:response.id,pcm})
            }
          }
          if(object(content.outputTranscription)&&typeof content.outputTranscription.text==='string') {
            const response=this.#start();response.text+=content.outputTranscription.text;if([...response.text].length>MAX_TEXT)throw failure()
            this.#emit({kind:'response_transcript_delta',session_epoch:epoch,response_id:response.id,text:content.outputTranscription.text})
          }
          if(content.turnComplete)this.#terminal('completed')
        }
        if(object(event.toolCall)) {
          if(this.#yieldedId)throw failure()
          const response=this.#start()
          const calls=array(event.toolCall.functionCalls)
          const trusted=!this.#audioUsed&&(response.origin?.kind==='user_item'||(response.origin?.kind==='host_request'&&this.#allowToolContinuation))
          if(!calls.length||calls.length>MAX_PENDING)throw failure()
          const validated=calls.map(call=>{
            if(!object(call)||typeof call.id!=='string'||!call.id||typeof call.name!=='string'||!object(call.args))throw failure()
            return {id:call.id,name:call.name,args:call.args}
          })
          if(new Set(validated.map(call=>call.id)).size!==validated.length)throw failure()
          if(!trusted){
            const functionResponses=validated.map(call=>({id:call.id,name:call.name,response:{error:{code:'unverified_input_origin',message:'Tool execution requires a separate text-only connection or the cascaded pipeline.'}}}))
            // A refusal belongs to the socket that issued the calls, even during a concurrent refresh.
            await abortable(socket.send(JSON.stringify({toolResponse:{functionResponses}})),AbortSignal.any([this.#controller.signal,AbortSignal.timeout(20_000)]))
            if(this.#socket!==socket)return
          }else for(const call of validated){
            this.#calls.set(call.id,{name:call.name,socket})
            this.#emit({kind:'tool_call_ready',session_epoch:epoch,response_id:response.id,item_id:call.id,call_id:call.id,name:call.name,arguments:call.args})
          }
          if(trusted&&calls.length)this.#terminal('yielded')
        }
      }
    }catch{if(this.#socket===socket&&!this.#controller.signal.aborted){this.#terminal('failed');this.#emit({kind:'provider_error',session_epoch:epoch,code:'protocol_error',recoverable:false})}}
    finally{if(this.#socket===socket){this.#queue.push(null);this.#wake?.();this.#wake=undefined}}
  }
}

function array(value:unknown):unknown[]{if(!Array.isArray(value))throw failure();return value as unknown[]}
function tokenCount(value:unknown):number|undefined{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined}
