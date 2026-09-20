import Foundation
@main struct CoreCheck {
 static func main() throws {
  var ledger = PlaybackLedger(maxSamples: 240)
  let first = PlaybackIdentity(utteranceID: "first", epoch: 1)
  precondition(ledger.accept(AudioFrame(identity: first, sequence: 0, pcm: Data(repeating: 0, count: 480))))
  let old = ledger.ticket
  precondition(!ledger.accept(AudioFrame(identity: first, sequence: 1, pcm: Data(repeating: 0, count: 2))))
  ledger.clear(first)
  precondition(!ledger.accept(AudioFrame(identity: first, sequence: 0, pcm: Data(repeating: 0, count: 2))))
  let second = PlaybackIdentity(utteranceID: "second", epoch: 2)
  precondition(ledger.accept(AudioFrame(identity: second, sequence: 0, pcm: Data(repeating: 0, count: 480))))
  ledger.rendered(240, ticket: old)
  precondition(ledger.renderedSamples == 0)
  ledger.rendered(240, ticket: ledger.ticket)
  precondition(ledger.terminal(second))
  precondition(presentedSampleTime(renderTime: 2400, downstreamLatency: 0) == nil)
  precondition(presentedSampleTime(renderTime: 2400, downstreamLatency: 0.05) == 1200)
  var handoff = CaptureHandoff()
  let a = handoff.offer(nowMS: 0)!
  precondition(handoff.offer(nowMS: 20) == nil)
  precondition(!handoff.overloaded(nowMS: 900))
  precondition(handoff.overloaded(nowMS: 1100))
  handoff.reset()
  let b = handoff.offer(nowMS: 1200)!
  handoff.acknowledge(a)
  precondition(handoff.offer(nowMS: 1220) == nil)
  handoff.acknowledge(b)
  precondition(handoff.offer(nowMS: 1240) != nil)
  var muted = MutedInput()
  muted.setMuted(true, atMS: 0)
  precondition(muted.packet(atMS: 19) == nil)
  precondition(muted.packet(atMS: 20)?.count == 640)
  precondition(muted.packet(atMS: 101)?.count == 640)
  precondition(muted.packet(atMS: 102) == nil)
  let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
  for v in vectors {
   let s = v["hex"] as! String; var bytes = Data(); var i = s.startIndex
   while i < s.endIndex { let e = s.index(i, offsetBy: 2); bytes.append(UInt8(s[i..<e], radix: 16)!); i = e }
   do { let f = try Wire.audio(bytes); precondition(v["valid"] as! Bool); let expected = v["expected"] as! [String: Any]; precondition(f.identity.utteranceID == expected["utterance_id"] as! String) }
   catch { precondition(!(v["valid"] as! Bool)) }
  }
  print("PASS: stale playback, sequence/epoch fence, queue bound, presentation, capture backpressure, mute pacing and 10 shared NOVA vectors")
 }
}
