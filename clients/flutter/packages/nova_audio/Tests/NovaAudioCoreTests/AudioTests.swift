import Foundation
import XCTest
@testable import NovaAudioCore
final class AudioTests: XCTestCase {
    func testOldCompletionCannotCreditNewPlayback() {
        var ledger = PlaybackLedger()
        let first = PlaybackIdentity(utteranceID: "first", epoch: 1)
        XCTAssertTrue(ledger.accept(AudioFrame(identity: first, sequence: 0, pcm: Data(repeating: 0, count: 480))))
        let ticket = ledger.ticket
        ledger.clear(first)
        let next = PlaybackIdentity(utteranceID: "second", epoch: 2)
        XCTAssertTrue(ledger.accept(AudioFrame(identity: next, sequence: 0, pcm: Data(repeating: 0, count: 480))))
        ledger.rendered(240, ticket: ticket)
        XCTAssertEqual(ledger.renderedSamples, 0)
        XCTAssertFalse(ledger.terminal(first))
        ledger.rendered(240, ticket: ledger.ticket)
        XCTAssertTrue(ledger.terminal(next))
    }
    func testQueueBoundAndSequenceFence() {
        var ledger = PlaybackLedger(maxSamples: 240)
        let id = PlaybackIdentity(utteranceID: "u", epoch: 1)
        XCTAssertTrue(ledger.accept(AudioFrame(identity: id, sequence: 0, pcm: Data(repeating: 0, count: 480))))
        XCTAssertFalse(ledger.accept(AudioFrame(identity: id, sequence: 1, pcm: Data(repeating: 0, count: 2))))
        ledger.clear(id)
        XCTAssertFalse(ledger.accept(AudioFrame(identity: id, sequence: 0, pcm: Data(repeating: 0, count: 2))))
    }
    func testUnknownPresentationLatencyCannotCreditSamples() {
        XCTAssertNil(presentedSampleTime(renderTime: 2400, downstreamLatency: 0))
        XCTAssertEqual(presentedSampleTime(renderTime: 2400, downstreamLatency: 0.05), 1200)
    }
    func testCaptureBackpressureAndObsoleteAcknowledgement() {
        var handoff = CaptureHandoff()
        let first = handoff.offer(nowMS: 0)!
        XCTAssertNil(handoff.offer(nowMS: 20))
        XCTAssertFalse(handoff.overloaded(nowMS: 900))
        XCTAssertTrue(handoff.overloaded(nowMS: 1100))
        handoff.reset()
        let second = handoff.offer(nowMS: 1200)!
        handoff.acknowledge(first)
        XCTAssertNil(handoff.offer(nowMS: 1220))
        handoff.acknowledge(second)
        XCTAssertNotNil(handoff.offer(nowMS: 1240))
    }
    func testMutedInputSkipsMissedTicks() {
        var input = MutedInput()
        input.setMuted(true, atMS: 0)
        XCTAssertNil(input.packet(atMS: 19))
        XCTAssertEqual(input.packet(atMS: 20)?.count, 640)
        XCTAssertEqual(input.packet(atMS: 101)?.count, 640)
        XCTAssertNil(input.packet(atMS: 102))
        input.setMuted(false, atMS: 103)
        XCTAssertNil(input.packet(atMS: 200))
    }
    func testSharedNOVAFrames() throws {
        let path = ProcessInfo.processInfo.environment["NOVA_FRAME_FIXTURES"]!
        let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [[String: Any]]
        func unhex(_ s: String) -> Data { var result = Data(); var i = s.startIndex; while i < s.endIndex { let end = s.index(i, offsetBy: 2); result.append(UInt8(s[i..<end], radix: 16)!); i = end }; return result }
        for v in vectors {
            let bytes = unhex(v["hex"] as! String)
            if v["valid"] as! Bool {
                let f = try Wire.audio(bytes), expected = v["expected"] as! [String:Any]
                XCTAssertEqual(f.identity.utteranceID, expected["utterance_id"] as? String)
                XCTAssertEqual(f.pcm, unhex(expected["pcm_hex"] as! String))
            } else { XCTAssertThrowsError(try Wire.audio(bytes)) }
        }
    }
}
