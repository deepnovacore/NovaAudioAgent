import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import NovaCore
#else
@testable import Nova
#endif

final class ProtocolTests: XCTestCase {

    func testEnterpriseHealthRetriesTransientFailureAndHonorsCancellation() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [EnterpriseHealthStub.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        EnterpriseHealthStub.reset()
        let available = try await EnterpriseHTTP.health(origin: "https://login.example.com", session: session, retryDelay: .zero)
        XCTAssertTrue(available)
        XCTAssertEqual(EnterpriseHealthStub.count, 2)
        let cancelled = Task { () throws -> Bool in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await EnterpriseHTTP.health(origin: "https://login.example.com", session: session, retryDelay: .zero)
        }
        do { _ = try await cancelled.value; XCTFail("Cancelled probe continued") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(EnterpriseHealthStub.count, 2)
        EnterpriseHealthStub.reset(failures: 5)
        do { _ = try await EnterpriseHTTP.health(origin: "https://login.example.com", session: session, retryDelay: .zero); XCTFail("Outage accepted") }
        catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
        XCTAssertEqual(EnterpriseHealthStub.count, 3, "Retries must be bounded")
    }

    func testEnterpriseHTTPBoundsStreamingResponses() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [EnterpriseResponseStub.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let data = try await EnterpriseHTTP.data(for: URLRequest(url: URL(string: "https://nova.invalid/1024")!), session: session, limit: 1024)
        XCTAssertEqual(data.count, 1024)
        do {
            _ = try await EnterpriseHTTP.data(for: URLRequest(url: URL(string: "https://nova.invalid/1025")!), session: session, limit: 1024)
            XCTFail("Oversized streamed response was accepted")
        } catch { XCTAssertTrue(error is WireError) }
    }
    func testEnterpriseCallbackRejectsWrongStateOriginAndSecrets() throws {
        let state = String(repeating: "a", count: 43)
        let code = String(repeating: "A", count: 43)
        let valid = "nova-sso://callback?code=\(code)&state=\(state)"
        XCTAssertEqual(try EnterpriseSSO.callback(URL(string: valid)!, state: state), code)
        XCTAssertEqual(try EnterpriseSSO.callback(URL(string: valid.replacingOccurrences(of: "callback?", with: "callback/?"))!, state: state), code)
        for text in [valid.replacingOccurrences(of: "callback?", with: "evil?"),
                     valid.replacingOccurrences(of: code, with: "short"),
                     valid.replacingOccurrences(of: "callback?", with: "callback/other?"),
                     valid.replacingOccurrences(of: "nova-sso:", with: "https:"),
                     valid + "&token=secret", valid + "&state=\(state)", valid + "#fragment",
                     valid.replacingOccurrences(of: "callback?", with: "user@callback?"),
                     valid.replacingOccurrences(of: "callback?", with: "callback:123?")] {
            XCTAssertThrowsError(try EnterpriseSSO.callback(URL(string: text)!, state: state))
        }
        XCTAssertThrowsError(try EnterpriseSSO.callback(URL(string: valid)!, state: "wrong"))
        XCTAssertThrowsError(try EnterpriseSSO.callback(URL(string: "nova-sso://callback?error=denied&state=\(state)")!, state: state))
    }
    func testEnterpriseExchangeTrustAndExpiry() throws {
        let now = Date(timeIntervalSince1970: 1000)
        var reply: [String: Any] = ["server": "wss://login.example.com/client/v1", "token": String(repeating: "a", count: 32),
                                   "expires_at": 1060000, "employee": ["id": "ou_123", "name": "员工"]]
        func parse() throws -> EnterpriseSSO.Credential {
            try EnterpriseSSO.credential(JSONSerialization.data(withJSONObject: reply), origin: "https://login.example.com", now: now)
        }
        XCTAssertEqual(try parse().server, "wss://login.example.com/client/v1")
        for server in ["wss://evil.example/client/v1", "ws://login.example.com/client/v1", "wss://login.example.com/client/v1?token=x"] {
            reply["server"] = server; XCTAssertThrowsError(try parse())
        }
        reply["server"] = "wss://login.example.com/client/v1"
        reply["expires_at"] = 1000000; XCTAssertThrowsError(try parse())
        reply["expires_at"] = true; XCTAssertThrowsError(try parse())
        reply["expires_at"] = 1060000
        reply["token"] = "invalid"; XCTAssertThrowsError(try parse())
        reply["token"] = String(repeating: "a", count: 32)
    }
    func testEnterprisePKCEUsesS256AndSecureRandom() throws {
        XCTAssertNil(EnterpriseSSO.configuredOrigin)
        for origin in ["http://login.example.com", "https://user@login.example.com", "https://login.example.com/path", "https://login.example.com?x=y"] {
            XCTAssertThrowsError(try EnterpriseSSO.Attempt(origin: origin))
        }

        let first = try EnterpriseSSO.Attempt(origin: "https://login.example.com")
        let second = try EnterpriseSSO.Attempt(origin: "https://login.example.com")
        XCTAssertEqual(first.state.count, 43); XCTAssertEqual(first.verifier.count, 43)
        XCTAssertNotEqual(first.state, second.state); XCTAssertNotEqual(first.verifier, second.verifier)
        XCTAssertNotEqual(first.state, first.verifier)
        XCTAssertEqual(EnterpriseSSO.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
                       "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let items = URLComponents(url: first.startURL, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first { $0.name == "state" }?.value, first.state)
        XCTAssertEqual(items.first { $0.name == "code_challenge" }?.value, EnterpriseSSO.challenge(first.verifier))
        XCTAssertFalse(first.startURL.absoluteString.contains(first.verifier))
    }
    func frame(_ header: String = #"{"utterance_id":"你好🎤","generation_epoch":1,"sequence":0}"#, count: Int = 480) -> Data {
        let bytes = Data(header.utf8)
        return Data([78,79,86,65,UInt8(bytes.count >> 8),UInt8(bytes.count & 255)]) + bytes + Data(repeating: 0, count: count)
    }
    func testPairingQRValidatesAddressVersionExpiryAndKeepsSecretsOutOfURL() throws {
        let now = Date(timeIntervalSince1970: 1000)
        var qr: [String: Any] = ["type": "nova.pair", "version": 1, "server": "wss://mac.example",
                                "code": String(repeating: "a", count: 32), "expires_at": 1120000]
        func parse() throws -> PairingCode {
            try PairingCode.parse(String(decoding: JSONSerialization.data(withJSONObject: qr), as: UTF8.self), now: now)
        }
        let valid = try parse()
        XCTAssertEqual(valid.server.absoluteString, "wss://mac.example/client/v1")
        XCTAssertEqual(valid.endpoint.path, "/client/pair")
        XCTAssertNil(URLComponents(url: valid.endpoint, resolvingAgainstBaseURL: false)?.query)
        for server in ["ws://mac.example", "wss://u:p@mac.example", "wss://mac.example/?token=a", "wss://mac.example/other"] {
            qr["server"] = server; XCTAssertThrowsError(try parse())
        }
        qr["server"] = "wss://mac.example"
        qr["version"] = 2; XCTAssertThrowsError(try parse())
        qr["version"] = 1
        qr["expires_at"] = 1000000; XCTAssertThrowsError(try parse())
        qr["expires_at"] = 1120000
        qr["code"] = "not a credential"; XCTAssertThrowsError(try parse())
        XCTAssertThrowsError(try PairingCode.parse(String(repeating: "x", count: 4097), now: now))
    }

    func testSharedProtocolVectors() throws {
        struct Vector: Decodable {
            struct Expected: Decodable { let utterance_id: String; let generation_epoch: Int; let sequence: Int; let pcm_hex: String }
            let name: String; let hex: String; let valid: Bool; let expected: Expected?
        }
        #if SWIFT_PACKAGE
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../fixtures/client-protocol/v1/vectors.json").standardizedFileURL
        #else
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "vectors", withExtension: "json"))
        #endif
        let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            let chars = Array(vector.hex)
            XCTAssertEqual(chars.count % 2, 0)
            let bytes = try stride(from: 0, to: chars.count, by: 2).map { try XCTUnwrap(UInt8(String(chars[$0...($0+1)]), radix: 16)) }
            if vector.valid {
                let frame = try Wire.audio(Data(bytes)), expected = try XCTUnwrap(vector.expected)
                XCTAssertEqual(frame.identity.utteranceID, expected.utterance_id, vector.name)
                XCTAssertEqual(frame.identity.epoch, expected.generation_epoch, vector.name)
                XCTAssertEqual(frame.sequence, expected.sequence, vector.name)
                XCTAssertEqual(frame.pcm.map { String(format: "%02x", $0) }.joined(), expected.pcm_hex, vector.name)
            } else { XCTAssertThrowsError(try Wire.audio(Data(bytes)), vector.name) }
        }
    }
    func testNegotiatedMediaRejectsUnimplementedPathsBeforeCapture() throws {
        var ready: [String: Any] = ["type": "client.ready", "protocol_version": 1,
            "server_instance_id": UUID().uuidString, "connection_id": UUID().uuidString,
            "capabilities": ["audio", "captions", "projects", "executor"],
            "input_audio": ["encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1],
            "output_audio": ["encoding": "pcm_s16le", "sample_rate": 24000, "channels": 1]]
        XCTAssertNil(try Wire.ready(ready).pipeline, "Original v1 hosts remain compatible")
        for pipeline in ["integrated", "cascaded"] {
            ready["media"] = ["transport": "host_pcm_v1", "path": "relay", "audio_owner": "client", "pipeline": pipeline]
            XCTAssertEqual(try Wire.ready(ready).pipeline, pipeline)
        }
        for invalid: Any in [NSNull(), ["transport": "qwen_aoq_v1", "path": "direct"],
            ["transport": "host_pcm_v1", "path": "relay", "audio_owner": "sdk", "pipeline": "integrated"],
            ["transport": "host_pcm_v1", "path": "relay", "audio_owner": "client", "pipeline": "unknown"]] {
            ready["media"] = invalid
            XCTAssertThrowsError(try Wire.ready(ready))
        }
    }

    func testAOQRequiresExplicitChatOnlyCapabilityAndClientOptIn() throws {
        var ready: [String: Any] = ["type": "client.ready", "protocol_version": 1,
            "server_instance_id": UUID().uuidString, "connection_id": UUID().uuidString,
            "capabilities": ["audio", "captions"],
            "input_audio": ["encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1],
            "output_audio": ["encoding": "pcm_s16le", "sample_rate": 24000, "channels": 1],
            "media": ["transport": "qwen_aoq_chat_v1", "path": "direct", "audio_owner": "aoq_sdk", "pipeline": "integrated", "mode": "chat_only"]]
        XCTAssertThrowsError(try Wire.ready(ready))
        XCTAssertTrue(try Wire.ready(ready, allowAOQ: true).aoqChat)
        ready["capabilities"] = ["audio", "captions", "executor"]
        XCTAssertThrowsError(try Wire.ready(ready, allowAOQ: true))
        ready["capabilities"] = ["audio", "captions"]
        ready["media"] = ["transport": "qwen_aoq_chat_v1", "path": "direct", "audio_owner": "aoq_sdk", "pipeline": "integrated", "mode": "tools"]
        XCTAssertThrowsError(try Wire.ready(ready, allowAOQ: true))
    }

    func testAOQRuntimeRequiresExactDescriptorCapabilitiesAndOffer() throws {
        var ready: [String: Any] = ["type": "client.ready", "protocol_version": 1,
            "server_instance_id": UUID().uuidString, "connection_id": UUID().uuidString,
            "capabilities": ["audio", "captions", "projects", "executor"],
            "input_audio": ["encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1],
            "output_audio": ["encoding": "pcm_s16le", "sample_rate": 24000, "channels": 1],
            "media": ["transport": "qwen_aoq_runtime_v1", "path": "direct", "audio_owner": "aoq_sdk", "pipeline": "integrated", "mode": "runtime"]]
        XCTAssertThrowsError(try Wire.ready(ready, allowAOQ: true), "Chat offer cannot admit runtime")
        let accepted = try Wire.ready(ready, allowAOQ: true, allowAOQRuntime: true)
        XCTAssertTrue(accepted.aoqChat)
        XCTAssertTrue(accepted.aoqRuntime)
        ready["capabilities"] = ["audio", "captions", "projects"]
        XCTAssertThrowsError(try Wire.ready(ready, allowAOQRuntime: true))
        ready["capabilities"] = ["audio", "captions", "projects", "executor"]
        for mode in ["chat_only", "tools", ""] {
            ready["media"] = ["transport": "qwen_aoq_runtime_v1", "path": "direct", "audio_owner": "aoq_sdk", "pipeline": "integrated", "mode": mode]
            XCTAssertThrowsError(try Wire.ready(ready, allowAOQRuntime: true), mode)
        }
    }

    func testAOQRuntimeCommandsFenceConnectionSequenceTypeAndSize() throws {
        var bridge = AOQRuntimeBridge(connection: "current")
        let first = try bridge.command(["type": "aoq.command", "connection_id": "current", "sequence": 1,
                                        "event": ["type": "session.update", "session": [:]]])
        XCTAssertEqual(first["type"] as? String, "session.update")
        XCTAssertThrowsError(try bridge.command(["type": "aoq.command", "connection_id": "current", "sequence": 2,
                                                 "event": ["type": "response.cancel"], "extra": true]), "Envelope keys are exact")
        XCTAssertThrowsError(try bridge.command(["type": "aoq.command", "connection_id": "current", "sequence": 1,
                                                 "event": ["type": "response.cancel"]]), "Duplicate sequence")
        XCTAssertThrowsError(try bridge.command(["type": "aoq.command", "connection_id": "old", "sequence": 2,
                                                 "event": ["type": "response.cancel"]]), "Old connection")
        XCTAssertThrowsError(try bridge.command(["type": "aoq.command", "connection_id": "current", "sequence": 2,
                                                 "event": ["type": "input_audio_buffer.append"]]), "Audio injection is unsupported")
        XCTAssertNoThrow(try bridge.command(["type": "aoq.command", "connection_id": "current", "sequence": 2,
                                             "event": ["type": "conversation.item.truncate"]]))

        let envelope = try XCTUnwrap(bridge.envelope(["type": "response.created"]))
        XCTAssertEqual(envelope["sequence"] as? Int, 1)
        XCTAssertNil(try bridge.envelope(["type": "response.audio.delta", "delta": "base64"]), "Audio payload stays inside AOQ")
        XCTAssertThrowsError(try bridge.envelope(["type": "notice", "value": String(repeating: "x", count: 65_536)]))
    }

    func testAOQPendingCommandsAreByteBounded() throws {
        var pending = AOQPendingCommands()
        let event: [String: Any] = ["type": "conversation.item.create", "item": String(repeating: "x", count: 65_000)]
        for _ in 0..<4 { XCTAssertNoThrow(try pending.append(event)) }
        XCTAssertThrowsError(try pending.append(event), "Pending commands cannot grow past 256 KiB")
        XCTAssertEqual(pending.drain().count, 4)
        XCTAssertNoThrow(try pending.append(event), "Draining releases the byte budget")
    }

    func testBoundsAndExactIntegers() throws {
        let value = try Wire.audio(frame())
        XCTAssertEqual(value.identity.utteranceID, "你好🎤")
        XCTAssertEqual(value.pcm.count, 480)
        for bad in [Data(), Data([0,0,0,0,0,2,123,125]), frame(count: 1), frame(count: 65538), frame(count: 0), Data([78,79,86,65,8,1])] {
            XCTAssertThrowsError(try Wire.audio(bad))
        }
        for literal in ["1.0", "1e0", "true", "9007199254740992", "-1", "0"] {
            XCTAssertThrowsError(try Wire.audio(frame("{\"utterance_id\":\"x\",\"generation_epoch\":\(literal),\"sequence\":0}")), literal)
        }
        XCTAssertThrowsError(try Wire.audio(frame(#"{"utterance_id":"x","generation_epoch":1,"generation_\u0065poch":1.0,"sequence":0}"#)))
        XCTAssertEqual(try Wire.audio(frame(#"{"utterance_id":"x","generation_epoch":9007199254740991,"sequence":0}"#)).identity.epoch, 9007199254740991)
        XCTAssertThrowsError(try Wire.audio(frame(#"{"utterance_id":"  ","generation_epoch":1,"sequence":0}"#)))
    }
    func testPlaybackAccountsOnlyRenderedAndFencesLateCallbacks() throws {
        var playback = PlaybackLedger(maxSamples: 480)
        let value = try Wire.audio(frame())
        XCTAssertTrue(playback.accept(value))
        XCTAssertEqual(playback.playedMS, 0, "Queued audio is not heard")
        XCTAssertFalse(playback.accept(value), "Duplicate sequence")
        let ticket = playback.ticket
        playback.rendered(120, ticket: ticket)
        XCTAssertEqual(playback.playedMS, 5)
        playback.clear(value.identity)
        XCTAssertFalse(playback.accept(value), "Cleared generation cannot return")
        playback.rendered(240, ticket: ticket)
        XCTAssertEqual(playback.playedMS, 0, "Old completion cannot alter new playback")
        let next = try Wire.audio(frame(#"{"utterance_id":"next","generation_epoch":2,"sequence":0}"#))
        XCTAssertTrue(playback.accept(next))
        XCTAssertFalse(playback.terminal(next.identity))
        playback.rendered(240, ticket: playback.ticket)
        XCTAssertTrue(playback.finished)
        playback.disconnect()
        XCTAssertTrue(playback.accept(value), "New server may restart epoch at one")
    }
    func testQueueBoundAndSpeechAttackHangover() throws {
        var playback = PlaybackLedger(maxSamples: 200)
        XCTAssertFalse(playback.accept(try Wire.audio(frame())))
        var onset = SpeechDetector()
        XCTAssertFalse(onset.observe(level: 0.1, durationMS: 20))
        XCTAssertFalse(onset.observe(level: 0.1, durationMS: 20))
        XCTAssertTrue(onset.observe(level: 0.1, durationMS: 20))
        XCTAssertFalse(onset.observe(level: 0.1, durationMS: 100))
        XCTAssertFalse(onset.observe(level: 0, durationMS: 200))
        XCTAssertTrue(onset.observe(level: 0.1, durationMS: 60))
    }
    func testPlaybackAcceptsFastSynthesisButKeepsBoundAndInterruptionFence() {
        var playback = PlaybackLedger()
        let identity = PlaybackIdentity(utteranceID: "burst", epoch: 1)
        // Real device: synthesis had supplied 7.18 seconds after only 2.04 seconds played.
        // A 30-second answer may arrive well before its playback finishes.
        let pcm = Data(repeating: 0, count: 19200) // 400 ms at 24 kHz PCM16.
        for sequence in 0..<75 {
            XCTAssertTrue(playback.accept(AudioFrame(identity: identity, sequence: sequence, pcm: pcm)))
        }
        XCTAssertEqual(playback.playedMS, 0)
        let ticket = playback.ticket
        playback.clear(identity)
        playback.rendered(720000, ticket: ticket)
        XCTAssertEqual(playback.playedMS, 0)
        XCTAssertFalse(playback.accept(AudioFrame(identity: identity, sequence: 75, pcm: pcm)))
        playback.disconnect()
        for sequence in 0..<150 {
            XCTAssertTrue(playback.accept(AudioFrame(identity: identity, sequence: sequence, pcm: pcm)))
        }
        XCTAssertFalse(playback.accept(AudioFrame(identity: identity, sequence: 150, pcm: pcm)), "Unplayed audio remains bounded at 60 seconds")
        playback.rendered(9600, ticket: playback.ticket)
        XCTAssertTrue(playback.accept(AudioFrame(identity: identity, sequence: 150, pcm: pcm)), "Heard audio releases capacity")
    }
    func testLateCompletionCannotCountIntoReconnectedGeneration() throws {
        var playback = PlaybackLedger()
        let value = try Wire.audio(frame())
        XCTAssertTrue(playback.accept(value))
        let oldTicket = playback.ticket
        playback.disconnect()
        XCTAssertTrue(playback.accept(value))
        playback.rendered(240, ticket: oldTicket)
        XCTAssertEqual(playback.playedMS, 0)
        XCTAssertFalse(playback.finished)
        playback.rendered(240, ticket: playback.ticket)
        XCTAssertFalse(playback.finished, "Rendering alone is not provider terminal")
        XCTAssertTrue(playback.terminal(value.identity))
        playback.clear(value.identity)
        XCTAssertFalse(playback.accept(value), "Completed generations cannot replay")
    }
    func testMuteSuppliesEndpointingSilenceAtCaptureRateWithoutCatchUpBursts() throws {
        var input = MutedInput()
        XCTAssertNil(input.packet(atMS: 0))
        input.setMuted(true, atMS: 0)
        XCTAssertNil(input.packet(atMS: 19))
        var samples = 0
        for time in stride(from: 20, through: 560, by: 20) {
            let pcm = try XCTUnwrap(input.packet(atMS: Double(time)))
            XCTAssertEqual(pcm.count, 640) // 20 ms, 16 kHz, PCM16 mono.
            XCTAssertTrue(pcm.allSatisfy { $0 == 0 }, "Muted capture must not leak microphone samples")
            samples += pcm.count / 2
            XCTAssertNil(input.packet(atMS: Double(time)), "No duplicate timer delivery")
        }
        XCTAssertEqual(samples, 8960, "560 ms of real input advances bounded_silence before unmute")
        XCTAssertEqual(input.packet(atMS: 5000)?.count, 640)
        XCTAssertNil(input.packet(atMS: 5000), "A stalled UI must not upload catch-up silence in a burst")
        input.setMuted(false, atMS: 5000)
        XCTAssertNil(input.packet(atMS: 5020))
        input.setMuted(true, atMS: 0)
        XCTAssertNotNil(input.packet(atMS: 20.2))
        XCTAssertNotNil(input.packet(atMS: 40), "Timer jitter must not halve the PCM sample rate")
    }
    func testPartialPlaybackUsesWholeDownstreamLatencyExactlyOnce() {
        // At 100 ms rendered, a 62.5 ms full path (including Voice Processing/device) leaves 37.5 ms heard.
        XCTAssertEqual(presentedSampleTime(renderTime: 2400, downstreamLatency: 0.0625), 900)
        XCTAssertEqual(presentedSampleTime(renderTime: 1200, downstreamLatency: 0.0625), 0)
        XCTAssertNil(presentedSampleTime(renderTime: 2400, downstreamLatency: 0), "Unknown latency relies on played-back completions")
        XCTAssertNil(presentedSampleTime(renderTime: 2400, downstreamLatency: .nan))
        XCTAssertNil(presentedSampleTime(renderTime: 2400, downstreamLatency: .infinity))
    }
    #if !SWIFT_PACKAGE
    @MainActor func testStoppingVoiceClosesConnectionAndDropsApprovals() {
        let client = Client()
        client.connected = true
        client.voice = true
        client.approvals = [ApprovalCard(id: "old", executor: nil, project: "p", title: "t", detail: "d", decisions: ["accept"], deadline: Date().addingTimeInterval(60), busy: false)]
        client.suspendAudio()
        XCTAssertFalse(client.connected, "No live socket may retain the stopped capture segment")
        XCTAssertFalse(client.voice)
        XCTAssertTrue(client.approvals.isEmpty)
    }
    #endif
    func testReceiveFailureClassificationAndBoundedMalformedReconnects() {
        let malformed = WireError("Invalid frame")
        XCTAssertEqual(Wire.receiveFailureCode(malformed, ready: false, serverCode: 0), 4006)
        XCTAssertEqual(Wire.receiveFailureCode(malformed, ready: true, serverCode: 0), 1002)
        for code in [4003, 4006, 4008, 4009] {
            XCTAssertEqual(Wire.receiveFailureCode(malformed, ready: true, serverCode: code), code)
            XCTAssertEqual(Wire.receiveFailureCode(malformed, ready: false, serverCode: code), code)
        }
        var recovery = ConnectionRecovery()
        for (attempt, expected) in [1, 2, 4].enumerated() {
            recovery.markReady(atMS: Double(attempt * 1000))
            XCTAssertEqual(recovery.nextDelay(atMS: Double(attempt * 1000 + 10)), expected)
        }
        recovery.markReady(atMS: 4000)
        XCTAssertNil(recovery.nextDelay(atMS: 4010), "Ready followed by malformed data cannot replenish retries indefinitely")
        recovery.markReady(atMS: 5000)
        XCTAssertEqual(recovery.nextDelay(atMS: 35000), 1, "A stable connection restores the normal network recovery budget")
    }
    func testEndpointAndReady() throws {
        XCTAssertThrowsError(try Wire.endpoint("ws://example.com", debugLocalhost: true))
        XCTAssertThrowsError(try Wire.endpoint("wss://user:secret@example.com"))
        XCTAssertThrowsError(try Wire.endpoint("wss://example.com?token=secret"))
        XCTAssertEqual(try Wire.endpoint("wss://example.com").path, "/client/v1")
        let ready = #"{"type":"client.ready","protocol_version":1,"server_instance_id":"00000000-0000-0000-0000-000000000001","connection_id":"00000000-0000-0000-0000-000000000002","input_audio":{"encoding":"pcm_s16le","sample_rate":16000,"channels":1},"output_audio":{"encoding":"pcm_s16le","sample_rate":24000,"channels":1},"capabilities":["audio","captions","projects","executor"]}"#
        let identityReady = ready.replacingOccurrences(of: "00000000-0000-0000-0000-000000000002", with: "abcdefab-cdef-4abc-8abc-abcdefabcdef")
        XCTAssertEqual(try Wire.ready(Wire.json(Data(identityReady.utf8))).connection, "abcdefab-cdef-4abc-8abc-abcdefabcdef", "Echo opaque connection identity exactly; UUID formatting can change case")
        XCTAssertNoThrow(try Wire.ready(Wire.json(Data(ready.utf8))))
        XCTAssertThrowsError(try Wire.ready(Wire.json(Data(ready.replacingOccurrences(of: "16000", with: "48000").utf8))))
    }
}

// No Content-Length: the streaming limit must hold independently of response headers.
private final class EnterpriseResponseStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "nova.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(repeating: 65, count: Int(url.lastPathComponent)!))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class EnterpriseHealthStub: URLProtocol {
    private static let lock = NSLock()
    private static var requests = 0
    private static var failures = 1
    static var count: Int { lock.withLock { requests } }
    static func reset(failures: Int = 1) { lock.withLock { requests = 0; Self.failures = failures } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let fail = Self.lock.withLock { Self.requests += 1; return Self.requests <= Self.failures }
        if fail {
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut)); return
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"available":true}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
