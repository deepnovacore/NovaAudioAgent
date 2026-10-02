# Supervised mobile use

`mobile.run` is Nova's phone capability. The current engine uses the native TypeScript Midscene SDK (1.12.9), with `autoglm-phone` as the model. It adds no Python service. The legacy `autoglm` executor remains available independently.

Nova owns task admission, approvals, cancellation, device ownership and result trust. Midscene owns screenshot-based planning. Guarded Tap, Type, single Swipe and Home actions reach WDA or an explicitly selected Android device through fixed ADB commands. Android also supports Back and launching an installed app by exact package name. This small transport avoids the SDK iOS client's automatic fallback actions and incomplete timeout coverage. Model-generated shell commands, arbitrary intents or WDA requests, and automatic device selection are unavailable.

## Configuration

Select `mobile` in `EXECUTORS` and supply:

| Variable prefix `MOBILE_` | Value |
| --- | --- |
| `ENGINE` | `midscene` (default; other engines rejected) |
| `DEVICE_TYPE` | `android` or `ios-simulator` |
| `DEVICE_ID` | Exact authorized ADB serial or booted simulator UUID |
| `WDA_URL` | Existing loopback WDA, e.g. `http://127.0.0.1:8710` |
| `BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` |
| `MODEL` | `autoglm-phone` |
| `MODEL_FAMILY` | `auto-glm` |
| `API_KEY` | Secret supplied locally, never committed |
| `MAX_STEPS` | Default 30, maximum 100 |
| `TIMEOUT_SECONDS` | Default 600, maximum 1800 |
| `SETTLE_MS` | Default 4000, range 0–30000; wait for iOS animations before initial planning and after actions |

Provision a WDA session before dispatch. The runner borrows it without starting WDA, creating a session or changing its settings. It verifies the simulator UUID and local WDA listener process identity; physical iOS currently fails closed. WDA and the runtime need local `simctl`, `lsof` and `ps` access.

## Android preparation

Select `DEVICE_TYPE=android` and the serial shown as `device` by `adb devices -l`. Install and enable ADB Keyboard as described in [AutoGLM setup](autoglm.md#optional-android-setup). Input appends UTF-8 text to the focused field and restores the previous input method, including after cancellation. Keep USB debugging enabled; some OEM phones also require their separate USB debugging security permission for input injection. WDA is unused on Android.

Launch accepts only an exact installed package name; no application-name mapping or shell command is inferred. Every action passes through Nova's existing approval and device/window guard. Midscene plans from full device screenshots; coordinates use that same screen. Pixel changes alone do not invalidate an action. A changed foreground window or screen dimensions stops the run with `screen_changed`. An uncertain ADB write or keyboard restoration retains the device quarantine lock.

## Interaction with Nova

This follows the existing downstream-agent controller and event path used by coding agents. `mobile` is registered as an agent with a reserved `run_id`; the conversation cannot invoke an unreserved run directly.

| Midscene / host event | Nova channel |
| --- | --- |
| `aiAct.plan_thinking` | Existing executor progress, fixed planning summary |
| Guard about to request permission | Progress plus the shared host approval UI |
| Host accept / decline | Structured `HostApprovalController` decision, consumed once |
| Concrete WDA request returns | Progress and last returned action evidence; no claim about its effect |
| Model finishes | Untrusted handoff with `verified:false`, `effects:unknown` |
| Nova cancellation / deadline | Abort latch, approval invalidation and no subsequent device action |

The SDK exposes action/plan lifecycle events; this integration does not claim token-by-token model streaming. Raw thoughts, screenshots, parameters and provider errors are not copied into trusted progress summaries. Rejected actions abort the runner because the SDK otherwise catches action errors and may replan.

## Extending it

Model URL, name and family are independent of the `mobile` capability. This first implementation admits AutoGLM families only; enabling another family requires verifying its action mapping, cancellation and completion semantics. A different agent replaces `runMobileIos` behind `MobileExecutor`; the host controller, shared approvals and device lock remain intact. There is no general plugin protocol or Python bridge to maintain.

Both phone engines use the existing `autoglm-devices` lock directory during migration. A crash or uncertain write leaves a quarantine directory; remove it only after confirming the old owner and device writes have stopped. `cleanup_unknown` overrides a cancellation result when the write's completion cannot be established.

## Acceptance

Build serially, then run `node runtime/scripts/accept-mobile-simulator.mjs /absolute/path/evidence.json` with explicit simulator configuration. This exercises a local scripted model through real Midscene and WDA, including approval, decline and cancellation.

Run `node runtime/scripts/accept-mobile-actions-simulator.mjs /absolute/path/actions.json` to verify Tap, Type and Swipe on a local Safari fixture. The page records actual click/input/scroll events; model completion alone does not pass these checks. Keep evidence in a persistent private directory rather than temporary storage.

For a bounded live-model Home task, add `--live` and set `NOVA_MOBILE_MODEL_CONFIG` to a private JSON file with `baseUrl`, `model`, `modelFamily` and `apiKey`. The harness accepts only one exact Home action, and separately checks the foreground app through WDA. Never use this harness against a personal phone.

Nova checks device identity, foreground context and geometry before and after approval; it does not equate pixel equality with action validity. Midscene owns visual planning and observes again after each action. In-place changes inside the same window can still make a planned action stale: this is a supervised GUI agent, not an atomic UI transaction. Host approval authorizes the exact proposed action, and model completion remains unverified. The settling delay reduces planning during animations; it does not guarantee a stable screen. The simulator Home harness separately waits for its fixture to settle. A dispatched WDA write cannot be undone; cancellation waits for acknowledgment or a bounded timeout, retaining the lock on uncertainty. The SDK's post-action settling wait can also delay cancellation completion by up to `SETTLE_MS`; no subsequent write is permitted. SDK report and file logging are disabled; SDK warnings and explicitly enabled debug console output remain upstream behavior. The SDK is trusted local code, not an OS sandbox.

For Android with real models, run `node runtime/scripts/accept-mobile-android.mjs ENV_FILE PRIVATE_MODEL_JSON ADB_SERIAL INSTRUCTION OUTPUT_JSON`. This submits text through the production Nova frontend and `host.dispatch`, then uses the real mobile executor, host approval controller, Midscene and ADB. Enter `accept` for each reviewed action; other input declines a pending action. When no action is pending, input is sent to Nova as a follow-up. The private model JSON has `baseUrl`, `model`, `modelFamily` and `apiKey`. The report includes dispatch, approvals and terminal evidence; independently inspect the phone for the requested UI result. This does not test the desktop UI, physical microphone or speaker.
