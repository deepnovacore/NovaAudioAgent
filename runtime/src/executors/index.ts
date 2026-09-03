/**
 * Executor package registry.
 *
 * The only module through which core-adjacent code (the barrel, `desktop.ts`) and composition
 * roots reach a concrete executor package. Adding an executor means adding one line here.
 */
export * from './codex/index.js'
