import {spawn} from 'node:child_process'
import {isAbsolute} from 'node:path'
import {realpath, stat} from 'node:fs/promises'
/** Only a host-resolved directory reaches the native file manager; never a renderer URL. */
export async function openTaskDirectory(path: string, launch: (file: string, args: readonly string[]) => Promise<void> = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, [...args], {detached: true, stdio: 'ignore'})
  child.once('error', error => reject(new Error('task directory opener failed', {cause: error})))
  child.once('spawn', () => { child.unref(); resolve() })
}), platform: string = process.platform, stillWanted: () => boolean = () => true): Promise<void> {
  if (!isAbsolute(path) || await realpath(path) !== path || !(await stat(path)).isDirectory()) throw new Error('task workspace unavailable')
  if (!stillWanted()) return
  if (platform === 'darwin') await launch('/usr/bin/open', [path])
  else if (platform === 'win32') await launch('explorer.exe', [path])
  else await launch('xdg-open', [path])
}
