package com.nova.nova_audio

import android.content.Context
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

/** All playback and control state belongs to the main handler; capture has one reader. */
@Suppress("DEPRECATION")
class RelayAudio(private val context:Context, private val emit:(String,Map<String,Any>)->Unit, private val onPCM:(ByteArray)->Unit) {
 private val main=Handler(Looper.getMainLooper())
 private val manager=context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
 private val live=AtomicBoolean(false)
 private var recorder:AudioRecord?=null
 private var player:AudioTrack?=null
 private var reader:Thread?=null
 private var aec:AcousticEchoCanceler?=null
 private var ledger=PlaybackLedger()
 private data class Chunk(val bytes:ByteArray,var offset:Int=0)
 private val queue=ArrayDeque<Chunk>()
 private var started=false
 private var capture=false
 @Volatile private var muted=false
 @Volatile private var captureEpoch=0L
 private var threshold=0.045
 private var attack=0.0; private var silence=0.0; private var speaking=false
 private var timestamp=AudioTimestamp()
 private var routeReady=false
 private var focus:AudioFocusRequest?=null
 private var terminalAt:Long?=null
 private val posted=AtomicBoolean(false)
 private var postedAt=0L
 private val focusListener=AudioManager.OnAudioFocusChangeListener{value -> if(value<0 && live.get())fail("Audio focus interrupted")}
 private val routes=object:AudioDeviceCallback(){
  override fun onAudioDevicesAdded(added:Array<out AudioDeviceInfo>){if(routeReady && live.get())fail("Audio route changed")}
  override fun onAudioDevicesRemoved(removed:Array<out AudioDeviceInfo>){if(routeReady && live.get())fail("Audio route changed")}
 }
 val running get()=live.get()
 fun start(capture:Boolean,threshold:Double){
  stop();this.capture=capture;this.threshold=threshold
  try {
   manager.mode=if(capture)AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
   val attrs=AudioAttributes.Builder().setUsage(if(capture)AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
   val min=AudioTrack.getMinBufferSize(24000,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_16BIT)
   require(min>0){"24 kHz playback unsupported"}
   player=AudioTrack.Builder().setAudioAttributes(attrs).setAudioFormat(AudioFormat.Builder().setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()).setBufferSizeInBytes(maxOf(min,4800)).setTransferMode(AudioTrack.MODE_STREAM).build()
   check(player!!.state==AudioTrack.STATE_INITIALIZED){"Playback initialization failed"}
   val granted=if(Build.VERSION.SDK_INT>=26){
    focus=AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attrs).setOnAudioFocusChangeListener(focusListener,main).build()
    manager.requestAudioFocus(focus!!)
   }else{manager.requestAudioFocus(focusListener,AudioManager.STREAM_VOICE_CALL,AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)}
   check(granted==AudioManager.AUDIOFOCUS_REQUEST_GRANTED){"Audio focus unavailable"}
   if(capture){
    val minimum=AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT)
    require(minimum>0){"16 kHz microphone capture unsupported"}
    recorder=AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION).setAudioFormat(AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()).setBufferSizeInBytes(maxOf(minimum,6400)).build()
    check(recorder!!.state==AudioRecord.STATE_INITIALIZED){"Capture initialization failed"}
    aec=AcousticEchoCanceler.create(recorder!!.audioSessionId)
    if(aec?.hasControl()==true)aec?.enabled=true
    emit("aec",mapOf("available" to AcousticEchoCanceler.isAvailable(),"enabled" to (aec?.enabled==true),"has_control" to (aec?.hasControl()==true)))
   }
   live.set(true);muted=false;captureEpoch++;val epoch=captureEpoch
   manager.registerAudioDeviceCallback(routes,main)
   main.postDelayed({if(captureEpoch==epoch && live.get())routeReady=true},300)
   recorder?.startRecording()
   if(capture){reader=Thread({readCapture(epoch)},"nova-capture").also{it.start()}}
   main.post(tick)
  }catch(e:Exception){stop();throw e}
 }
 private fun readCapture(epoch:Long){
  val input=recorder ?: return
  while(live.get() && captureEpoch==epoch){
   val buffer=ByteArray(640)
   val size=try{input.read(buffer,0,buffer.size,AudioRecord.READ_BLOCKING)}catch(_:Exception){-1}
   if(!live.get() || captureEpoch!=epoch)return
   if(size<=0){main.post{if(live.get() && captureEpoch==epoch)fail("Microphone read failed")};return}
   val now=SystemClock.elapsedRealtime()
   if(!posted.compareAndSet(false,true)){
    if(now-postedAt>1000){main.post{if(captureEpoch==epoch)fail("Capture handoff stalled")};return}
    continue
   }
   postedAt=now
   val data=if(muted)ByteArray(size)else buffer.copyOf(size)
   main.post{
    try{
     if(!live.get() || captureEpoch!=epoch)return@post
     if(!muted){
      val values=ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();var sum=0.0
      while(values.hasRemaining()){val n=values.get()/32768.0;sum+=n*n}
      val rms=sqrt(sum/(data.size/2));val duration=data.size/32.0
      if(rms>=threshold){silence=0.0;if(!speaking){attack+=duration;if(attack>=50){speaking=true;attack=0.0;clearCurrent("playback.stopped");control(mapOf("type" to "speech.onset","speech_id" to java.util.UUID.randomUUID().toString(),"t_render_ms" to renderMS()))}}}
      else{attack=0.0;silence+=duration;if(silence>=180)speaking=false}
      emit("level",mapOf("level" to minOf(1.0,rms*8)))
     }
     onPCM(data)
    }finally{if(captureEpoch==epoch)posted.set(false)}
   }
  }
 }
 private val tick=object:Runnable{
  override fun run(){if(!live.get())return
   try{
    val track=player ?: return
    var writes=0
    while(queue.isNotEmpty() && writes++<4){
     val chunk=queue.first
     val count=track.write(chunk.bytes,chunk.offset,chunk.bytes.size-chunk.offset,AudioTrack.WRITE_NON_BLOCKING)
     if(count<0){fail("Playback write failed");return}
     if(count==0)break
     chunk.offset+=count;if(chunk.offset==chunk.bytes.size)queue.removeFirst()
    }
    updateRendered()
    // Missing native timestamps must not be replaced with queued-time guesses.
    if(terminalAt!=null && queue.isEmpty() && SystemClock.elapsedRealtime()-terminalAt!!>65000 && !ledger.finished){fail("Playback presentation could not be verified");return}
   }catch(_:Exception){fail("Playback failed");return}
   main.postDelayed(this,20)
  }
 }
 fun receive(frame:AudioFrame){
  updateRendered()
  if(!live.get()){if(ledger.accept(frame))clearCurrent("playback.stopped");return}
  if(!ledger.accept(frame)){if(ledger.current==frame.identity)clearCurrent("playback.stopped");return}
  queue.add(Chunk(frame.pcm));player?.play()
 }
 fun terminal(identity:PlaybackIdentity){ledger.terminal(identity);terminalAt=SystemClock.elapsedRealtime();updateRendered()}
 private fun updateRendered(){
  val id=ledger.current ?: return;val track=player ?: return
  if(track.getTimestamp(timestamp) && timestamp.nanoTime<=System.nanoTime())ledger.rendered(timestamp.framePosition,ledger.ticket)
  if(!started && ledger.renderedSamples>0){started=true;report("playback.started",id)}
  if(ledger.finished && queue.isEmpty()){report("playback.done",id,ledger.playedMS);ledger.clear(id);resetPlayer()}
 }
 fun clear(identity:PlaybackIdentity){
  if(ledger.current!=null && ledger.current!=identity)return
  if(ledger.current!=null)clearCurrent("playback.cleared") else {ledger.clear(identity);report("playback.cleared",identity,0)}
 }
 private fun clearCurrent(type:String){updateRendered();val id=ledger.current ?: return;val played=ledger.playedMS;ledger.clear(id);resetPlayer();report(type,id,played)}
 private fun resetPlayer(){player?.pause();player?.flush();queue.clear();started=false;terminalAt=null;timestamp=AudioTimestamp()}
 private fun report(type:String,id:PlaybackIdentity,played:Long?=null){val event=mutableMapOf<String,Any>("type" to type,"utterance_id" to id.utteranceId,"generation_epoch" to id.epoch,"t_render_ms" to renderMS());if(played!=null)event["played_ms"]=played;control(event)}
 private fun control(value:Map<String,Any>)=emit("control",mapOf("control" to value))
 private fun renderMS()=SystemClock.elapsedRealtimeNanos()/1e6
 fun mute(value:Boolean){muted=value;attack=0.0;silence=0.0;speaking=false;emit("level",mapOf("level" to 0.0))}
 fun speaker(enabled:Boolean){
  if(Build.VERSION.SDK_INT>=31){
   val type=if(enabled)AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
   val device=manager.availableCommunicationDevices.firstOrNull{it.type==type}
   if(device!=null)check(manager.setCommunicationDevice(device)){"Audio route unavailable"}else if(!enabled)manager.clearCommunicationDevice()else error("Speaker unavailable")
  }else{manager.isSpeakerphoneOn=enabled}
 }
 fun stop(){
  live.set(false);captureEpoch++;routeReady=false;main.removeCallbacks(tick)
  try{recorder?.stop()}catch(_:Exception){}
  reader?.join(200);reader=null;recorder?.release();recorder=null;aec?.release();aec=null
  try{clearCurrent("playback.stopped");player?.stop()}catch(_:Exception){}
  player?.release();player=null;queue.clear();posted.set(false)
  manager.unregisterAudioDeviceCallback(routes)
  if(Build.VERSION.SDK_INT>=26){focus?.let{manager.abandonAudioFocusRequest(it)};focus=null}else{manager.abandonAudioFocus(focusListener)}
  if(Build.VERSION.SDK_INT>=31)manager.clearCommunicationDevice()
  manager.mode=AudioManager.MODE_NORMAL;muted=false
 }
 fun disconnect(){stop();ledger.disconnect()}
 private fun fail(reason:String){if(!live.get())return;disconnect();emit("stopped",mapOf("reason" to reason))}
}
