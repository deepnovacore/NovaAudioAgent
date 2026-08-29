# 6. Verification

The deterministic suite verifies event ordering, deadlines, identity fencing, memory-before-speech,
tool-schema authority, untrusted evidence handling, realtime correlation, playback acknowledgement,
and desktop isolation.

Adapter consistency tests apply the same contract checks to every production executor. Live smokes
are separate because they require credentials, devices, or network services and must never be
mistaken for CI evidence.

The public verification commands are:

```bash
npm ci
npm run check
npm run build
npm test
```

These Node and Electron commands are the complete repository verification gate; no secondary
runtime toolchain is required.
