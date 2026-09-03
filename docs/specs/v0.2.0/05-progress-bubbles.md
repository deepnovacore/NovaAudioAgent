# 05. Progress Bubbles

> 摘要：设置 `progressBubbles: off | milestones | all`（默认 milestones）。Runtime 通过新的 `executor.progress` 线框把委派进展推到桌面；orb 上方最多叠 3 条气泡。气泡是**提醒**，不是审计：几秒即逝、最多三条。审计与结果回看走「最近一次结果」入口（常驻、可点开）。审批仍走横幅，不进气泡。气泡不得改变 orb 状态或 Floor 优先级。原生窗口尺寸、屏幕边缘、缩放与横幅共存进入验收。
>
> 修订（2026-09-03）：回应产品建议「气泡适合提醒，不适合承担审计」。

## Baseline (today)

- Orb shows `#state-label` (`待命 · Codex 空闲`, etc.) and a confirmation pill
  for project / Codex approval. There is no toast or bubble stack
  (`desktop/ambient-orb`).
- `#caption` exists for transcripts but is hidden in the compact layout.
- Codex working progress is often `progress_via_surrogate`; started / final
  become host facts that FrontBrain may paraphrase under Floor.
- README thesis: restrained proactivity — not every Codex event is worth
  speaking.

## Goals

1. Optional glanceable progress above the orb without forcing speech.
2. Levels that match existing attention bands (milestone vs detail).
3. A persistent “last result” entry so a missed bubble is never the only record
   of what a task did (qwen-audio-agent keeps a Task record as a delivery
   receipt; Nova’s equivalent is the Codex project store + Memory Board, and
   the orb needs one affordance that opens it).
4. Keep approval UX on the dedicated banner path; bubbles never carry
   authorization, never drive orb state, never change Floor.

## Non-goals

- OS Notification Center toasts for in-session progress (qwen uses OS notify
  mainly when asleep; out of scope here).
- Task-card side panel like qwen’s desktop task cards (may revisit later).
- Letting bubbles preempt Floor or carry authorization.
- Showing raw paths / secrets / full command lines in bubble text (summaries
  only; same redaction posture as approval `operation_summary` vs
  `local_detail`).

## Setting

| Key | Values | Default |
|---|---|---|
| `progressBubbles` | `off` \| `milestones` \| `all` | `milestones` |

Env: `NOVA_AUDIO_AGENT_PROGRESS_BUBBLES`. Settings tab **通知**.

| Mode | Publishes |
|---|---|
| `off` | Nothing |
| `milestones` | `level: milestone` only |
| `all` | `milestone` and `detail` |

## Wire frame

New desktop wire type `executor.progress`:

```json
{
  "type": "executor.progress",
  "delegate_id": "delegate-…",
  "executor": "codex",
  "phase": "working",
  "summary": "正在安装依赖",
  "level": "detail",
  "ts": 0
}
```

Rules:

- Published from `DesktopBridge` when the backend observes `progress`,
  `handoff`, or high-signal `observation` events.
- `summary` is already-sanitized short Chinese/English text (reuse progress
  summary projection where possible). No paths, tokens, or full argv.
- Schema-validated on both sides; unknown fields dropped.
- Does not require a FrontBrain turn.

## Level derivation

| Event | Level |
|---|---|
| Codex / executor started | `milestone` |
| Terminal handoff ok / failed | `milestone` |
| Surrogate-selected suggestion that would be spoken | `milestone` (bubble may show even if Floor defers speech) |
| Guard alert | `milestone` |
| Codex working-summary change | `detail` |
| Watch ambient hit | `detail` (or suppress unless `all`) |
| YOLO auto-run command / network activity summary | `detail` — a reminder only; the record is the project store, not the bubble |

Exact mapping table lives next to the projector implementation and is covered
by unit tests. Prefer missing a detail bubble over leaking sensitive text.

## Last-result entry

