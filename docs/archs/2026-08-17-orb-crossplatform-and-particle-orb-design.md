# Cross-Platform Orb, Particle Visual, and Settings Panel — Design

Status: accepted (2026-08-17)
Scope: `desktop/ambient-orb`, `src/nova_audio_agent` process lifecycle and configuration surface, packaging, CI.

## 1. Goals

1. Run the ambient orb on Windows and Ubuntu with no regression on macOS.
2. Replace the gradient-sphere orb visual with a Canvas 2D particle/nebula visual with two switchable palettes.
3. Add a right-click Settings panel for core parameters: push-and-pull proactivity preset, Codex progress cadence, palette, and voice.
4. iOS is documented as a feasibility appendix only (no scheduled work).

## 2. Why this is feasible

- The orb is Electron plus framework-free HTML/CSS/ESM; the only hard macOS dependency is the 450-line Swift CoreAudio helper (`native/macos_voice_io.swift`, `kAudioUnitSubType_VoiceProcessingIO` AEC), and the renderer already carries an automatic `browser_aec` fallback (`getUserMedia` echo cancellation + AudioWorklet). Windows/Linux capture and playback work through that path today.
- The Python runtime is already proven on Linux: the `python` CI job runs green on `ubuntu-latest`. There is no local ASR/TTS/VAD/wake word — speech understanding and synthesis live in the Qwen Audio Realtime session (`smart_turn` provider VAD) — so the audio stack carries no portaudio-class native dependency.
- The platform-integration surface is nearly zero: no AppleScript, no accessibility automation, no screen capture, no clipboard/calendar/notification integrations. Tray and the global shortcut already use cross-platform Electron APIs; the camera path is OpenCV.

The real porting work is concentrated in POSIX assumptions in the process lifecycle, Linux compositor behavior, packaging/CI, and icon assets.

## 3. Process lifecycle design

### 3.1 Readiness handshake: TCP dial-back (replaces fd 3)

Node on Windows cannot pass stdio pipes beyond stdin/stdout/stderr, so the fd-3 readiness pipe is replaced by a loopback TCP dial-back, one code path for all platforms:

- Electron opens a one-shot `net.Server` on `127.0.0.1:0` before spawning the backend and passes `NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT=127.0.0.1:<port>` in the child environment.
- After the desktop WebSocket is bound, the backend dials the endpoint and writes exactly one line `{"token", "host", "port"}`, then closes. The token is the launch token already used by the WS hello.
- Electron validates the token with `crypto.timingSafeEqual`; a non-matching client is destroyed and the listener keeps waiting, so an unprivileged local prober cannot consume the handshake. The existing 4096-byte line cap, strict payload schema, and 15-second timeout kill are preserved.

stdout was rejected as the readiness channel because it is an active diagnostics stream (`[realtime-diagnostic]` lines), and a named pipe/UDS was rejected because it needs two platform implementations on both sides while still requiring a token. fd-3 support is deleted rather than dual-tracked.

### 3.2 Shutdown and parent liveness: stdin-EOF sentinel

The backend already treats stdin EOF as "stop"; only the watcher silently no-ops on Windows Proactor loops. The design unifies deliberate shutdown and parent-death detection on one signal:

- Python: `watch_parent_stdin` keeps the POSIX `loop.add_reader(0, ...)` path unchanged and adds a non-POSIX daemon thread blocking on `os.read(0, 1)`; EOF or `OSError` schedules the stop event. POSIX signal handlers stay as they are.
- Electron `before-quit`: end the child's stdin (all platforms), send SIGTERM as belt-and-braces on POSIX, race the child's exit against a 3-second grace, then SIGKILL. The readiness-timeout kill uses the same helper.

The existing drain sequence (cancel pending work, stop the assembly, close telemetry) is untouched.

### 3.3 Subprocess tree supervision

