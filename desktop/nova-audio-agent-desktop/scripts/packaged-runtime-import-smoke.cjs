'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const {realpathSync} = require('node:fs')
const {createRequire, syncBuiltinESMExports} = require('node:module')
const {isAbsolute, resolve, sep} = require('node:path')
const {pathToFileURL} = require('node:url')

const resourcesRoot = process.argv[2]
assert.ok(typeof resourcesRoot === 'string' && isAbsolute(resourcesRoot), 'packaged_import_root_invalid')
assert.equal(realpathSync(resourcesRoot), resourcesRoot, 'packaged_import_root_invalid')
assert.equal(process.resourcesPath, resourcesRoot, 'packaged_import_root_invalid')

const forbiddenSpawn = () => { throw new Error('packaged_import_child_forbidden') }
for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync']) {
  childProcess[name] = forbiddenSpawn
}
syncBuiltinESMExports()
process.env.PATH = 'NOVA_PACKAGED_IMPORT_FORBIDS_PATH_LOOKUP'
delete process.env.FFMPEG_PATH
delete process.env.FFPROBE_PATH
const keepalive = setInterval(() => {}, 1_000)

void (async () => {
  const requireFromPackage = createRequire(resolve(resourcesRoot, 'app.asar', 'package.json'))
  const agentsEntry = requireFromPackage.resolve('@livekit/agents')
  const expectedAgentsRoot = `${sep}app.asar${sep}node_modules${sep}@livekit${sep}agents${sep}`
  assert.ok(agentsEntry.includes(expectedAgentsRoot), 'packaged_import_agents_root_invalid')
  const agents = await import(pathToFileURL(agentsEntry).href)
  assert.equal(agents.version, '1.6.4', 'packaged_import_agents_version_invalid')

  const capabilityPath = resolve(
    resourcesRoot,
    'app.asar',
    'node_modules',
    '@nova-audio-agent',
    'runtime',
    'dist',
    'src',
    'realtime',
    'volcengine',
    'endpointing-capability.js',
  )
  const capability = await import(pathToFileURL(capabilityPath).href)
  const runtime = {platform: process.platform, arch: process.arch}
  if (process.platform === 'linux') runtime.glibcVersionRuntime = 'platform-ci'
  const result = await capability.probeEndpointingCapability({
    signal: new AbortController().signal,
    agentsLoader: async () => agents,
    runtime,
    cache: capability.createEndpointingCapabilityCache(),
  })
  assert.deepEqual(result.vad, {available: true, reason: 'ready'}, 'packaged_import_vad_invalid')
  assert.deepEqual(
    result.eot,
    {available: false, reason: 'executor_unavailable'},
    'packaged_import_eot_invalid',
  )
  assert.equal(process.env.PATH, 'NOVA_PACKAGED_IMPORT_FORBIDS_PATH_LOOKUP')
  process.stdout.write('packaged runtime import passed\n')
})().catch(() => {
  process.stderr.write('packaged runtime import rejected\n')
  process.exitCode = 1
}).finally(() => {
  clearInterval(keepalive)
})
