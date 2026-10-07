# Nova Audio Agent server

Run Nova without Electron on Ubuntu 22.04+ x64 using Node.js >=22.14.0.

```sh
npm install --global nova-audio-agent-server@latest
mkdir -p "$HOME/.nova-remote"
chmod 700 "$HOME/.nova-remote"
export SERVER_PORT=19876
export SERVER_TOKEN_FILE="$HOME/.nova-remote/client-token"
novaaudio-server token-init
novaaudio-server --env-file "$HOME/.nova-remote/server.env" start
```

Use a private (0600) environment file with your model credentials, pipeline and absolute workspace paths; the service does not read desktop settings. It stays in the foreground and listens on loopback. See the [remote service guide](https://github.com/deepnovacore/NovaAudioAgent/blob/main/docs/en/deployment/remote-server.md) for configuration and private WSS access.

With the service running, use the same environment in a second interactive terminal:

```sh
novaaudio-server --env-file "$HOME/.nova-remote/server.env" pair wss://your-host.ts.net
```

Scan the one-use QR with Nova on iPhone. SSH needs a TTY (`ssh -t`); Ctrl+C cancels the invitation without stopping the service. No desktop session or local microphone is required for remote phone audio.

## Upgrading

Install or update with `npm install --global nova-audio-agent-server@latest`, or pin `nova-audio-agent-server@0.3.0`. Stop the service and back up its data before upgrading; installing a different version changes the executable, not the persisted data.
