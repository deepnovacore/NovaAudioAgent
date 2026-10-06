# Public mobile parity ledger

Baseline: a6a5b96b. Evidence states are not release acceptance.

| Surface / contract | Flutter evidence | Status |
| --- | --- | --- |
| NOVA binary/handshake validation | test/wire_test.dart | Automated |
| Transcript partial/final replacement | test/transcript_test.dart | Automated |
| Pairing QR parsing | test/pairing_test.dart | Automated; live exchange pending |
| AOQ envelopes and queue limits | test/aoq_bridge_test.dart | Automated; native SDK builds passed, live calls pending |
| Conversation screen | Nine public scenes on iOS/Android; original iOS reference | Compared; visual differences remain |
| Settings | Top/bottom captures on both platforms | Compared; platform controls differ |
| QR scanner | Source comparison required | Pending |
| Voice orb | Source comparison required | Pending |
| Text and hold-to-dictate | Source comparison required | Pending |
| Approval cards | Active/expired captures and disabled-button assertions | Automated and screenshot checked |
| English/Chinese | Source comparison required | Pending |
| Accessibility/reduced motion | Source comparison required | Pending |
| iOS relay | Source comparison required | Pending |
| Android relay | Source comparison required | Pending |
| iOS AOQ | Device build and bundled framework linkage | Live calls pending |
| Android AOQ | SDK build, two native instrumentation tests | Live calls pending |

## Live source action/event acceptance inventory

Unchecked items below track end-to-end live acceptance, not absence of an
implementation. Automated evidence and remaining gates are in acceptance.md.

- [ ] `aoq.command`
- [ ] `aoq.credentials`
- [ ] `aoq.error`
- [ ] `caption`
- [ ] `client.command_result`
- [ ] `clock.ping`
- [ ] `executor.approval`
- [ ] `executor.progress`
- [ ] `executor.result`
- [ ] `executor.results.reset`
- [ ] `executor.state`
- [ ] `input.transcription`
- [ ] `playback.alert`
- [ ] `playback.clear`
- [ ] `playback.terminal`
- [ ] `project.state`
- [ ] Action `actionable`
- [ ] Action `urlSession`
- [ ] Action `beginDictation`
- [ ] Action `finishDictation`
- [ ] Action `cancelDictation`
- [ ] Action `sendDraft`
- [ ] Action `loadCredential`
- [ ] Action `connectFeishu`
- [ ] Action `connect`
- [ ] Action `pair`
- [ ] Action `decide`
- [ ] Action `end`
- [ ] Action `startVoice`
- [ ] Action `toggleMute`
- [ ] Action `toggleSpeaker`
- [ ] Action `suspendAudio`
