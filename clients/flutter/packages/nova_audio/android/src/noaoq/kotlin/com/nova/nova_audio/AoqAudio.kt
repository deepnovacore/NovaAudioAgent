package com.nova.nova_audio
import android.content.Context
@Suppress("UNUSED_PARAMETER")
class AoqAudio(context:Context,event:(String,Map<String,Any>)->Unit){
 companion object {const val available=false}
 val running=false
 fun start(payload:Map<*,*>,runtimeMode:Boolean){error("AOQ SDK not included in this build")}
 fun command(value:Map<*,*>){error("AOQ SDK not included")}
 fun mute(value:Boolean){}
 fun speaker(value:Boolean){}
 fun clear(){}
 fun stop(){}
}
