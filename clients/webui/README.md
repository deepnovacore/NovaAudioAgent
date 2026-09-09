# Nova WebUI

Browser voice client for the existing Nova Node runtime. Clients live in `clients/desktop`, `clients/ios`, and `clients/webui`.

## Run locally

From the repository root, install dependencies and build the runtime:

```sh
npm ci
npm run build --workspace @nova-audio-agent/runtime
```

Start the WebUI:

```sh
npm run start:web
```

Open `http://localhost:4173` and configure service keys and models in **设置 → 模型与服务**. Local access authenticates automatically. **保存并应用** persists configuration and restarts a running runtime; otherwise the runtime starts lazily when you click **开始对话**. Opening settings never starts the microphone.

Settings are isolated from desktop in `~/.config/nova/webui/settings.json`. Keys are stored on the host with private file permissions (directory 0700, files 0600), not OS keychain encryption. Reads return only key-presence flags; blank fields preserve existing keys, explicit clear removes them. Browser storage never contains keys or host tokens. Runtime state and workspace also live under this directory; provider variables from the parent shell do not override these settings.

WebUI supports relay audio with Qwen integrated or Volcengine ASR/TTS cascaded pipelines. AOQ browser transport is not included. One runtime accepts one active client.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOVA_WEBUI_PORT` | `4173` | Loopback HTTP listener |
| `NOVA_WEBUI_STATE_DIR` | `~/.config/nova/webui` | Private managed settings/runtime state |
| `NOVA_WEBUI_RUNTIME_URL` | unset | Opt into external relay-only runtime, e.g. `ws://127.0.0.1:8787/client/v1`; no managed provider settings |
| `NOVA_WEBUI_ORIGIN` | unset | Exact public HTTPS origin behind a TLS reverse proxy |

For remote use, reverse-proxy HTTP and WebSocket, preserve the public Host header, and set `NOVA_WEBUI_ORIGIN`. HTTPS is required for remote microphone access. Managed remote access requires the current host credential from the private `runtime-*.token` file in the state directory; it rotates on WebUI restart. External relay mode requires the upstream runtime token and leaves provider configuration to that runtime. The browser exchanges the credential for an HttpOnly, SameSite session cookie; the proxy inserts the token into the runtime handshake. Only allowlisted assets are served.

## Behavior and verification

- AudioWorklet capture requests browser AEC/noise suppression/automatic gain, resamples to 16 kHz PCM; playback consumes 24 kHz PCM with the shared desktop generation fences and acknowledgements.
- Disconnect stops pending playback and retries up to five times; old decisions are never replayed. Closing the page or ending the session releases microphone tracks.
- Captions stay in memory (latest 300 entries), with partial updates replaced in place. Reload starts a fresh transcript; no persistent history sync is implied.
- Settings cover microphone (next connection), live output volume, actual AEC setting, palette and reduced motion. Model/provider configuration is edited here and saved on the host.
- The orb shares desktop rendering, with a 320px canvas option and reduced-motion freezing enabled only for WebUI.

```sh
npm run test:webui
npm run check
```

Automated checks cover the proxy, transcript, audio lifetime/clear/overflow, reconnect and decision rejection. Actual speaker echo cancellation, Safari/iPhone background audio, and real provider end-to-end speech still require device acceptance. An enabled AEC setting is not a measured echo-cancellation result.
