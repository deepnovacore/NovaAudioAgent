export interface ProjectFileIdentity {
  readonly device: bigint
  readonly inode: bigint
}

export type ProjectRootFileResult = Readonly<{
  status: 'ok' | 'mismatch' | 'exists' | 'missing' | 'unsupported' | 'failed'
}>

export type ProjectRootFileLookupResult =
  | Readonly<{status: 'ok'; identity: ProjectFileIdentity}>
  | Readonly<{status: 'missing' | 'unsupported' | 'failed'}>

export type ProjectRootFileCreateResult =
  | Readonly<{status: 'ok'; identity: ProjectFileIdentity}>
  | Readonly<{status: 'exists' | 'unsupported' | 'failed'}>

/** Host-only descriptor-relative filesystem authority. No caller-controlled path enters this API. */
export interface ProjectRootFileAuthority {
  probe(rootDescriptor: number): ProjectRootFileResult
  matchesAt(rootDescriptor: number, name: string, childDescriptor: number): ProjectRootFileResult
  lookupAt(rootDescriptor: number, name: string): ProjectRootFileLookupResult
  createFileAt(rootDescriptor: number, name: string, exclusive: boolean): ProjectRootFileCreateResult
  mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult
  /** Windows-only private create seam; callers fail closed when it is unavailable. */
  mkdirPrivateAt?(rootDescriptor: number, name: string): ProjectRootFileCreateResult
  /** Windows-only ACL repair seam for an already-retained exact child. */
  protectAt?(
    rootDescriptor: number,
    name: string,
    childDescriptor: number,
  ): ProjectRootFileResult
  renameAt(rootDescriptor: number, from: string, to: string): ProjectRootFileResult
  unlinkAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
    kind: 'file' | 'directory',
  ): ProjectRootFileResult
}

/** Production stays fail-closed until Task 8 supplies the packaged descriptor-relative helper. */
export const unsupportedProjectRootFiles: ProjectRootFileAuthority = Object.freeze({
  probe: (): ProjectRootFileResult => ({status: 'unsupported'}),
  matchesAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
  lookupAt: (): ProjectRootFileLookupResult => ({status: 'unsupported'}),
  createFileAt: (): ProjectRootFileCreateResult => ({status: 'unsupported'}),
  mkdirAt: (): ProjectRootFileCreateResult => ({status: 'unsupported'}),
  mkdirPrivateAt: (): ProjectRootFileCreateResult => ({status: 'unsupported'}),
  protectAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
  renameAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
  unlinkAt: (): ProjectRootFileResult => ({status: 'unsupported'}),
})
