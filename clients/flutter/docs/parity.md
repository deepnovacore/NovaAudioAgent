# Public mobile parity ledger

Baseline: a6a5b96b. Evidence states are not release acceptance.

| Surface / contract | Flutter evidence | Status |
| --- | --- | --- |
| NOVA binary/handshake validation | test/wire_test.dart | Automated |
| Transcript partial/final replacement | test/transcript_test.dart | Automated |
| Pairing QR parsing | test/pairing_test.dart | Automated; live exchange pending |
| AOQ envelopes and queue limits | test/aoq_bridge_test.dart | Automated; SDK pending |
| Conversation screen | Source comparison required | Pending |
| Settings | Source comparison required | Pending |
| QR scanner | Source comparison required | Pending |
| Voice orb | Source comparison required | Pending |
| Text and hold-to-dictate | Source comparison required | Pending |
| Approval cards | Source comparison required | Pending |
| English/Chinese | Source comparison required | Pending |
| Accessibility/reduced motion | Source comparison required | Pending |
| iOS relay | Source comparison required | Pending |
| Android relay | Source comparison required | Pending |
| iOS AOQ | Source comparison required | Pending |
| Android AOQ | Source comparison required | Pending |

## Source action/event inventory

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
