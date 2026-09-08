// Validate a built SDK candidate without changing the runtime lockfile or installed package.
import {mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve, dirname} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidate = process.argv[2]
if (!candidate) throw new Error('Usage: node runtime/scripts/check-memory-sdk.mjs /absolute/path/to/built-sdk')
const root = resolve(candidate)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (!['voicemem', '@deepnovacore/voicemem', '@nova-audio-agent/voicemem-ts'].includes(manifest.name)) {
  throw new Error('Candidate is not a recognized VoiceMem package')
}
const entry = manifest.exports?.['.']
if (!entry?.types || !entry?.default) throw new Error('Candidate must export runtime and TypeScript entrypoints')
const temporary = mkdtempSync(join(tmpdir(), 'nova-sdk-contract-'))
function run(args) {
  const result = spawnSync(process.execPath, args, {cwd: runtime, stdio:'inherit',
    env:{...process.env,NOVA_MEMORY_SDK_ACCEPTANCE:'1'}})
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`SDK compatibility check failed (${result.status ?? result.signal})`)
}
try {
  const config = join(temporary, 'tsconfig.json')
  symlinkSync(join(runtime,'../node_modules'), join(temporary,'node_modules'), 'dir')
  writeFileSync(config, JSON.stringify({extends:join(runtime,'tsconfig.json'), compilerOptions:{
    noEmit:false, outDir:join(temporary,'dist'), declaration:false, declarationMap:false, sourceMap:false,
    tsBuildInfoFile:join(temporary,'.tsbuildinfo'),
    paths:{'voicemem':[resolve(root,entry.types)]},
  }}))
  run([join(runtime,'../node_modules/typescript/bin/tsc'), '-p', config])
  const loader = `export function resolve(specifier, context, next) {
    return specifier === 'voicemem'
      ? {url:${JSON.stringify(pathToFileURL(resolve(root,entry.default)).href)},shortCircuit:true}
      : next(specifier, context)
  }`
  const loaderUrl = `data:text/javascript,${encodeURIComponent(loader)}`
  const preload = `import {register} from 'node:module'; register(${JSON.stringify(loaderUrl)}, import.meta.url)`
  // --import is inherited by the real memory Worker, so admission/recovery use the candidate too.
  run(['--import', `data:text/javascript,${encodeURIComponent(preload)}`, '--test', '--test-timeout=20000',
    join(temporary,'dist/test/voicemem-store-client.test.js')])
  console.log(`VoiceMem SDK compatibility passed: ${manifest.name}@${manifest.version}`)
} finally {
  rmSync(temporary, {recursive:true,force:true})
}
