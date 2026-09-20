package com.nova.nova_audio
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class RelayLifecycleTest {
 @Test fun playbackOnlyCanStopAndRestartWithoutMicrophone() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  instrumentation.runOnMainSync {
   val audio=RelayAudio(instrumentation.targetContext,{_,_->},{})
   try {
    repeat(3){audio.start(false,0.045);assertTrue(audio.running);audio.stop();assertFalse(audio.running)}
   } finally { audio.disconnect() }
  }
 }
 @Test fun oversizedAoqCallbackDoesNotMakeBacklogNegative() {
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  instrumentation.runOnMainSync {
   val audio=AoqAudio(instrumentation.targetContext){_,_->}
   val method=audio.javaClass.methods.firstOrNull { it.name=="onDataMsg" } ?: return@runOnMainSync
   val message=method.parameterTypes.single().getDeclaredConstructor().newInstance()
   message.javaClass.getField("data").set(message,ByteArray(65537))
   val counter=audio.javaClass.getDeclaredField("callbackBytes").apply { isAccessible=true }.get(audio) as java.util.concurrent.atomic.AtomicInteger
   repeat(3) { method.invoke(audio,message);assertEquals(0,counter.get()) }
  }
 }
}
