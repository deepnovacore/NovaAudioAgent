package com.nova.nova_audio
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONArray
import java.io.File
class AudioWireTest {
 @Test fun sharedVectors() {
  val vectors=JSONArray(File(requireNotNull(System.getProperty("nova.fixtures"))).readText())
  for(i in 0 until vectors.length()) {
   val v=vectors.getJSONObject(i)
   val data=v.getString("hex").chunked(2).map{it.toInt(16).toByte()}.toByteArray()
   if(v.getBoolean("valid")) {
    val frame=AudioWire.decode(data)
    assertEquals(v.getJSONObject("expected").getString("utterance_id"),frame.identity.utteranceId)
    assertEquals(v.getJSONObject("expected").getLong("generation_epoch"),frame.identity.epoch)
   } else { assertThrows(IllegalArgumentException::class.java) { AudioWire.decode(data) } }
  }
 }
 @Test fun floatingEpochRejected() {
  val header="""{"utterance_id":"u","generation_epoch":1.0,"sequence":0}""".toByteArray()
  val bytes=byteArrayOf(78,79,86,65,0,header.size.toByte())+header+byteArrayOf(0,0)
  assertThrows(IllegalArgumentException::class.java){AudioWire.decode(bytes)}
 }
}
