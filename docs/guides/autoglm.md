# Supervised iPhone execution with AutoGLM

AutoGLM is optional and disabled by default. iOS is the primary device configuration; Android is also supported when explicitly selected. It uses the official Python IOSPhoneAgent/PhoneAgent as a subprocess of Nova's Node runtime. iPhone setup requires a Mac with Xcode, Python 3.10+, libimobiledevice/usbmuxd, WebDriverAgent (WDA) running on the iPhone, and an OpenAI-compatible AutoGLM model service. Screenshots and task instructions are sent to that service. Keep the phone in view and approve each write action in Nova; approvals describe coordinates and input, and do not independently verify business intent.

## Install the pinned bridge dependency

The supported upstream is [zai-org/Open-AutoGLM at 86f55382982fb054e8fc98ca80609dff8a2cdc3c](https://github.com/zai-org/Open-AutoGLM/tree/86f55382982fb054e8fc98ca80609dff8a2cdc3c), licensed [Apache-2.0, Copyright 2025 Zhipu AI](https://github.com/zai-org/Open-AutoGLM/blob/86f55382982fb054e8fc98ca80609dff8a2cdc3c/LICENSE). Nova does not vendor upstream. Keep the checkout: the bridge verifies its revision and actual package source bytes against the pinned tree before import; a package version string alone is insufficient. Do not modify that checkout.

```sh
git clone https://github.com/zai-org/Open-AutoGLM.git "$HOME/Open-AutoGLM"
git -C "$HOME/Open-AutoGLM" checkout --detach 86f55382982fb054e8fc98ca80609dff8a2cdc3c
python3 -m venv "$HOME/.venvs/nova-autoglm"
"$HOME/.venvs/nova-autoglm/bin/python" -m pip install 'Pillow==12.0.0' 'openai==2.9.0' 'requests==2.32.5' "$HOME/Open-AutoGLM"
```

## Prepare the iPhone and WDA

Follow upstream's [iOS setup guide](https://github.com/zai-org/Open-AutoGLM/blob/86f55382982fb054e8fc98ca80609dff8a2cdc3c/docs/ios_setup/ios_setup.md): install Xcode, sign WebDriverAgentRunner with your development team, enable Developer Mode and device trust, select the intended iPhone, and run the WebDriverAgentRunner test target. This provisioning is separate from Nova execution.

Select an exact USB-connected UDID. For the one-time session provisioning below, open a temporary forwarding process:

```sh
brew install libimobiledevice usbmuxd
idevice_id -l
# Replace YOUR_IPHONE_UDID with the selected UDID, in both Nova and this command.
iproxy -u YOUR_IPHONE_UDID -l -s 127.0.0.1 8100:8100
```

In another terminal, provision one WDA session with no app-launch capability:

```sh
curl --fail --show-error -H 'Content-Type: application/json' -d '{"capabilities":{}}' http://127.0.0.1:8100/session
curl --fail --show-error http://127.0.0.1:8100/status
```

The status response must identify an existing session. Stop that temporary forwarding process after provisioning. The bridge deliberately does not create a session, pair a device, install WDA, or launch an app during startup. Configure the WDA URL as `http://127.0.0.1:8100`, and the device ID as that exact UDID. During every task Nova's bridge creates its own [iproxy USB tunnel](https://github.com/libimobiledevice/libusbmuxd/blob/master/docs/iproxy.1) with that UDID and a fresh local port; the configured port denotes the WDA port on the phone. It never reuses an unknown local listener and closes its forwarding child before returning a terminal result. No manually running proxy is needed during Nova execution.

For a remote HTTPS WDA service, the status response must report the exact configured UDID; missing or mismatching identity is rejected. Local USB enumeration must also contain that UDID. Loopback WDA configuration accepts HTTP with no path; remote HTTPS may use a deployment path. WDA redirects are rejected and HTTPS certificates are verified.

iOS Type clears the focused input, types, and hides the keyboard within its approved action. Back is an edge swipe, not a universal app navigation guarantee. WDA logical screen dimensions determine gesture coordinates; the bridge overrides upstream's fixed 3x assumption. Failure or cancellation can leave any multi-command action partly applied.

## iOS Simulator acceptance

For a Mac with an installed iOS Simulator runtime, set `AUTOGLM_DEVICE_TYPE=ios-simulator` and use the exact booted Simulator UDID from `xcrun simctl list devices booted -j`. Build and run WebDriverAgentRunner for that Simulator, then provision its WDA session as above. Set `AUTOGLM_WDA_URL` to its HTTP loopback URL (no deployment path).

Simulator mode does not use USB enumeration or iproxy. It verifies the booted UDID and binds the local WDA listener process to that Simulator's `SIMULATOR_UDID`, rechecking process identity before WDA requests. A proxy in front of WDA is unsupported. The physical iOS mode remains the default.

Bind WDA itself to loopback and disable its unused MJPEG listener. If using an alternate Xcode installation, export its `DEVELOPER_DIR` when starting both WDA and Nova. Keep WDA test products on the local disk if external-volume dynamic-library loading stalls; the larger Xcode and runtime files can remain external. Wait for Simulator boot and the first WDA foreground-app/screenshot reads to complete before acceptance; cold XCTest initialization can exceed the harness's ten-second read timeout.

After building the runtime and provisioning WDA, run `node runtime/scripts/accept-autoglm-simulator.mjs /absolute/path/evidence.json` with the configured Python, source checkout, UDID and WDA environment variables. This uses a local scripted model, opens Simulator Settings as test setup, and checks accepted Home, declined Home, and cancellation against actual foreground-app state. It writes JSON and before/after screenshots. This checks the controller, host approval, bridge and WDA path; voice UI and model quality require separate acceptance.

## Optional Android setup

Select `android`, install Android platform-tools, run `adb devices -l`, and configure the exact serial of one entry in `device` state. Empty, missing, offline, or unauthorized serials are rejected; the bridge never chooses the first phone. Authorize USB debugging on the phone. Text input also requires upstream's [ADB Keyboard setup](https://github.com/zai-org/Open-AutoGLM/tree/86f55382982fb054e8fc98ca80609dff8a2cdc3c). A Type approval includes switching the input method, clearing the focused field, typing, and restoring the previous input method.

The bridge receives `AUTOGLM_SOURCE_PATH` (absolute checkout path) and `AUTOGLM_API_KEY` through its environment. Configure Nova with the absolute virtualenv Python executable, device type, explicit UDID/serial, model name, and base URL. Use HTTPS for remote services; HTTP is accepted only for localhost, 127.0.0.1, or ::1. Keep API keys out of command arguments, task text, and logs.

## Configure Nova

Set these in the environment that starts Nova. No new desktop settings page is required. Use the plural executor selector to keep Codex alongside AutoGLM; select only `autoglm` to omit Codex.

```sh
export EXECUTORS=codex,autoglm
export AUTOGLM_DEVICE_TYPE=ios
export AUTOGLM_DEVICE_ID='YOUR-IPHONE-UDID'
export AUTOGLM_WDA_URL='http://127.0.0.1:8100'
export AUTOGLM_PYTHON="$HOME/.venvs/nova-autoglm/bin/python"
export AUTOGLM_SOURCE_PATH="$HOME/Open-AutoGLM"
export AUTOGLM_BASE_URL='https://your-model-service.example/v1'
export AUTOGLM_MODEL='autoglm-phone'
# Supply AUTOGLM_API_KEY through your local secret environment.
```

`DEVICE_TYPE` defaults to `ios`. `MAX_STEPS` defaults to 30 (range 1–100); `TIMEOUT_SECONDS` defaults to 600 (range 1–1800). Both use the `AUTOGLM_` prefix. The model URL accepts HTTPS, or loopback HTTP for a local model. An explicit API key is required; a local unauthenticated service can use its documented placeholder key.

Host support is macOS/Linux; Windows execution is refused. Each task owns its bridge process group. A shared device reservation lives under `~/.nova-audio-agent/autoglm-devices/`, keyed by platform and device identity. If Nova crashes or cannot confirm cleanup, the reservation remains and subsequent tasks refuse with `device_busy`. Check the recorded host/task identity and stop the owned processes before manually removing that one reservation directory; do not delete all device locks or stop the shared ADB server. There is no automatic retry or recovery of a partially executed task.

Removing `autoglm` from `EXECUTORS` disables it and avoids loading Python. Runtime package and desktop packaging include the bridge script; the pinned upstream checkout, Python environment, WDA and credentials remain explicit host prerequisites.

## Execution behavior

Each Launch, Tap, Type/Type_Name, Swipe, Back, Home, Double Tap, and Long Press pauses before upstream device execution. The approval is single-use and tied to the task, request, step, action, foreground package, and inference screenshot. After approval the package and screenshot pixels must still match; a change stops the task with `screen_changed`. Animated screens may therefore be incompatible. This cannot eliminate changes between the final check and the actual device command.

Screenshots are captured in memory through WDA (or Android `adb exec-out`); no screenshot file is archived. Upstream stdout and stderr, including model thinking and input text, are discarded before importing upstream. Only typed protocol messages are returned. WDA/ADB failures, model errors, and parse errors stop execution, including upstream paths that normally turn errors into `finish`. Model requests have no retries and at most 60 seconds; the monotonic total budget includes approval time. Wait is limited to five seconds. Take_over and Interact stop with `needs_user_action`; Note, Call_API, and unknown actions are rejected.

`model_finished` means the model reports completion, not that Nova verified the phone's final state. Returned device commands also do not prove their UI effect. On cancellation or failure, prior operations may remain applied; inspect the phone before starting another task.

## Checks and acceptance

Run deterministic checks without a phone or API key:

```sh
python3 -m unittest discover -s runtime/scripts -p test_autoglm_bridge.py
AUTOGLM_TEST_SOURCE="$HOME/Open-AutoGLM" "$HOME/.venvs/nova-autoglm/bin/python" -m unittest discover -s runtime/scripts -p test_autoglm_bridge.py
npm run build --workspace runtime
AUTOGLM_TEST_PYTHON="$HOME/.venvs/nova-autoglm/bin/python" node --test runtime/dist/test/executors-autoglm.test.js
```

The second command exercises the real pinned IOSPhoneAgent and PhoneAgent with fake model responses, WDA, and ADB. The isolated installation and both commands were verified on macOS with Python 3.14.6, Pillow 12.0.0, openai 2.9.0, and requests 2.32.5. Upstream declares Python >=3.10; other Python/OS combinations have not been acceptance-tested here. Transitive dependencies follow those packages' declared constraints.

On 2026-09-18, the acceptance script passed all three scenarios on an iPhone 15 Simulator with iOS 17.5, Xcode 16.4 and WDA 9.9.0. Accepted Home changed the foreground app from Settings to SpringBoard; decline and cancellation while awaiting approval kept Settings in front. Each request contained a real WDA screenshot, and task locks were released. The model was a local scripted endpoint; this does not validate model quality, voice UI, cancellation during an in-flight device action, or a physical phone.

Real-device acceptance remains deferred. Disable the AutoGLM module to stop registering it; remove its dedicated virtualenv and source checkout only after its tasks have stopped.
