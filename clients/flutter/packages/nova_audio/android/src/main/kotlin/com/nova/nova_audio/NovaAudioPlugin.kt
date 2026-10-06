package com.nova.nova_audio

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.pm.PackageManager
import android.media.audiofx.AcousticEchoCanceler
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.*
import java.nio.ByteBuffer
import java.nio.ByteOrder

class NovaAudioPlugin:FlutterPlugin,MethodChannel.MethodCallHandler,ActivityAware,PluginRegistry.RequestPermissionsResultListener,Application.ActivityLifecycleCallbacks {
 private lateinit var channel:MethodChannel
 private lateinit var pcm:BasicMessageChannel<ByteBuffer>
 private lateinit var audio:RelayAudio
 private lateinit var context:android.content.Context
 private var aoq:AoqAudio?=null
 private val main=Handler(Looper.getMainLooper())
 private var generation:Long?=null
 private var activity:Activity?=null
 private var binding:ActivityPluginBinding?=null
 private var permission:MethodChannel.Result?=null
 private var serial=0L
 private var pending:Long?=null
 private var pendingAt=0L
 private val requestCode=19743
 override fun onAttachedToEngine(engine:FlutterPlugin.FlutterPluginBinding){
  channel=MethodChannel(engine.binaryMessenger,"nova/audio");channel.setMethodCallHandler(this)
  pcm=BasicMessageChannel(engine.binaryMessenger,"nova/audio/pcm",BinaryCodec.INSTANCE)
  context=engine.applicationContext
  audio=RelayAudio(context,::event,::deliver)
 }
 private fun event(kind:String,fields:Map<String,Any>){
  val id=generation ?: return
  channel.invokeMethod("event",fields+mapOf("kind" to kind,"generation" to id))
 }
 private fun resetHandoff(){serial++;pending=null}
 private fun deliver(data:ByteArray){
  val id=generation ?: return
  if(pending!=null){if(SystemClock.elapsedRealtime()-pendingAt>=1000)fail("Capture handoff stalled");return}
  val ticket=++serial;pending=ticket;pendingAt=SystemClock.elapsedRealtime()
  val buffer=ByteBuffer.allocateDirect(8+data.size).order(ByteOrder.BIG_ENDIAN)
  buffer.putLong(id);buffer.put(data)
  pcm.send(buffer){main.post{if(generation==id && pending==ticket)pending=null}}
  main.postDelayed({if(generation==id && pending==ticket)fail("Capture handoff stalled")},1100)
 }
 private fun fail(reason:String){aoq?.stop();aoq=null;audio.disconnect();resetHandoff();event("stopped",mapOf("reason" to reason));generation=null}
 override fun onMethodCall(call:MethodCall,result:MethodChannel.Result){
  try {
   when(call.method){
    "capabilities"->{result.success(mapOf("relay" to true,"aoq" to AoqAudio.available,"aec_available" to AcousticEchoCanceler.isAvailable()));return}
    "requestMicrophone"->{
     val host=activity
     if(host==null){result.success(false);return}
     if(host.checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED){result.success(true);return}
     if(permission!=null){result.error("permission_busy","A microphone request is already pending",null);return}
     permission=result;host.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO),requestCode);return
    }
    "startAoq"->{
     check(activity!=null && activity!!.checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED)
     val id=AudioWire.integer(call.argument<Any>("generation"))
     aoq?.stop();audio.disconnect();resetHandoff();generation=id
     val owner=AoqAudio(context){kind,fields->if(generation==id)event(kind,fields)}
     aoq=owner
     owner.start(call.argument<Map<String,Any>>("payload") ?: error("Missing AOQ payload"),call.argument<Boolean>("runtime")==true)
     result.success(null);return
    }
    "startRelay"->{
     check(activity!=null){"Application is not active"}
     val id=AudioWire.integer(call.argument<Any>("generation"))
     val capture=call.argument<Boolean>("capture") ?: error("Capture flag required")
     val threshold=call.argument<Double>("threshold") ?: error("Threshold required")
     require(threshold.isFinite() && threshold in 0.0..1.0)
     aoq?.stop();aoq=null;audio.disconnect();resetHandoff();generation=id
     audio.start(capture,threshold);result.success(null);return
    }
    "disconnect"->{aoq?.stop();aoq=null;audio.disconnect();resetHandoff();generation=null;result.success(null);return}
   }
   val args=call.arguments as? Map<*,*> ?: emptyMap<Any,Any>()
   if(generation==null || (args["generation"] as? Number)?.toLong()!=generation){result.success(null);return}
   when(call.method){
    "aoqCommand"->aoq?.command(args["event"] as? Map<*,*> ?: error("Missing event"))
    "aoqClear"->aoq?.clear()
    "enqueue"->audio.receive(AudioWire.decode(args["frame"] as? ByteArray ?: error("Audio frame missing")))
    "terminal"->audio.terminal(AudioWire.identity(args))
    "clear"->audio.clear(AudioWire.identity(args))
    "mute"->{val value=args["muted"] as? Boolean ?: error("Mute flag missing");if(aoq!=null)aoq?.mute(value) else audio.mute(value)}
    "speaker"->{val value=args["enabled"] as? Boolean ?: error("Speaker flag missing");if(aoq!=null)aoq?.speaker(value) else audio.speaker(value)}
    "stop"->{aoq?.stop();aoq=null;audio.stop();resetHandoff();generation=null}
    else->{result.notImplemented();return}
   }
   result.success(null)
  }catch(e:Throwable){aoq?.stop();aoq=null;audio.disconnect();resetHandoff();generation=null;result.error("audio_failed",e.message,null)}
 }
 override fun onRequestPermissionsResult(code:Int,permissions:Array<out String>,results:IntArray):Boolean {
  if(code!=requestCode)return false
  permission?.success(results.isNotEmpty() && results[0]==PackageManager.PERMISSION_GRANTED);permission=null;return true
 }
 override fun onAttachedToActivity(value:ActivityPluginBinding){binding=value;activity=value.activity;value.addRequestPermissionsResultListener(this);value.activity.application.registerActivityLifecycleCallbacks(this)}
 override fun onDetachedFromActivityForConfigChanges(){detachActivity()}
 override fun onReattachedToActivityForConfigChanges(value:ActivityPluginBinding){onAttachedToActivity(value)}
 override fun onDetachedFromActivity(){detachActivity()}
 private fun detachActivity(){binding?.removeRequestPermissionsResultListener(this);activity?.application?.unregisterActivityLifecycleCallbacks(this);binding=null;activity=null;permission?.success(false);permission=null;if(audio.running || aoq?.running==true)fail("Activity detached")}
 override fun onDetachedFromEngine(engine:FlutterPlugin.FlutterPluginBinding){detachActivity();audio.disconnect();channel.setMethodCallHandler(null);generation=null;resetHandoff()}
 override fun onActivityStopped(value:Activity){if(value==activity && (audio.running || aoq?.running==true))fail("Application backgrounded")}
 override fun onActivityCreated(a:Activity,state:Bundle?){}
 override fun onActivityStarted(a:Activity){}
 override fun onActivityResumed(a:Activity){}
 override fun onActivityPaused(a:Activity){}
 override fun onActivitySaveInstanceState(a:Activity,state:Bundle){}
 override fun onActivityDestroyed(a:Activity){}
}