Codex/AutoGLM process supervision centralizes in `process_tree.py`: POSIX keeps the existing `killpg` logic verbatim; Windows uses `CREATE_NEW_PROCESS_GROUP` at spawn and `taskkill /T` (then `/T /F` after a grace period) at teardown. Job Objects are deliberately deferred until orphan evidence appears — every call site funnels through the shared module, so the upgrade stays contained.

## 4. Windowing and input

- **Drag** unifies on main-process cursor polling: on drag start the main process records `screen.getCursorScreenPoint()` and the window position; renderer pointer-move events become contentless ticks; each tick recomputes the window position from main-process cursor reads and the existing work-area clamp. This removes the renderer `screenX/screenY` dependency that drifts across per-monitor DPI on Windows. The renderer's 6 px click-vs-drag threshold is unchanged.
- **Linux** pins `ozone-platform=x11` (Wayland sessions run via XWayland), enables transparent visuals, and delays window creation ~300 ms after ready. A `NOVA_ORB_OPAQUE=1` fallback renders the orb on a rounded dark plate for non-compositing environments. Native Wayland (no global positioning) is explicitly out of scope for v1; the bootstrap payload reserves a `dragStrategy` escape hatch.
- **Windows** sets an explicit AppUserModelID and maps `getUserMedia` failure to the existing permission-denied state with a Windows-specific hint.

## 5. Audio strategy

v1 ships `browser_aec` on Windows/Linux (Chromium AEC). The native helpers — WASAPI on Windows, PipeWire echo-cancel on Linux — are a later phase: each reimplements the existing stdio JSONL helper contract (`capture/play/terminal/clear/close` in, `ready/audio/playback.*` out), so no v1 code path changes when they land. The known v1 losses are hardware-grade AEC quality and the native playback-clear fence used for barge-in accounting.

## 6. Particle orb visual

