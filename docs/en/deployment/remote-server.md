# Remote service

Run Nova as a Node service on Ubuntu 22.04+ x64 or your Mac and connect from an iPhone over a private Tailscale network. Electron is not required. The service uses the `relay` media mode by default and exposes `/client/v1`; native camera capture is unavailable in remote sessions.

For the simplest desktop setup, use **Connect iPhone…** from Nova's menu; see the [iPhone guide](../iphone.md). The instructions below are for a separately managed service.

Use a dedicated writable workspace and state directory. Stop the desktop instance before starting another runtime against the same state. The desktop-managed phone service uses a separate `phone` directory and may coexist.

Remote credential storage requires POSIX ownership and private file permissions. Windows remote hosting is unsupported; this does not affect the Windows desktop application. The npm package targets Ubuntu 22.04+ x64; macOS can use the source entry; the launchd example below is macOS-only.

## Install from npm

Use Node.js >=22.14.0 and `npm install --global nova-audio-agent-server`. After setting the environment below, use `novaaudio-server token-init`, then `novaaudio-server --env-file /absolute/path/server.env start`. In a second interactive terminal with the same configuration, run `novaaudio-server --env-file /absolute/path/server.env pair wss://your-host.ts.net` for the one-use QR (SSH needs `-t`). No Electron or display session is needed.

On Ubuntu, invoke the installed `tailscale` CLI directly for the private WSS setup below. Run the service in the foreground or under your process supervisor with the same user and explicit environment file.

## Build and configure (source alternative)

Use Node >=22.13 and a checkout with its normal workspace dependencies installed.
Run builds serially with desktop work because both builds write `runtime/dist`:

```sh
cd /absolute/path/to/nova-audio-agent
npm ci
npm run build --workspace @nova-audio-agent/runtime
```

Create a private directory outside the checkout. Set these two required variables;
the port has no fallback and must be 1–65535. Missing/invalid values fail before
model, MCP or Codex resources are constructed.

```sh
mkdir -p "$HOME/.nova-remote"
chmod 700 "$HOME/.nova-remote"
export SERVER_PORT=19876
export SERVER_TOKEN_FILE="$HOME/.nova-remote/client-token"
npm run server:token-init --workspace @nova-audio-agent/runtime
```

Initialization creates a random 128-bit lowercase hexadecimal token with mode 0600
and refuses to overwrite any existing file. The loader rejects relative paths,
symlinks, non-regular files, foreign ownership and permissions other than 0600.
Use the QR pairing window described below for independent device credentials. Manual fallback: read the file locally and enter the token into the phone's Keychain-backed connection settings. Never place its contents in URLs, shell arguments, logs or Git.

Set model/executor configuration explicitly in a private environment file, for
example `$HOME/.nova-remote/server.env` (0600), using the existing Runtime environment
contract. This is a Node `--env-file` file, not a shell script; use absolute paths,
not `$HOME`/`~` expansion. At minimum choose/configure the desired pipeline and its
credentials. Codex additionally requires `EXECUTORS=codex` and an
absolute `CODEX_WORKSPACE`. Set
`CODEX_PROJECT_STATE_ROOT` to the intended private state directory.
The headless entry does not read Electron Settings or infer a project from cwd.
Codex login and any executable/resource-path configuration must be available to the
same user running the service; a GUI application's environment is not inherited.

Choose a compatible pipeline from the [support matrix](../support-matrix.md). Remote audio uses mono PCM16 LE at 16000 Hz input and 24000 Hz output; incompatible formats are rejected.

Start in the foreground first (include both server variables in the environment file
for unattended use):

```sh
node --env-file="$HOME/.nova-remote/server.env" runtime/dist/src/server-entry.js
```

Successful startup logs `[server-ready] ws://127.0.0.1:19876/client/v1`, with no token.
The service binds loopback only. An occupied port is an error; it never picks another
port. SIGINT/SIGTERM stop the owner, close the listener, then the realtime graph and
auxiliary resources. EOF on stdin or absence of an Electron parent does not stop it.

## Private WSS with Tailscale

