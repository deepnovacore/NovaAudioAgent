# Vision Installation and Proactive Demo Fix

## Problem

The documented setup path installs only the core and development dependencies with
`uv sync --dev`. The macOS Ambient Orb then starts a local camera unconditionally unless a desktop
video file is configured. Local camera and video-file sources both import OpenCV, but OpenCV belongs
to the optional `vision` extra. Following the README from setup through Ambient Orb startup can
therefore end in `CameraError` even though every documented command succeeded.

The proactive acceptance demo also contradicts the production Surrogate policy. Its user context
only says “帮我留意一下客厅”, while its assertion requires Surrogate to select a notification about
continued activity. The policy intentionally requires a reason to interrupt, such as an explicit
user-requested notification condition. The live model therefore correctly leaves the suggestion
unselected. A controlled run with “如果客厅持续有人活动，就提醒我” selected the same suggestion and
passed the complete Surrogate-to-FastBrain path.

## Design

Keep `vision` optional for the text-only CLI. Update the Ambient Orb instructions to install the
`vision` extra before starting the desktop app, and update the Conda backend bootstrap used by that
path to sync the same extra. The base text CLI setup remains lightweight.

Change only the proactive demo fixture, not the production Surrogate policy. The seeded user request
will explicitly ask to be notified when continued living-room activity is observed. The ambient
event and suggestion will state that this requested condition has been met. This preserves the
demo's purpose: a real Surrogate selects one eligible ambient suggestion, then FastBrain paraphrases
it through the existing two-hop route.

## Error Handling

The existing `CameraError` remains the fallback for environments missing OpenCV. Its command is
already correct and actionable. No runtime fallback should silently disable a camera the user or
desktop app explicitly requested.

The proactive demo remains a real-model acceptance scenario and continues to fail if Surrogate does
not select the offered suggestion, if FastBrain does not speak, or if the suggestion is not fired.

## Testing

Add a deterministic regression test around the proactive demo fixture. A policy-shaped fake
Surrogate will select only when the trusted user context contains an explicit notification request
and the matching ambient observation is present. This test must fail with the current ambiguous
fixture and pass after the fixture is corrected.

Update project-file tests to pin the documented Ambient Orb vision installation and the bootstrap
extra. Run the focused tests first, then the full test suite, and finally the live
`nova-audio-agent demo proactive` command with the configured model endpoint.

## Non-goals

- Do not make OpenCV a mandatory dependency for text-only users.
- Do not loosen the production Surrogate policy.
- Do not turn the proactive demo into a deterministic or non-gating model simulation.
- Do not silently fall back from an explicitly requested camera source.
