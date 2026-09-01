# Nova Audio Agent CLI

Install the command globally:

```bash
npm install -g nova-audio-agent
```

Then launch Nova or open its settings:

```bash
novaaudio
novaaudio config
novaaudio doctor
```

The CLI downloads the matching `v0.1.0` desktop release into
`~/.nova-audio-agent/cli/releases/`, verifies its published SHA-256 digest, and
keeps application settings in the desktop client's existing encrypted store.
It never reads or prints secret values.

The initial release supports macOS arm64/x64, Windows x64, and Linux x64.
The desktop application is currently unsigned, so the operating system may
show a security warning.
