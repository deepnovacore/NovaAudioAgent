import {createMem0PersonalMemory} from '../mem0/resource.js'
import {homedir} from 'node:os'
import {resolve} from 'node:path'
import {requirePersonalMemory, type Settings} from '../config/config.js'
import {PersonalMemoryStoreClient} from '../voicemem/store-client.js'
import {RemotePersonalMemoryResource} from './remote-personal-memory.js'
import type {PersonalMemoryResource} from './personal-memory.js'

export function personalMemoryFactory(
  settings: Settings,
): (() => PersonalMemoryResource) | undefined {
  const configured = requirePersonalMemory(settings)
  if (configured === null) return undefined
  if (configured.connection === 'remote') return () => new RemotePersonalMemoryResource(configured)
  const path = resolve(configured.path.startsWith('~/')
    ? resolve(homedir(), configured.path.slice(2))
    : configured.path)
  if (configured.provider === 'mem0') return () => createMem0PersonalMemory({...configured, path})
  return Object.assign(() => new PersonalMemoryStoreClient({...configured, path}), {localMemoryConfig: {...configured, path}})
}
