export type NativeFileLockResult =
  | Readonly<{status: 'acquired'; release: () => void | Promise<void>}>
  | Readonly<{status: 'busy' | 'unsupported' | 'failed'}>

/** Host-owned native advisory lock. The descriptor was already opened and validated by TypeScript. */
export interface NativeFileLockAuthority {
  acquire(descriptor: number): NativeFileLockResult | Promise<NativeFileLockResult>
}

/** Production stays fail-closed until Task 8 supplies and audits the packaged Node-API module. */
export const unsupportedNativeFileLocks: NativeFileLockAuthority = Object.freeze({
  acquire: (descriptor: number): NativeFileLockResult => {
    void descriptor
    return {status: 'unsupported'}
  },
})
