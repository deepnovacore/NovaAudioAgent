import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const DESKTOP_VIDEO_FILE_ENV = 'NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE'

export class MainCameraConfigurationError extends Error {
  constructor() {
    super(`${DESKTOP_VIDEO_FILE_ENV} must name an absolute regular file`)
    this.name = 'MainCameraConfigurationError'
  }
}

const defaultFileSystem = Object.freeze({
  realpath: path => realpathSync(path),
  stat: path => statSync(path),
})

const PYTHON_ONLY_SPACE = new Set(['\u001c', '\u001d', '\u001e', '\u001f', '\u0085'])

function isPythonSpace(character) {
  if (character === '\ufeff') return false
  return PYTHON_ONLY_SPACE.has(character) || character.trim() === ''
}

function stripLikePython(text) {
  const characters = [...text]
  let start = 0
  let end = characters.length
  while (start < end && isPythonSpace(characters[start])) start += 1
  while (end > start && isPythonSpace(characters[end - 1])) end -= 1
  return characters.slice(start, end).join('')
}

export function selectMainCameraSource(environment, fileSystem = defaultFileSystem) {
  const configured = stripLikePython(environment[DESKTOP_VIDEO_FILE_ENV] ?? '')
  if (configured === '') return Object.freeze({ source: 'local' })
  if (!isAbsolute(configured)) throw new MainCameraConfigurationError()
  try {
    const canonical = fileSystem.realpath(configured)
    if (!fileSystem.stat(canonical).isFile()) throw new MainCameraConfigurationError()
    return Object.freeze({ source: 'file', file: canonical })
  } catch {
    throw new MainCameraConfigurationError()
  }
}
