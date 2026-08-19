/**
 * The desktop service loop: one authenticated renderer talking to one runtime.
 *
 * Extracted from the entry so it can be tested without spawning a process. The entry owns
 * process signals and configuration; this owns the order of startup and shutdown.
 */

import type { Assembly } from './assembly.js'
import type { DesktopControl, DesktopReadiness, NodeDesktopServer } from './desktop.js'

export interface DesktopServiceOptions {
  readonly assembly: Assembly
  readonly server: NodeDesktopServer
  readonly readyEndpoint: string
  readonly stop: AbortController
  readonly announce: (endpoint: string, readiness: DesktopReadiness) => Promise<void>
  readonly onControl?: (control: DesktopControl) => void
}

/**
 * Start the server, announce readiness, then serve until the stop signal.
 *
 * Readiness is announced only after the server is listening, because the parent treats it
 * as permission to connect. Serving starts before the announcement so no renderer frame
 * can arrive at a runtime that is not yet draining its queue.
 */
export async function runFromEnvironment(options: DesktopServiceOptions): Promise<void> {
  const {assembly, server, stop} = options
  const serving = assembly.runtime.serve(stop.signal)
  try {
    const readiness = await server.start()
    await options.announce(options.readyEndpoint, readiness)
    if (!stop.signal.aborted) {
      await new Promise<void>(resolve => {
        stop.signal.addEventListener('abort', () => resolve(), {once: true})
      })
    }
  } finally {
    // Close the transport first so no new frame can enter, then let the runtime drain.
    await server.close()
    stop.abort()
    await serving
  }
}
