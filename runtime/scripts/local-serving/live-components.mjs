import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {createQwenCascadedLlmFactory} from '../../dist/src/realtime/cascaded/qwen-llm.js'
import {BreezeTtsClient} from '../../dist/src/realtime/cascaded/http-speech.js'
const result={startedAt:new Date().toISOString()}
const signal=AbortSignal.timeout(120000)
const llm=createQwenCascadedLlmFactory({provider:'openai-compatible',baseUrl:'http://127.0.0.1:18101/v1',apiKey:'local',model:'Qwen/Qwen3.5-4B',instructions:'你是测试助手。用户要求调用工具时必须调用。工具完成后只简短确认结果。'}).open()
try{
 result.tool=await Array.fromAsync(llm.stream({inputs:[{kind:'user_text',text:'调用 echo 工具，text 为本地验收。'}],tools:[{name:'echo',description:'Echo the text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}],signal}))
 const call=result.tool.find(e=>e.kind==='tool_call');assert.equal(call?.name,'echo');assert.equal(call.arguments.text,'本地验收')
 result.toolResult=await Array.fromAsync(llm.stream({inputs:[{kind:'tool_result',call_id:call.call_id,output:{text:'本地验收',success:true}}],tools:[],signal}))
 assert.ok(result.toolResult.some(e=>e.kind==='text_delta'&&e.text));assert.ok(result.toolResult.some(e=>e.kind==='response_completed'))
}finally{await llm.close()}
const client=new BreezeTtsClient({endpoint:'http://127.0.0.1:18103/v1/audio/speech',apiKey:'',instruction:'自然清晰的中文语音'})
const session=await client.open(signal)
try{
 let frames=0,first=0,cancelMs=0
 const reading=(async()=>{for await(const audio of session.events()){assert.ok(audio.pcm.length>0);frames++;if(frames===1){first=performance.now();await session.cancel();cancelMs=performance.now()-first}}})()
 await session.sendText('这是一段用于测试取消的语音。请在第一段音频生成后停止播放，后续内容应当被取消。')
 const finish=session.finish().catch(()=>{})
 await reading.catch(error=>{if(error.name!=='AbortError')throw error});await finish
 assert.equal(frames,1,'late audio after cancel');result.cancel={frames,cancelMs}
}finally{await session.close()}
// Cancellation must also release upstream serving capacity, not only local playback.
const following=await client.open(signal)
try{
 const chunks=Array.fromAsync(following.events());void chunks.catch(()=>{})
 await following.sendText('取消后的新请求成功。');await following.finish()
 const audio=await chunks;result.afterCancelBytes=audio.reduce((sum,x)=>sum+x.pcm.length,0);assert.ok(result.afterCancelBytes>0)
}finally{await following.close()}
result.passed=true
console.log(JSON.stringify(result,null,2))
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2))
