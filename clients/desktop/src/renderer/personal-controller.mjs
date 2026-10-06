/** Host-owned conversations; drafts and delivery recovery are scoped to each conversation. */
const DICTATION_FAILURES={
  no_audio:'没有录到声音，请检查麦克风后再试 · 原有草稿已保留',
  no_speech:'没有听清，请再说一次 · 原有草稿已保留',
}
export class PersonalController {
  constructor({send,start,stop,applyPresentation,changed=()=>{}}) {
    Object.assign(this,{send,start,stop,applyPresentation,changed,presentationMode:'workbench',desiredPresentation:'workbench',presentationReady:!applyPresentation,presentationPending:false,presentationSequence:0,taskNotice:'',presentationRequests:new Map(),presentationInFlight:new Map(),connected:false,everConnected:false,capabilities:[],mode:'text',collapsed:false,snapshot:null,dictationId:null,dictationConversationId:null,pending:new Map(),drafts:new Map(),generation:0,inputInstance:null,captureConversationId:null,capturePending:false})
  }
  get selectedId(){return this.snapshot?.conversations?.selected_id??null}
  get voiceId(){return this.snapshot?.conversations?.voice_id??null}
  state(id=this.selectedId){if(!this.drafts.has(id))this.drafts.set(id,{draft:'',error:'',submission:null});return this.drafts.get(id)}
  get draft(){return this.state().draft} set draft(value){this.state().draft=value;if(!value.trim())this.state().source_todo=null}
  get error(){return this.state().error} set error(value){this.state().error=value}
  get submittedRequestId(){return this.state().submission?.request_id??null}
  get submittedDraft(){return this.state().submission?.text??null}
  get isVoiceConversation(){return Boolean(this.selectedId&&(this.voiceId===this.selectedId||(!this.dictationId&&['starting','voice'].includes(this.mode)&&this.captureConversationId===this.selectedId)))}
  async connect(){
    this.connected=true;this.everConnected=true;this.error='';this.capabilities=[];this.snapshot=null
    if(this.applyPresentation){
      this.presentationReady=false
      for(let attempt=0;attempt<2&&!this.presentationReady&&this.connected;attempt++){
        try{const desired=this.desiredPresentation;for(const request of [...this.presentationRequests.values()])await this.setPresentation(request.mode,{activate:false,request,reconcileOnly:request.mode!==desired});if(this.presentationMode!==desired||!this.presentationReady)await this.setPresentation(desired,{activate:false})}
        catch(error){this.error=error.message}
      }
      if(!this.presentationReady&&this.connected)await this.applyMode('background',{activate:false})
    }
    if(this.presentationReady)this.error=''
    if(this.presentationReady)for(const [id,state]of this.drafts)if(state.submission)this.sendSubmission(id,state.submission)
    this.changed()
  }
  sendSubmission(id,value){return this.send({type:'input.text',text:value.text,request_id:value.request_id,input_instance_id:value.instance,conversation_id:id,...(value.source_todo?{source_todo:value.source_todo}:{})})}
  disconnect(){
    const wasConnected=this.everConnected
    for(const state of this.drafts.values())if(state.submission&&!state.submission.restored){state.draft=[state.submission.text,state.draft].filter(Boolean).join('\n');state.source_todo=state.submission.source_todo??null;state.submission.restored=true}
    this.connected=false;this.capabilities=[];this.generation++;this.dictationId=null;this.dictationConversationId=null;this.captureConversationId=null;this.mode='text'
    for(const {reject,timer}of this.pending.values()){clearTimeout(timer);reject(new Error('连接已断开，操作状态请刷新确认'))}
    // Only a real exit after a connection ever succeeded is alarming; a cold-start
    // "never connected" disconnect() call must stay quiet.
    this.pending.clear();void this.stop();if(wasConnected)this.error='连接已断开，草稿已保留';this.changed()
  }
  setPresentation(mode,options={}){
    if(this.presentationInFlight.has(mode))return this.presentationInFlight.get(mode)
    const pending=this.changePresentation(mode,options).finally(()=>{if(this.presentationInFlight.get(mode)===pending)this.presentationInFlight.delete(mode)})
    this.presentationInFlight.set(mode,pending);return pending
  }
  async changePresentation(mode,{activate=true,request,reconcileOnly=false}={}){
    if(!['background','workbench','orb'].includes(mode))throw new Error('无效的显示模式')
    if(this.presentationPending&&mode!=='background')throw new Error('正在切换模式，请稍候')
    // A fresh return to the workbench retires the last handback notice; reconciling an earlier exit may post a new one.
    if(!request&&mode==='workbench'&&!this.presentationPending)this.taskNotice=''
    if(!request&&!this.presentationPending&&mode!=='background'){const outstanding=[...this.presentationRequests.values()];for(const prior of outstanding)if(prior.mode!==mode)await this.setPresentation(prior.mode,{activate:false,request:prior})}
    request??=[...this.presentationRequests.values()].findLast(value=>value.mode===mode)??{mode,request_id:crypto.randomUUID()}
    this.presentationRequests.set(request.request_id,request)
    const sequence=++this.presentationSequence
    if(!reconcileOnly)this.desiredPresentation=mode;this.presentationPending=true;// Only a client that may hold a task has anything to hand back.
    if(mode!=='workbench'&&this.snapshot?.tasks?.some(task=>task.controller?.kind==='user'))this.taskNotice='交还状态待确认，草稿已保留';this.presentationReady=false;this.changed()
    try{
      const local=mode==='background'?this.applyMode(mode,{activate:false}):null
      if(!this.connected){if(local)await local;else await this.applyMode(mode,{activate});this.presentationReady=false;return}
      const [,result]=await Promise.all([local,this.command('presentation.set',{mode},{request_id:request.request_id})])
      if(result?.mode!==mode)throw new Error('显示模式未确认，请重试')
      this.presentationRequests.delete(request.request_id)
      if(result.returned_task_ids?.length&&result.returned_task_ids.every(id=>Number.isSafeInteger(result.task_control_revisions?.[id])))this.taskNotice='已交还 Nova，未发送的草稿已保留'
      else if(mode!=='workbench')this.taskNotice=''
      if(sequence!==this.presentationSequence)return
      if(reconcileOnly)return
      if(mode!=='background')await this.applyMode(mode,{activate})
      this.presentationReady=true
    }catch(error){if(sequence===this.presentationSequence)this.error=error.message;throw error}
    finally{if(sequence===this.presentationSequence)this.presentationPending=false;this.changed()}
  }
  async applyMode(mode,{activate=false}={}){
    this.presentationMode=mode;this.collapsed=mode!=='workbench'
    if(mode==='background'){
      this.generation++;if(this.dictationId)this.send({type:'input.dictation',id:this.dictationId,action:'cancel',conversation_id:this.dictationConversationId})
      this.dictationId=null;this.dictationConversationId=null;this.captureConversationId=null;this.mode='text'
      await Promise.all([this.stop(),this.applyPresentation?.(mode,{activate:false})])
    }else await this.applyPresentation?.(mode,{activate})
    this.changed()
  }
  async resumeVoice({wake=true}={}){
    const id=this.voiceId
    if(!id||!this.connected||!this.presentationReady||this.presentationMode==='background'||this.capturePending||this.mode!=='text')return
    const generation=++this.generation;this.mode='starting';this.captureConversationId=id;this.changed()
    try{await this.startCapture({wake});if(generation!==this.generation){await this.stop();return}if(!this.send({type:'input.audio',conversation_id:id}))throw new Error('连接已断开');this.mode='voice'}
    catch(error){this.captureConversationId=null;this.mode='text';await this.stop();throw error}
    finally{this.changed()}
  }
  collapse(value){this.collapsed=value;if(value&&this.dictationId)void this.text();this.changed()}
  receive(frame){
    if(frame.type==='conversation.notice'&&typeof frame.conversation_id==='string'&&typeof frame.message==='string')this.state(frame.conversation_id).error=frame.message
    if(frame.type==='conversation.error'&&typeof frame.conversation_id==='string')this.state(frame.conversation_id).error='回复失败，请重试。'
    if(frame.type==='input.text_result')for(const [id,state]of this.drafts){
      const request=state.submission
      if(!request||request.request_id!==frame.request_id||(frame.conversation_id&&frame.conversation_id!==id))continue
      if(!frame.ok){state.source_todo=request.source_todo??null;if(!request.restored)state.draft=[request.text,state.draft].filter(Boolean).join('\n');state.error=frame.error==='outcome_unknown'?'主机已重启，上一条消息是否执行无法确认。草稿已保留，请先检查对话与任务再决定是否重发。':frame.error||'文字发送失败，草稿已保留'}
      else if(request.restored&&state.draft===request.text){state.draft='';state.source_todo=null}
      state.submission=null
    }
    if(['client.ready','desktop.capabilities'].includes(frame.type)){this.capabilities=frame.capabilities??[];this.inputInstance=frame.input_instance_id??null}
    if(frame.type==='personal.state'&&Number.isSafeInteger(frame.revision)&&(!this.snapshot||frame.revision>this.snapshot.revision)){
      const previous=this.selectedId;this.snapshot=frame
      if(this.applyPresentation&&this.presentationReady&&!this.presentationPending&&['background','workbench','orb'].includes(frame.presentation_mode)&&frame.presentation_mode!==this.presentationMode){this.desiredPresentation=frame.presentation_mode;void this.applyMode(frame.presentation_mode).catch(error=>{this.error=error.message;this.changed()})}
      if(this.mode==='voice'&&this.voiceId!==this.captureConversationId){this.generation++;this.mode='text';this.captureConversationId=null;void this.stop()}
      if(this.voiceId&&this.dictationId)void this.text()
      if(!previous&&this.selectedId&&this.drafts.has(null)){const scratch=this.drafts.get(null);if(scratch.draft&&!this.state().draft)this.state().draft=scratch.draft;this.drafts.delete(null)}
    }
    if(['personal.error','personal.result'].includes(frame.type)&&frame.error==='personal_frame_too_large'){
      frame={...frame,error:'个人状态或任务详情过大，暂时无法显示。操作可能已完成，请先刷新状态核对，再决定是否重试。'}
      this.error=frame.error
    }
    if(frame.type==='personal.result'){
      const entry=this.pending.get(frame.request_id)
      if(entry){clearTimeout(entry.timer);this.pending.delete(frame.request_id);frame.ok?entry.resolve(frame.data):entry.reject(Object.assign(new Error(frame.error||'操作失败'),{input_status:frame.input_status}));if(frame.reload_required)void this.command('state').catch(error=>{this.error=error.message;this.changed()})}
    }
    if(frame.type==='input.transcription'&&frame.id===this.dictationId&&(!frame.conversation_id||frame.conversation_id===this.dictationConversationId)){
      const state=this.state(this.dictationConversationId)
      if(typeof frame.text==='string'&&frame.text.trim()&&[state.draft,frame.text].filter(Boolean).join('\n').length<=4000)state.draft=[state.draft,frame.text].filter(Boolean).join('\n');else state.error=DICTATION_FAILURES[frame.error]||'recognition_failed · 原有草稿已保留'
      this.dictationId=null;this.dictationConversationId=null;this.captureConversationId=null;this.mode='text'
    }
    this.changed()
  }
  async command(method,params={},options={}){
    const notSent=message=>Object.assign(new Error(message),method==='tasks.input'?{input_status:'failed'}:{})
    if(!this.connected)throw notSent('尚未连接')
    if(this.applyPresentation&&!this.presentationReady&&!['presentation.set','state','tasks.get','tasks.list','conversations.approve'].includes(method))throw notSent('正在恢复显示模式，请稍候')
    if(this.pending.size>=32)throw notSent('请等待当前操作完成')
    const request_id=options.request_id??crypto.randomUUID()
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(request_id);reject(new Error('操作超时，请刷新状态后重试'))},30000)
      this.pending.set(request_id,{resolve,reject,timer})
      if(!this.send({type:'personal.command',request_id,method,params})){clearTimeout(timer);this.pending.delete(request_id);reject(notSent('发送失败'))}
    })
  }
  select(id){return this.command('conversations.select',{id})}
  create(){return this.command('conversations.create',{})}
  openFeed(id,label){return this.command('conversations.open_feed',{feed_id:id,label})}
  async text(){
    if(this.mode==='voice')return
    this.generation++;if(this.dictationId)this.send({type:'input.dictation',id:this.dictationId,action:'cancel',conversation_id:this.dictationConversationId})
    this.dictationId=null;this.dictationConversationId=null;this.captureConversationId=null;this.mode='text';await this.stop();this.changed()
  }
  async stopVoice(){
    const id=this.voiceId??this.captureConversationId
    this.generation++;await this.stop();this.captureConversationId=null;this.mode='text'
    if(id&&this.connected)await this.command('conversations.voice',{id,enabled:false})
    this.changed()
  }
  // `wake:false` opens the microphone without leaving sleep, so a sleeping orb keeps listening for its wake word.
  async startCapture(options){this.capturePending=true;try{await this.start(options)}finally{this.capturePending=false}}
  async voice({wake=true}={}){
    const id=this.selectedId
    if(!this.presentationReady||this.presentationMode==='background')throw new Error('请先切换到工作台或悬浮球')
    if(!id||!this.connected)throw new Error('尚未选择会话')
    if(this.capturePending||this.voiceId||this.mode!=='text')throw new Error('请先结束当前语音或录音')
    const generation=++this.generation;this.mode='starting';this.captureConversationId=id;this.changed()
    try{
      await this.command('conversations.voice',{id,enabled:true})
      if(generation!==this.generation)return
      await this.startCapture({wake})
      if(generation!==this.generation){await this.stop();return}
      if(!this.send({type:'input.audio',conversation_id:id}))throw new Error('连接已断开')
      this.mode='voice'
    }catch(error){if(generation!==this.generation)return;this.mode='text';this.captureConversationId=null;await this.stop();if(this.connected)await this.command('conversations.voice',{id,enabled:false}).catch(()=>{});throw error}
    finally{this.changed()}
  }
  async dictate(){
    const id=this.selectedId
    if(!this.presentationReady||this.presentationMode==='background'||!id||!this.connected||!this.capabilities.includes('dictation'))return
    if(this.capturePending||this.voiceId||this.mode!=='text')throw new Error('请先结束持续对话，再使用录音')
    const generation=++this.generation;this.mode='starting';this.captureConversationId=id;this.dictationConversationId=id;this.dictationId=crypto.randomUUID();this.changed()
    if(!this.send({type:'input.dictation',id:this.dictationId,action:'start',conversation_id:id})){await this.text();throw new Error('发送失败')}
    try{await this.startCapture();if(generation!==this.generation){await this.stop();return}this.mode='dictation'}
    catch(error){await this.text();throw error}finally{this.changed()}
  }
  async finish(){
    if(this.mode==='starting'&&this.dictationId)return this.text()
    if(this.mode!=='dictation')return
    const id=this.dictationId,conversationId=this.dictationConversationId;this.mode='transcribing';await this.stop();if(this.dictationId!==id)return;if(!this.send({type:'input.dictation',id,action:'finish',conversation_id:conversationId})){await this.text();this.state(conversationId).error='发送失败，草稿已保留'}this.changed()
  }
  async submit(){
    const id=this.selectedId,state=this.state(id)
    if(!this.presentationReady||!id||state.submission||this.isVoiceConversation||this.dictationConversationId===id||!this.inputInstance||!this.connected||!this.capabilities.includes('text_input')||!state.draft.trim()||state.draft.length>4000)return false
    const request={request_id:crypto.randomUUID(),text:state.draft,instance:this.inputInstance,restored:false,...(state.source_todo?{source_todo:{...state.source_todo}}:{})}
    if(!this.sendSubmission(id,request)){state.error='发送失败，草稿已保留';this.changed();return false}
    state.submission=request;state.draft='';state.source_todo=null;state.error='';this.changed();return true
  }
  /** Sends a host-composed user message (e.g. a changed execution place) without touching the draft. */
  /** Sends text to conversation `id` without touching its draft; text that cannot be sent is left in that draft instead. */
  submitText(text,id=this.selectedId){
    const state=this.state(id),keep=()=>{if(!state.draft)state.draft=text;this.changed();return false}
    if(!id||!text.trim()||text.length>4000)return false
    if(!this.presentationReady||state.submission||(id===this.selectedId?this.isVoiceConversation:this.voiceId===id)||!this.inputInstance||!this.connected||!this.capabilities.includes('text_input'))return keep()
    const request={request_id:crypto.randomUUID(),text,instance:this.inputInstance,restored:false}
    if(!this.sendSubmission(id,request)){state.error='发送失败，草稿已保留';return keep()}
    state.submission=request;state.error='';this.changed();return true
  }
}
