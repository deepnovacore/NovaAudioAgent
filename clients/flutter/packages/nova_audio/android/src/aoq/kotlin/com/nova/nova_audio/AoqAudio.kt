package com.nova.nova_audio

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.alibaba.aoq.clientsdk.AoqClientEngine
import com.alibaba.aoq.clientsdk.AoqClientEngine.*
import com.alibaba.aoq.clientsdk.AoqClientListener
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** Each connection gets a fresh instance; posted callbacks retain its dead/live fence. */
class AoqAudio(private val context:Context,private val event:(String,Map<String,Any>)->Unit):AoqClientListener() {
 companion object { val available:Boolean get()=Build.SUPPORTED_ABIS.any {it=="arm64-v8a"||it=="armeabi-v7a"} }
 private val main=Handler(Looper.getMainLooper())
 private var engine:AoqClientEngine?=null
 private var live=false
 private var connected=false
 private var configured=false
 private var runtime=false
 private var session=JSONObject()
 private var assistant=""
 private val pending=mutableListOf<ByteArray>()
 private var pendingBytes=0
 private val callbackBytes=AtomicInteger()
 private val watchdog=Runnable {if(live&&!configured)fail("AOQ startup timed out")}
 val running get()=live
 private fun check(code:Int){check(code==0){"AOQ operation failed ($code)"}}
 private fun field(map:Map<*,*>,key:String,max:Int=8192):String {
  val text=map[key] as? String ?: error("Missing AOQ field")
  require(text.isNotEmpty()&&text.toByteArray().size<=max);return text
 }
 fun start(payload:Map<*,*>,runtimeMode:Boolean){
  check(available && engine==null)
  val credentials=payload["credentials"] as? Map<*,*> ?: error("Missing AOQ credentials")
  runtime=runtimeMode
  if(runtime){require(payload["mode"]=="runtime"&&payload["session"]==null)}
  else {val settings=payload["session"] as? Map<*,*> ?: error("Missing session");require(!settings.containsKey("tools"));session=JSONObject(settings)}
  val config=AoqConnectConfig().apply {
   token=field(credentials,"aoqTokenForClient");sid=field(credentials,"sid");certFingerprint=field(credentials,"clientRelayCertFingerprint")
   workspaceIdHash=field(credentials["extraInfo"] as? Map<*,*> ?: emptyMap<String,Any>(),"workspaceIdHash")
   val endpoints=credentials["clientRelayEndpoints"] as? List<*> ?: error("Missing relays")
   require(endpoints.size in 1..8)
   relayEndpoints=endpoints.map {entry->val value=entry as? Map<*,*> ?: error("Invalid relay");AoqRelayEndpoint().apply {
    endpoint=field(value,"endpoint",512)
    val p=AudioWire.integer(value["port"]);require(p in 1..65535);port=p.toInt()
    val route=AudioWire.integer(value["routeIndex"]);require(route<=Int.MAX_VALUE);routeIndex=route.toInt()
   }}
   val tracks=listOf(AoqTrackParam().apply{trackType=AoqTrackType.AoqTrackTypeAudio},AoqTrackParam().apply{trackType=AoqTrackType.AoqTrackTypeData})
   publishTracks=tracks;subscribeTracks=tracks
  }
  val directory=File(context.cacheDir,"AOQ").apply{mkdirs()}
  live=true
  try {
   val client=AoqClientEngine.createEngine(context,AoqCreateConfig().apply{workDir=directory.absolutePath;enableDumpAudio=false;extras="{}"},this)
   engine=client
   fun codec(rate:Int)=AoqAudioCodecConfig().apply{trackType=AoqTrackType.AoqTrackTypeAudio;codecType=AoqEncoderType.AoqEncoderTypeAudioPCM;sampleRate=rate;channel=1}
   check(client.setAudioEncoderConfig(codec(16000)));check(client.setAudioDecoderConfig(codec(24000)))
   check(client.enableSendMediaStream(AoqTrackType.AoqTrackTypeAudio,false))
   check(client.startAudioPlayer(AoqAudioPlaybackConfig().apply{channel=1;isVoipMode=true;isDefaultSpeaker=false}))
   check(client.connect(config));main.postDelayed(watchdog,15000)
  }catch(error:Throwable){stop();throw error}
 }
 private fun send(bytes:ByteArray){val client=engine?:error("AOQ stopped");check(client.sendDataMsg(AoqDataMsg().apply{data=bytes}))}
 fun command(value:Map<*,*>){
  check(live&&runtime)
  val bytes=JSONObject(value).toString().toByteArray();require(bytes.size<=65536)
  if(connected)send(bytes) else {require(pendingBytes+bytes.size<=262144);pending.add(bytes);pendingBytes+=bytes.size}
 }
 fun mute(value:Boolean){engine?.let{check(it.muteAudioCapture(value))}}
 fun speaker(value:Boolean){engine?.let{check(it.enableSpeakerphone(value))}}
 fun clear(){engine?.let{check(it.interruptAudioPlayer(AoqTrackType.AoqTrackTypeAudio,30))}}
 fun stop(){
  live=false;connected=false;configured=false;main.removeCallbacks(watchdog);pending.clear();pendingBytes=0
  val client=engine;engine=null
  if(client!=null){client.enableSendMediaStream(AoqTrackType.AoqTrackTypeAudio,false);client.stopAudioCapture();client.stopAudioPlayer();client.disconnect();AoqClientEngine.destroy()}
 }
 private fun fail(reason:String){if(!live)return;stop();event("stopped",mapOf("reason" to reason))}
 private fun receive(bytes:ByteArray){
  if(!live)return
  try {
   val value=JSONObject(bytes.toString(Charsets.UTF_8));val type=value.optString("type")
   if(runtime) event("aoq_event",mapOf("json" to bytes.toString(Charsets.UTF_8)))
   when(type){
    "session.updated"->if(!configured){
     val client=engine?:return
     check(client.startAudioCapture(AoqAudioCaptureConfig().apply{channel=1;isVoipMode=true}))
     check(client.enableLocalAudioVolumeIndication(AoqAudioVolumeIndicationConfig().apply{interval=50;smooth=5}))
     check(client.enableSendMediaStream(AoqTrackType.AoqTrackTypeAudio,true));configured=true;main.removeCallbacks(watchdog);event("aoq_ready",emptyMap())
    }
    "input_audio_buffer.speech_started"->clear()
    "conversation.item.input_audio_transcription.completed"->event("aoq_caption",mapOf("role" to "user","text" to value.optString("transcript").take(8192)))
    "response.created"->assistant=""
    "response.audio_transcript.delta","response.output_audio_transcript.delta"->{assistant=(assistant+value.optString("delta")).take(8192);event("aoq_caption",mapOf("role" to "assistant","text" to assistant))}
    "response.function_call_arguments.done"->if(!runtime)fail("AOQ chat cannot execute tools")
    "error"->fail("AOQ service returned an error")
   }
  }catch(error:Exception){fail("Incompatible AOQ data")}
 }
 override fun onConnectionStatusChange(status:AoqConnectionStatus){main.post {
  if(!live)return@post
  try {when(status){
   AoqConnectionStatus.AoqConnectionStatusConnected->{connected=true;if(runtime){pending.forEach(::send);pending.clear();pendingBytes=0}else{send(JSONObject().put("type","session.update").put("session",session).toString().toByteArray());session=JSONObject()}}
   AoqConnectionStatus.AoqConnectionStatusFailed,AoqConnectionStatus.AoqConnectionStatusDisconnected->fail("AOQ disconnected")
   else->Unit
  }}catch(error:Exception){fail("AOQ configuration failed")}
 }}
 override fun onDataMsg(message:AoqDataMsg){
  val bytes=message.data ?: return
  if(bytes.size>65536 || callbackBytes.addAndGet(bytes.size)>262144){callbackBytes.addAndGet(-bytes.size);main.post{fail("AOQ callback backlog")};return}
  val copy=bytes.copyOf();main.post{try{receive(copy)}finally{callbackBytes.addAndGet(-copy.size)}}
 }
 override fun onLocalAudioVolumeIndication(volume:AoqAudioVolume){val level=volume.volume.coerceIn(0,255)/255.0;main.post{if(live)event("level",mapOf("level" to level))}}
 override fun onError(code:Int,message:String){main.post{fail("AOQ audio error ($code)")}}
 override fun onAudioDeviceInterrupted(interrupted:Boolean){if(interrupted)main.post{fail("Audio interrupted")}}
 override fun onAudioDeviceFocusChanged(focus:Int){if(focus<0)main.post{fail("Audio focus lost")}}
 override fun onAudioDeviceStateChanged(state:AoqAudioDeviceState){if(state.state.name.contains("Fail",ignoreCase=true))main.post{fail("AOQ audio device failed")}}
}