- The `#state-label` (or a small affordance beside it) becomes clickable when
  the most recent delegate has a terminal outcome. Clicking opens the existing
  Memory Board / project-store view scrolled to that delegate (or, until that
  view has deep links, a compact native panel listing outcome, summary,
  changed-file count, and start/end time).
- The entry persists until the next dispatch replaces it; it does not
  auto-dismiss and is independent of `progressBubbles` (it exists even at
  `off`).
- YOLO runs show the same entry; audit goes there, not into bubbles.

## Renderer UX

- Container `#bubble-stack` anchored above the orb.
- Max 3 visible; newest at the edge closest to the orb (document the order in
  CSS comments). Overflow drops the oldest.
- Auto-dismiss: 6 s for `detail`, 12 s for `milestone` (pause on hover).
- Click dismisses one; click-through outside the stack so the orb remains
  usable.
- Respect `prefers-reduced-motion` (no aggressive slide spam).
- Approval / project confirmation **never** uses this stack.

## Native window constraints

Renderer CSS alone cannot guarantee bubbles are visible: the orb is a small
frameless `BrowserWindow`, and content outside its bounds is clipped by the OS.

- The main process owns a `reserveBubbleArea(rows)` step that grows the window
  bounds upward (or downward when the orb is near the top edge) before the
  first bubble renders, and shrinks after the stack empties. Bounds changes go
  through the same code path the confirmation banner uses today so the two
  never fight.
- Screen edges: when the orb sits within one bubble-height of the top edge,
  the stack flips below the orb; when near a side edge, bubbles right- or
  left-align to stay on screen. Multi-monitor: bounds are clamped to the
  display that contains the orb’s centre.
- DPI / zoom: bubble sizing uses CSS px; the main process converts with the
  display `scaleFactor` when reserving bounds. `zoomFactor` changes re-run the
  reservation.
- Banner coexistence: if the approval / project banner is visible, bubbles
  render on the opposite side of the orb from the banner; if there is no room,
  bubbles are suppressed (queued frames are dropped, not delayed) until the
  banner closes. The banner always wins.

## Interaction with speech

Bubbles do not change Floor priorities. They are a parallel observability
channel. Product copy in README may note: milestones can be glanced as bubbles
so Surrogate can stay quiet more often — but Surrogate policy changes are not
required to ship bubbles.

## Implementation touchpoints

| Area | Files |
|---|---|
| Projection | `runtime/src/desktop-bridge.ts`, possibly a small progress-projector module |
| Wire | `runtime/src/desktop-wire.ts`, `runtime/src/desktop.ts` inbound/outbound schemas if needed |
| Orb | new `bubbles.mjs` (or equivalent), `index.mjs`, `index.css` |
| Settings | store v4 + 通知 tab |

## Verification checklist

- [ ] Wire schema accepts valid frames; rejects oversized summaries.
- [ ] `off` publishes nothing; `milestones` filters detail; `all` includes both.
- [ ] Stack cap 3; dismiss and auto-dismiss timers tested with fake clock.
- [ ] Approval banner still exclusive; no bubble for pending approval; with a
      banner visible, bubbles move to the opposite side or are suppressed.
- [ ] YOLO detail bubble shows sanitized command summary only.
- [ ] Last-result entry appears after a terminal outcome at every
      `progressBubbles` value, including `off`; opens the record view.
- [ ] Main-process bounds reservation: window grows before first bubble,
      shrinks when empty; unit test with a fake `BrowserWindow` for top-edge
      flip, side-edge alignment, multi-display clamp, and `scaleFactor` 2.0.
- [ ] Manual: macOS Retina + external 1080p, Windows 125% / 150% scaling —
      three bubbles fully visible, none clipped, orb still draggable.
- [ ] Reduced-motion path does not throw.
- [ ] No secret / absolute path in fixture summaries.

## Decision-record delta (apply on merge)

Add the “Progress UX” row from [00-overview.md](00-overview.md).
