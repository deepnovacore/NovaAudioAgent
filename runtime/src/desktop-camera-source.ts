import {realpathSync, statSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import {stripLikePython} from './python-text.js'

export const DESKTOP_VIDEO_FILE_ENV = 'NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE'

export type DesktopCameraSelection =
  | {readonly source: 'local'}
  | {readonly source: 'file'; readonly file: string}

export interface CameraFileSystem {
  realpath(path: string): string
  stat(path: string): {isFile(): boolean}
}

export class DesktopCameraConfigurationError extends Error {
  constructor() {
    super(`${DESKTOP_VIDEO_FILE_ENV} must name an absolute regular file`)
    this.name = 'DesktopCameraConfigurationError'
  }
}

const nodeCameraFileSystem: CameraFileSystem = {
  realpath: path => realpathSync(path),
  stat: path => statSync(path),
}

export function selectDesktopCameraSource(
  environment: NodeJS.ProcessEnv,
  fileSystem: CameraFileSystem = nodeCameraFileSystem,
): DesktopCameraSelection {
  const configured = stripLikePython(environment[DESKTOP_VIDEO_FILE_ENV] ?? '')
  if (configured === '') return {source: 'local'}
  if (!isAbsolute(configured)) throw new DesktopCameraConfigurationError()

  try {
    const canonical = fileSystem.realpath(configured)
    if (!fileSystem.stat(canonical).isFile()) throw new DesktopCameraConfigurationError()
    return {source: 'file', file: canonical}
  } catch {
    throw new DesktopCameraConfigurationError()
  }
}
