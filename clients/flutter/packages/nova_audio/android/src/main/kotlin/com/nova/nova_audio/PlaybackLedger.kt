package com.nova.nova_audio

data class PlaybackIdentity(val utteranceId: String, val epoch: Long)
data class AudioFrame(val identity: PlaybackIdentity, val sequence: Long, val pcm: ByteArray)
class PlaybackLedger(private val maxSamples: Long = 24000L * 60) {
 var current: PlaybackIdentity? = null; private set
 var ticket = 0L; private set
 var acceptedSamples = 0L; private set
 var renderedSamples = 0L; private set
 private var nextSequence = 0L
 private var fencedEpoch = 0L
 private var ended = false
 val playedMS get() = renderedSamples * 1000 / 24000
 val finished get() = current != null && ended && renderedSamples == acceptedSamples
 fun accept(frame: AudioFrame): Boolean {
  if(frame.identity.epoch <= fencedEpoch || ended || frame.pcm.size/2 + acceptedSamples-renderedSamples > maxSamples || frame.sequence != nextSequence || (current != null && current != frame.identity)) return false
  current=frame.identity; nextSequence++; acceptedSamples+=frame.pcm.size/2; return true
 }
 fun rendered(samples:Long, ticket:Long) { if(ticket==this.ticket && current!=null) renderedSamples=maxOf(renderedSamples,minOf(acceptedSamples,maxOf(0,samples))) }
 fun terminal(identity:PlaybackIdentity):Boolean {if(current==identity)ended=true;return finished}
 fun clear(identity:PlaybackIdentity) {if(current!=null && current!=identity)return;fencedEpoch=maxOf(fencedEpoch,identity.epoch);reset()}
 fun disconnect(){fencedEpoch=0;reset()}
 private fun reset(){current=null;ticket++;acceptedSamples=0;renderedSamples=0;nextSequence=0;ended=false}
}
class PlaybackHead {
 private var last=0L; private var wraps=0L
 fun observe(value:Int):Long {val next=value.toLong() and 0xffffffffL;if(next<last)wraps+=1L shl 32;last=next;return wraps+next}
 fun reset(){last=0;wraps=0}
}
