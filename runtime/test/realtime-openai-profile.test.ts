import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createOpenAIWireProfile} from '../src/realtime/openai-wire-profile.js'

test('OpenAI GA session uses nested audio, transcription and audio-only output modality', () => {
  const profile=createOpenAIWireProfile()
  const session=profile.session([], 'marin', 'instructions', 'gpt-realtime-2.1-mini')
  assert.equal(session.type,'realtime')
  assert.deepEqual(session.output_modalities,['audio'])
  assert.equal(session.input_audio_format,undefined)
  assert.deepEqual(session.audio,{input:{format:{type:'audio/pcm',rate:24000},transcription:{model:'gpt-transcribe'},turn_detection:{type:'server_vad'}},output:{format:{type:'audio/pcm',rate:24000},voice:'marin'}})
})
test('GA response create and item confirmations normalize without losing response identity', () => {
  const profile=createOpenAIWireProfile()
  assert.deepEqual(profile.outbound({type:'response.create',response:{modalities:['audio','text'],tool_choice:'none'}}),{type:'response.create',response:{output_modalities:['audio'],tool_choice:'none'}})
  assert.deepEqual(profile.inbound({type:'conversation.item.added',item:{id:'item'}}),{type:'conversation.item.created',item:{id:'item'}})
  assert.deepEqual(profile.inbound({type:'response.output_audio.delta',response_id:'r',item_id:'i',content_index:0,delta:'AAA='}),{type:'response.audio.delta',response_id:'r',item_id:'i',content_index:0,delta:'AAA='})
})
test('OpenAI PCM resampling retains phase across chunks and resets between connections', () => {
  const pcm=new Uint8Array(new Int16Array([100,200,300,400,500,600]).buffer)
  const whole=createOpenAIWireProfile().inputPcm(pcm)
  const profile=createOpenAIWireProfile()
  const split=Buffer.concat([profile.inputPcm(pcm.slice(0,4)),profile.inputPcm(pcm.slice(4))])
  assert.deepEqual(split,Buffer.from(whole))
  profile.reset()
  assert.deepEqual(profile.inputPcm(pcm),whole)
})
test('OpenAI cancellation rejection is normalized by error code without relying on changing prose',()=>{
 const frame=createOpenAIWireProfile().inbound({type:'error',error:{code:'response_cancel_not_active',message:'Cancellation failed: no active response found.',event_id:'cancel'}})
 assert.deepEqual(frame,{type:'error',error:{code:'invalid_value',message:'no active response found to cancel',event_id:'cancel'}})
})
