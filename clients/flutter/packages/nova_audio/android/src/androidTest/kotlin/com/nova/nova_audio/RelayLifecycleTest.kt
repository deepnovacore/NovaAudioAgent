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
}
