package com.nova.nova_audio
import org.junit.Assert.*
import org.junit.Test
class PlaybackLedgerTest {
 @Test fun oldCompletionCannotCreditNewUtterance() {
  val l=PlaybackLedger(240)
  val a=PlaybackIdentity("a",1)
  assertTrue(l.accept(AudioFrame(a,0,ByteArray(480))))
  val ticket=l.ticket
  assertFalse(l.accept(AudioFrame(a,1,ByteArray(2))))
  l.clear(a)
  assertFalse(l.accept(AudioFrame(a,0,ByteArray(2))))
  val b=PlaybackIdentity("b",2)
  assertTrue(l.accept(AudioFrame(b,0,ByteArray(480))))
  l.rendered(240,ticket)
  assertEquals(0L,l.renderedSamples)
  l.rendered(240,l.ticket)
  assertTrue(l.terminal(b))
 }
 @Test fun sequenceGapIsRejected() {
  val l=PlaybackLedger()
  assertFalse(l.accept(AudioFrame(PlaybackIdentity("a",1),1,ByteArray(2))))
 }
 @Test fun frameCounterWrapsWithoutGoingBackwards() {
  val h=PlaybackHead()
  assertEquals(4294967295L,h.observe(-1))
  assertEquals(4294967298L,h.observe(2))
  h.reset()
  assertEquals(0L,h.observe(0))
 }
}
