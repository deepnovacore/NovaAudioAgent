# Nova WebUI

Browser voice client for the existing Nova Node runtime. Clients live in `clients/desktop`, `clients/ios`, and `clients/webui`.

## Run locally

From the repository root, install dependencies and build the runtime:

```sh
npm ci
npm run build --workspace @nova-audio-agent/runtime
```

Configure your usual runtime providers in the root `.env` (see `.env.example`). WebUI currently supports `relay` / `host_pcm_v1`: Qwen integrated, or the supported Volcengine ASR/TTS cascaded configuration. AOQ browser transport is not included.

Initialize a dedicated server credential once, then start the headless runtime:

```sh
mkdir -p "$HOME/.config/nova"
export NOVA_AUDIO_AGENT_SERVER_TOKEN_FILE="$HOME/.config/nova/webui.token"
export NOVA_AUDIO_AGENT_SERVER_PORT=8787
export NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE=relay
node runtime/dist/src/server-entry.js token-init
node --env-file=.env runtime/dist/src/server-entry.js
```

`token-init` refuses to overwrite an existing file. On subsequent runs, set the environment variables and run only the last command. The token file is private (0600). In another terminal:

```sh
npm run start:web
```

Open `http://localhost:4173`, open Settings, and enter the host token from that file or an existing paired device token. Credentials stay in page memory, never localStorage or a URL. Click **连接并返回** to activate browser audio. The host currently permits one active client; disconnect an existing phone/browser client before connecting another.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOVA_WEBUI_PORT` | `4173` | Loopback HTTP listener |
| `NOVA_WEBUI_RUNTIME_URL` | `ws://127.0.0.1:8787/client/v1` | Fixed upstream; uses `NOVA_AUDIO_AGENT_SERVER_PORT` when supplied |
| `NOVA_WEBUI_ORIGIN` | unset | Exact public origin such as `https://nova.example.com` behind a TLS reverse proxy |

For remote use, reverse-proxy both HTTP and WebSocket to the loopback listener, preserve the public Host header, and set `NOVA_WEBUI_ORIGIN`. The browser requires HTTPS for remote microphone access. Runtime credentials are forwarded to the runtime; the proxy does not grant access itself. The server serves only explicit public assets, never the repository root or `.env`.

## Behavior and verification

- AudioWorklet capture requests browser AEC/noise suppression/automatic gain, resamples to 16 kHz PCM; playback consumes 24 kHz PCM with the shared desktop generation fences and acknowledgements.
- Disconnect stops pending playback and retries up to five times; old decisions are never replayed. Closing the page or ending the session releases microphone tracks.
- Captions stay in memory (latest 300 entries), with partial updates replaced in place. Reload starts a fresh transcript; no persistent history sync is implied.
- Settings cover microphone (next connection), live output volume, actual AEC setting, palette and reduced motion. Model/provider configuration remains on the host.
- The orb shares desktop rendering, with a 320px canvas option and reduced-motion freezing enabled only for WebUI.

```sh
npm run test:webui
npm run check
```

Automated checks cover the proxy, transcript, audio lifetime/clear/overflow, reconnect and decision rejection. Actual speaker echo cancellation, Safari/iPhone background audio, and real provider end-to-end speech still require device acceptance. An enabled AEC setting is not a measured echo-cancellation result.