The gradient-sphere visual (near-identical in construction to qwen-audio-agent's orb) is replaced by a Canvas 2D particle system (`src/renderer/orb-visual.mjs`, ~240 particles, no solid sphere). State is carried by particle behavior, with color as ambience:

| state | behavior |
|---|---|
| booting | particles drift in from the rim and assemble |
| idle | loose shell, slow Brownian drift, slow breathing |
| listening | strong inward convergence; shell radius follows smoothed mic RMS |
| speaking | outward pulses proportional to playback amplitude |
| interrupted | one-shot scatter, then listening behavior |
| error/disconnected | collapse to a dim slow ring |
| Codex working | an independent thin orbital band outside the main shell, visible over any base state |

Amplitude input reuses the renderer's existing PCM RMS window (mic) and an analyser on the playback graph (speaking). Performance budget: idle < 3% CPU, speaking < 10%, with tiered frame rates (60/30/15 fps by state), full stop when hidden or static, DPR capped at 2, and automatic particle-count halving under frame-time pressure. `prefers-reduced-motion` renders seeded static constellations (distinct per state); `prefers-contrast: more` keeps the existing solid-disc override.

Two palettes, switchable at runtime and persisted: **Ember** (warm amber: core `#FFB454`, highlight `#FFE3B3`, deep `#C96F2B`) and **Graphite Moonlight** (achromatic: core `#E8ECF2`, mid `#9AA3AF`, transient warm accent `#FFC978`). Both deliberately avoid the violet/periwinkle/teal cool band and the expanding-ring motif used by qwen-audio-agent, honoring the documented commitment not to adopt the baseline's UI branding or assets.

## 7. Settings panel

A right-click menu entry opens a singleton settings window (same pattern as the Memory Board window: separate BrowserWindow, shared session partition without re-bound permission handlers, `connect-src 'none'` CSP, sender-validated IPC). Settings persist in `userData/ambient-orb-settings.json` with the window-position module's atomic-write pattern plus per-field default merging.

Settings are tiered by blast radius, because backend configuration is injected only at spawn and a backend restart discards all in-memory channel state:

| tier | parameters | effect |
|---|---|---|
| renderer | palette | immediate (`nova:settings:changed` push) |
| backend | proactivity preset, Codex progress cadence, voice | next launch (panel says so explicitly) |

- **Proactivity** is a three-way preset (conservative / balanced / eager) mapping to `(suggestion cooldown, fresh window)` = (120 s, 20 s) / (60 s, 30 s) / (30 s, 45 s). It is not a numeric slider: the underlying constants are documented in-source as not empirically calibrated, and a 1–10 dial would invent precision. Floor priority thresholds are not preset-mapped — the arbitration invariant (monitoring-alert floor above the Codex executor priority) is preserved, and the preset only shifts how eagerly push suggestions surface, never who may preempt or must defer.
- **Codex progress cadence** is a real slider (15–120 s, default 30) bound to the app-server protocol's working-progress interval, promoted from a module constant to a `Settings` field.
- **Voice** maps to the existing `qwen_realtime_voice` field.
- **API keys** (DashScope, Tavily, model gateway, Codex) are configurable in the panel as password fields. Values are encrypted in the main process with Electron `safeStorage` (OS keychain-backed; explicit plaintext-fallback warning on Linux without a keyring) and stored as ciphertext; the renderer only ever sees set/unset booleans, never a stored value. At spawn, non-empty keys are injected as environment overrides, so they win over the user's `.env` without modifying it; clearing a key falls back to `.env`.
- Backend-tier values are injected as spawn environment variables (environment variables outrank the dotenv file in pydantic-settings), which avoids copying the user's API-key `.env` into a second file.

## 8. Packaging and CI

- `electron-builder`: the Swift helper's `extraResources` moves under the `mac` block; `win` gains an NSIS target, `linux` gains AppImage + deb (with a `fonts-noto-cjk` recommendation). Builds are never cross-compiled: each CI OS builds its own target. v1 ships unsigned (documented SmartScreen/Gatekeeper click-through).
- Icons are generated deterministically from the ember particle mark by a dependency-free script (PNG via zlib, ICO container, `iconutil` on macOS), replacing the invisible 1×1 tray pixel on every platform.
- CI: the electron job fans out to macOS/Ubuntu/Windows (`node --test` needs no display server); the python job adds a windows-latest leg (`continue-on-error` until green); a package job uploads installer artifacts.
- `THIRD_PARTY_NOTICES.md` and `LICENSES/` ship on every platform, including packages that do not contain the Swift helper binary.

## 9. iOS feasibility (appendix — no scheduled work)

Electron does not target iOS; an iOS client is a new project, not a port. Reusable assets: the loopback WS protocol (token hello + binary PCM frames) tolerates remoting the backend; the AEC logic transfers nearly verbatim (`kAudioUnitSubType_VoiceProcessingIO` exists on iOS / AVAudioEngine voice processing); the particle visual ports to Metal or an in-WKWebView canvas. The blocking constraints are product-shaped: iOS has no floating always-on-top window (candidate forms: in-app orb, Live Activity, widget), and always-on microphone background execution is an App Store policy risk. The existing AutoGLM/WebDriverAgent integration is the opposite direction (the desktop agent driving an iPhone) and is unrelated.

## 10. Risks

| risk | mitigation |
|---|---|
| Wayland lacks global positioning/shortcuts | pin X11/XWayland for v1; `dragStrategy` escape hatch reserved |
| Chromium AEC quality unknown on Win/Linux hardware | hardware spike before threshold tuning; onset thresholds tunable; native helpers are the eventual fix behind the preserved seam |
| `taskkill /T` may miss detached grandchildren | centralized call sites; upgrade to Job Objects only on orphan evidence |
| unsigned binaries trigger SmartScreen/Gatekeeper | accepted for v1; signing budgeted separately |
| compositor variance on Linux | transparent-visuals + delayed window creation + opaque fallback; v1 support matrix is GNOME/KDE |
| particle CPU regression | hard perf budget, tiered ticking, auto particle halving; reduced-motion static path doubles as a low-cost mode |
| users expect backend settings to apply immediately | tiered-effect model with explicit "next launch" copy; hot restart deferred until memory persistence exists |
