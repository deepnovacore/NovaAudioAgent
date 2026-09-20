// Synthetic acceptance only. No model, external service, or retained microphone audio.
import {ClientServer} from '../../../runtime/dist/src/server/client-server.js'
const port = Number(process.argv.find(v => v.startsWith('--port='))?.split('=')[1] ?? 18787)
let sequence = 0
const send = value => server.sendText(JSON.stringify(value))
const caption = (role, text) => send({type:'caption',role,text,final:true,sequence:++sequence})
const server = new ClientServer({port,token:'0123456789abcdef0123456789abcdef',
  media:{transport:'host_pcm_v1',path:'relay',audio_owner:'client',pipeline:'cascaded'},
  onClientAuthenticated: () => caption('assistant','Synthetic mobile acceptance host'),
  onAudio: () => {},
  onControl: async value => {
    if(value.type === 'input.text') {
      await caption('user',value.text)
      await caption('assistant',`Synthetic reply: ${value.text}`)
      if(value.text.includes('approval')) await send({
        type:'executor.approval', executor:'synthetic', pending_approval:true,
        pending_approval_id:'screen-check',pending_approval_busy:false,
        expires_in_seconds:value.text.includes('expired')?0:300,
        work:{project:'Synthetic project',title:'Review change'},
        operation_summary:'Confirm synthetic action',
        local_detail:{command:'echo synthetic',cwd:'/synthetic'},
        allowed_decisions:['accept','acceptForSession','decline'],
      })
    }
    if(value.type === 'input.dictation' && value.action === 'finish') {
      await send({type:'input.transcription',id:value.id,text:'Synthetic dictation result'})
    }
  },
})
await server.start()
console.log(`Synthetic host ready on ws://127.0.0.1:${port}/client/v1`)
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,() => {void server.close()})
