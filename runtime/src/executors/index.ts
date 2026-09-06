/**
 * Executor package registry.
 *
 * Aggregate public exports for the barrel and `desktop.ts`. Compositions may use an executor's
 * dedicated entry point to avoid eagerly loading unrelated packages.
 */
export * from './codex/index.js'
export * from './vision.js'
export * from './fixture/index.js'
