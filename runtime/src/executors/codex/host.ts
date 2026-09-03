/**
 * Host-authority surface of the Codex executor package: spawn factories, host config resolution,
 * the approval controller and the production host. Only composition roots (`desktop-entry.ts`,
 * `*-assembly.ts`) import this; it is deliberately absent from the package-root barrel so the
 * runtime package never exports authority bypasses (`test/codex-root-exports.test.ts`).
 */
export * from './approval.js'
export * from './factory.js'
export * from './host-config.js'
export * from './production-host.js'
