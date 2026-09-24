# Nova orb skins (v1)

For the proposed multi-file custom skin package and review criteria, see [Skin specification draft](../docs/SKIN_SPEC.md). That v2 format is not implemented; this page describes the currently supported v1 import.

Open **Settings → General → Orb skin**, import `jarvis.nova-skin.json`, review the static preview and click **Save**. The orb switches live; the voice backend does not restart for a skin-only change. Choose **Nova** to return to the original visual. **Discard skin changes** restores the saved skin/library without discarding other settings drafts.

**Remove selected skin** removes an imported skin and selects Nova. Removal is staged until Save. Duplicate IDs are rejected: remove the old skin before importing its replacement. Closing the settings window without saving discards the draft. The import copies validated data into the desktop settings file, so the source JSON may be moved or deleted afterward. No account or API key is needed for skins.

## Package format

Use the included Jarvis package as a starting point. All fields are required; extra fields are rejected.

| Field | Accepted values |
| --- | --- |
| `version` | `1` |
| `id` | 1–48 lowercase ASCII letters, digits or hyphens; starts with a letter; `nova` is reserved |
| `name` | Nonempty display name, at most 64 characters, no control/directional-override characters |
| `renderer` | `particle-core` |
| `color`, `accent` | Six-digit hexadecimal colors, e.g. `#5cddff` |
| `particleCount` | Integer from 120 to 600 |
| `rotationSpeed` | Number from 0 to 1; sphere rotation in radians per second |

Files are limited to 8 KiB and the library to 16 imported skins. v1 describes trusted built-in rendering code; it cannot contain JS, CSS, HTML, images, network addresses or filesystem references. Supporting a new renderer requires a reviewed application change. `rotationSpeed: 0` freezes sphere rotation; the accessibility preference for reduced motion stops all animation.

Skin colors do not override warning/error colors. Microphone and playback amplitudes come from Nova's real audio path. Jarvis retains mute, reconnect, error and Codex activity presentation, while the native drag target, menus and accessible state labels remain owned by Nova. Hover palette touring remains available for the original Nova skin; imported skins retain their own colors.

Malformed persisted libraries and missing selections recover to Nova. Canvas failures release the custom renderer and fall back to the original guarded visual. Each switch disposes timers, animation frames and media-query listeners. Skins survive normal application upgrades that preserve this settings schema; older clients without skin support may drop these fields on save.

## Verification

From the repository root:

```sh
npm ci
npm run build --workspace @nova-audio-agent/runtime
node --test clients/desktop/test/orb-skins.test.mjs clients/desktop/test/orb-particle-core.test.mjs clients/desktop/test/settings-store.test.mjs clients/desktop/test/settings-panel.test.mjs clients/desktop/test/app-protocol.test.mjs clients/desktop/test/capabilities-settings.test.mjs clients/desktop/test/settings-apply.test.mjs clients/desktop/test/orb-visual.test.mjs clients/desktop/test/palette-hover.test.mjs
npm exec --workspace @nova-audio-agent/desktop -- electron scripts/orb-skin-smoke.mjs
```

The Chromium smoke uses isolated settings and no audio/provider services. It checks invalid import, preview, discard, save, reload, removal and renderer errors, and writes `output/orb-skin-settings.png`. It is not an end-to-end voice-call or installer release test.

The v1 package changes the orb skin only. Cockpit transformation, voice-triggered skin switching and an online skin gallery are separate features.
