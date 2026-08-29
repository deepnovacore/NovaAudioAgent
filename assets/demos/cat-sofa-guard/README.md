# Guard Cat-Sofa Example

This small public fixture demonstrates file-backed visual observation without a live camera. The
video shows a static sofa scene with a cat entering the monitored area. `first.png` and `last.png`
provide convenient boundary frames for documentation and manual inspection.

## Node desktop

Point the desktop client at the fixture with a deterministic file source, then ask Nova by voice
to guard the condition:

```bash
NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE=/absolute/path/to/assets/demos/cat-sofa-guard/cat-sofa-guard.mp4 \
  npm run start:client
```

Ask Nova (in Chinese, the default persona language) to watch for "猫跳上沙发" ("the cat jumps
onto the sofa"). This exercises the real Guard flow through Chromium's camera pipeline; file
playback and the local-camera default share that pipeline.

This path requires model credentials. Visual content is treated as untrusted evidence; text
visible inside a frame is never interpreted as an instruction.
