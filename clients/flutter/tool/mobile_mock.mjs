// Synthetic acceptance only. No model, external service, or retained microphone audio.
import {randomUUID} from 'node:crypto'
import {ClientServer} from '../../../runtime/dist/src/server/client-server.js'
import {applyLifeMutation, emptyLifeState} from '../../../runtime/dist/src/personal-agent/life.js'
const port = Number(process.argv.find(v => v.startsWith('--port='))?.split('=')[1] ?? 18787)
const date = new Date().toISOString()
let life=emptyLifeState(),sequence=0
for(const [kind,title] of [['todo','Prepare demo'],['idea','Explore a weekly reflection'],['goal','Ship the mobile workbench']]) life=applyLifeMutation(life,{op:'create',kind,title},kind,date).state
const state={type:'personal.state',revision:1,life,feed:[{id:'demo-feed',kind:'notify',title:'Review your demo',why_now:'Synthetic reminder',user_state:'new',lifecycle:'active',delivery:{presented_at:null}}],tasks:[],memory:{entries:[],cursor:null},pending_approvals:[],pending_confirmations:[],conversations:{selected_id:'chat:main',voice_id:null,unread_count:1,items:[{id:'chat:main',kind:'chat',title:'Nova',unread_count:0,generation:0},{id:'chat:proactive',kind:'proactive',title:'Reminders',unread_count:1,generation:0}],messages:[]}}
const histories=new Map([['chat:main',[]],['chat:proactive',[{id:'feed:demo-feed',conversation_id:'chat:proactive',role:'assistant',text:'Review your demo',created_at:date}]]])
const send = value => server.sendText(JSON.stringify(value))
const publish=()=>{state.life={...life,todos:life.todos.map(v=>({...v,kind:'todo'})),ideas:life.ideas.map(v=>({...v,kind:'idea'})),goals:life.goals.map(v=>({...v,kind:'goal',progress:{done:0,total:0}}))};state.conversations.messages=histories.get(state.conversations.selected_id)??[];return send(state)}
const caption=(role,text,conversation_id)=>send({type:'caption',role,text,conversation_id,final:true,sequence:++sequence})
function personal(command){
  const p=command.params??{},method=command.method
  let data
  if(method==='state')return {type:'personal.result',request_id:command.request_id,ok:true,data:{...state}}
  if(method==='life.mutate'){const result=applyLifeMutation(life,p,command.request_id);life=result.state;data=result.result}
  else if(method==='conversations.create'){const id=randomUUID();state.conversations.items.push({id,kind:'chat',title:'New conversation',unread_count:0,generation:0});histories.set(id,[]);state.conversations.selected_id=id}
  else if(method==='conversations.select'){if(!histories.has(p.id))throw Error('conversation_not_found');state.conversations.selected_id=p.id}
  else if(method==='conversations.voice'){state.conversations.voice_id=p.enabled?p.id:null}
  else if(method==='conversations.read'){const item=state.conversations.items.find(v=>v.id===p.id);if(!item)throw Error('conversation_not_found');item.unread_count=0;state.conversations.unread_count=state.conversations.items.reduce((n,v)=>n+v.unread_count,0)}
  else if(method==='conversations.open_feed'){state.conversations.selected_id='chat:proactive'}
  else if(method==='feed.action'){const item=state.feed.find(v=>v.id===p.id);if(!item)throw Error('feed_not_found');if(p.action==='presented')item.delivery.presented_at=new Date().toISOString();else item.user_state=p.action==='snooze'?'snoozed':p.action==='dismiss'?'dismissed':'seen'}
  else if(method==='conversations.approve'){state.pending_approvals=state.pending_approvals.filter(v=>v.approval_id!==p.approval_id);const messages=histories.get(p.id);messages?.push({id:randomUUID(),conversation_id:p.id,role:'assistant',text:p.approved?'Task completed · synthetic handoff':'Task declined',created_at:new Date().toISOString()})}
  else if(method!=='presentation.seen'&&method!=='presentation.set')throw Error('unsupported')
  state.revision++
  return {type:'personal.result',request_id:command.request_id,ok:true,data}
}
const server = new ClientServer({port,token:'0123456789abcdef0123456789abcdef',media:{transport:'host_pcm_v1',path:'relay',audio_owner:'client',pipeline:'cascaded'},
  onClientAuthenticated: async()=>{await send({type:'desktop.capabilities',capabilities:['text_input','dictation','personal'],input_instance_id:'synthetic-mobile'});await publish()},
  onAudio:()=>{},
  onControl:async value=>{
    if(value.type==='personal.command'){
      try{await send(personal(value))}catch(error){await send({type:'personal.result',request_id:value.request_id,ok:false,error:error.message})}
      await publish();return
    }
    if(value.type==='input.text'){
      const id=value.conversation_id??state.conversations.selected_id,text=`Synthetic reply: ${value.text}`
      if(!histories.has(id))throw Error('conversation_not_found')
      histories.get(id).push({id:randomUUID(),conversation_id:id,role:'user',text:value.text,created_at:new Date().toISOString()},{id:randomUUID(),conversation_id:id,role:'assistant',text,created_at:new Date().toISOString()})
      await caption('user',value.text,id);await caption('assistant',text,id)
      if(value.request_id)await send({type:'input.text_result',request_id:value.request_id,conversation_id:id,ok:true})
      if(value.text.includes('approval'))state.pending_approvals=[{approval_id:'screen-check',conversation_id:id,summary:'Confirm synthetic action',queued:false}]
      state.revision++;await publish()
    }
    if(value.type==='input.dictation'&&value.action==='finish')await send({type:'input.transcription',id:value.id,conversation_id:value.conversation_id,text:'Synthetic dictation result'})
  },
})
await server.start()
console.log(`Synthetic host ready on ws://127.0.0.1:${port}/client/v1`)
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void server.close()})
