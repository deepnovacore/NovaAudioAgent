/**
 * The camera port the Watch/Guard executors observe through, and its disabled implementation.
 *
 * Ported from the parts of `src/nova_audio_agent/executors/camera.py` that Watch depends on. The
 * capturing sources -- `OpenCVFrameSource`, `VideoFileFrameSource`, and the `resolve_camera_source`
 * policy that picks between them -- are **not** here: they land with the Camera executor. What is
 * here is the seam and the honest no-camera answer, which is what a host without a configured
 * camera actually runs.
 */

import type { Frame, FrameSource } from './watcher.js'

/**
 * A camera that is not attached.
 *
 * Returns no frame rather than throwing, matching `DisabledFrameSource.snapshot` (camera.py:75).
 * The distinction matters: Watch counts a missing frame as a capture failure and reports
 * `capture_unavailable`, which is a truthful answer about the host. A source that pretended to
 * capture would make a window look like it was monitoring something.
 */
export class DisabledFrameSource implements FrameSource {
  start(): Promise<void> {
    return Promise.resolve()
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }

  snapshot(): Promise<Frame | null> {
    return Promise.resolve(null)
  }
}