Install/sign in to Tailscale on the Mac and iPhone and restrict tailnet access to your
devices. On macOS, invoke the CLI bundled with the app and force CLI mode with
`TAILSCALE_BE_CLI=1`, including in non-TTY automation. This avoids the executable
selecting GUI mode based on shell environment; see the official
[macOS CLI guidance](https://tailscale.com/docs/reference/tailscale-cli?tab=macos).
Inspect the existing Serve configuration first:

```sh
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

For an unused HTTPS listener:

```sh
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:19876
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

Use `wss://<machine>.<tailnet>.ts.net/client/v1` on the phone. Keep the application
token in the authentication frame. Use Serve, not public Funnel. See the official
[Tailscale Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
for HTTPS prerequisites and listener management. To remove this dedicated listener
(do not remove another service's shared listener):

```sh
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off
```

## Run at login with launchd

After foreground validation, save a per-user LaunchAgent at
`~/Library/LaunchAgents/com.nova.remote.plist`. Replace every absolute placeholder;
launchd does not expand shell variables. Keep the environment file outside Git and
place credentials there, not in the plist. Create the log directory first.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nova.remote</string>
  <key>ProgramArguments</key><array>
    <string>/absolute/path/to/node</string>
    <string>--env-file=/Users/your-user/.nova-remote/server.env</string>
    <string>/absolute/path/to/nova-audio-agent/runtime/dist/src/server-entry.js</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to/nova-audio-agent</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/your-user/.nova-remote/server.log</string>
  <key>StandardErrorPath</key><string>/Users/your-user/.nova-remote/server.log</string>
</dict></plist>
```

```sh
plutil -lint "$HOME/Library/LaunchAgents/com.nova.remote.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.nova.remote.plist"
launchctl print "gui/$(id -u)/com.nova.remote"
# Stop and unload before maintenance or credential rotation:
launchctl bootout "gui/$(id -u)/com.nova.remote"
```

The LaunchAgent runs in your login session and does not automatically restart after an error. Fix the problem and bootstrap it again. Restarting Nova does not resume unfinished commands or pending approvals.


## Pair and revoke devices

With the service running, open an interactive terminal on the same Mac with the same server port and token-file settings:

```sh
npm run server:pair --workspace @nova-audio-agent/runtime -- wss://YOUR-HOST.ts.net
```

Use **Scan to connect** in the iPhone app and confirm the host address. The terminal displays a single-use QR code; the host's long-term token is never included. The WSS address must already route to this service through Tailscale Serve. Over SSH, use `ssh -t` so the command has an interactive terminal. Pipes, redirected output and terminals too narrow for the QR code are rejected.

Generating another code invalidates the previous one. Codes have no timed expiry and can be redeemed once. Interrupting the command attempts to cancel the current code; if the process exits unexpectedly, generate a new code or restart the service.

On macOS, the windowed pairing and device-revocation interface requires Xcode Command Line Tools:

```sh
npm run server:pair --workspace @nova-audio-agent/runtime -- --window wss://YOUR-HOST.ts.net
```

Keep the token file and `${SERVER_TOKEN_FILE}.devices.json` in a private 0700 directory; both files must be private to the service user. The device store supports up to 32 devices and must have only one writer. Do not edit it while the service is running.

Tailscale Serve must forward the whole service, including `/client/v1`, `/client/pair` and `/client/pair-admin`. Each management request requires the host token; a device token cannot manage other devices. Revoking one device does not revoke other device credentials.

## Rotate credentials and reconnect

To rotate the shared host token, stop the service, remove the configured token file and move the old device file aside, then run `server:token-init` again. Restart the service and pair the phones again. Editing a token file while the process runs does not revoke active connections or reload credentials.

A phone disconnection does not by itself cancel background work. Reconnecting restores the current project, executor and approval state, plus retained results; it does not replay old audio. Receipts confirm delivery, not task completion. A server process restart invalidates pending approvals and does not automatically resume commands.

If voice is unavailable after a connection failure, use **Stop** and reconnect. This replaces the realtime provider session without requiring a host restart; approvals tied to the old session become invalid.

## Connection problems

- `configuration_required`: check the fixed port, absolute token path, file ownership, 0600 permissions and model settings.
- Port already in use: inspect `lsof -nP -iTCP:19876 -sTCP:LISTEN`; Nova will not choose a different port automatically.
- Phone cannot connect: check that both devices are on the permitted Tailscale network and that Serve forwards to the configured port.
- `assembly_failed` or `backend_unavailable`: check the local service log and the configured model or executor connection. Remove credentials before sharing logs.
