package com.nova.nova_audio
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
object AudioWire {
 const val MAX_INTEGER=9007199254740991L
 fun integer(value:Any?,min:Long=0):Long {
  require(value is Int || value is Long){"Invalid integer"}
  val n=(value as Number).toLong();require(n in min..MAX_INTEGER);return n
 }
 fun identity(value:Map<*,*>):PlaybackIdentity {
  val id=value["utterance_id"] as? String ?: throw IllegalArgumentException("Missing identity")
  require(id.trim().isNotEmpty() && id.codePointCount(0,id.length)<=256)
  return PlaybackIdentity(id,integer(value["generation_epoch"],1))
 }
 fun decode(bytes:ByteArray):AudioFrame {
  try {
   require(bytes.size in 8..(6+2048+65536) && bytes.take(4)==listOf<Byte>(78,79,86,65))
   val size=((bytes[4].toInt() and 255) shl 8) or (bytes[5].toInt() and 255)
   require(size in 2..2048 && 6+size<bytes.size)
   val pcm=bytes.copyOfRange(6+size,bytes.size);require(pcm.size<=65536 && pcm.size%2==0)
   val text=Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes,6,size)).toString()
   val obj=JSONObject(text)
   val id=identity(mapOf("utterance_id" to obj.get("utterance_id"),"generation_epoch" to obj.get("generation_epoch")))
   return AudioFrame(id,integer(obj.get("sequence")),pcm)
  } catch(e:Exception){throw IllegalArgumentException("Invalid NOVA audio frame",e)}
 }
}
