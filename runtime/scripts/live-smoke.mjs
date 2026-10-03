import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises'
import {resolve, dirname, join} from 'node:path'
import {tmpdir} from 'node:os'
import {parseArgs, parseEnv} from 'node:util'
import {createRequire} from 'node:module'
import {spawn, execFileSync} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {configuration, runTextCase} from './live/text-tools.mjs'
import {validateFixtures, validateModuleReport, summary} from './live/validation.mjs'

const root = resolve(import.meta.dirname, '../..')
const catalog = JSON.parse(await readFile(join(import.meta.dirname, 'live/catalog.json'), 'utf8'))
const {values} = parseArgs({options: {
  list: {type:'boolean'}, target: {type:'string', default:'text-tools'}, case: {type:'string'},
  provider: {type:'string'}, model: {type:'string'}, repeat: {type:'string', default:'1'},
  'env-file': {type:'string'}, output: {type:'string'},
}})
if (values.list) {
  for (const suite of catalog.suites) console.log(`${suite.id}\t${suite.layer}\t${suite.retired ? 'RETIRED' : 'active'}\t${suite.scope}`)
} else {
  const repeats = Number(values.repeat)
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeat must be 1..10')
  const selected = values.target.split(',').map(id => {
    const suite = catalog.suites.find(suite => suite.id === id)
    if (!suite) throw new Error(`unknown suite: ${id}`)
    return suite
  })
  if (new Set(selected).size !== selected.length) throw new Error('duplicate suite')
  if (values.case && (selected.length !== 1 || selected[0].id !== 'text-tools')) throw new Error('--case requires text-tools only')
  if ((values.provider || values.model) && selected.some(suite => suite.id !== 'text-tools')) throw new Error('--provider/--model apply only to text-tools; configure other suites through environment')
  const environment = {...(values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {}), ...process.env}
  const usesText=selected.some(suite=>suite.id==='text-tools')
  const fixtureText = usesText ? await readFile(join(root, 'tests/fixtures/live/text-tools.json'), 'utf8') : ''
  const cases = usesText ? validateFixtures(JSON.parse(fixtureText)).cases.filter(entry => !values.case || entry.id === values.case) : []
  if (usesText && !cases.length) throw new Error('unknown or empty case selection')
  const output = resolve(values.output ?? join(tmpdir(), `nova-live-${randomUUID()}.json`))
  const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim()
  const harnessHash = createHash('sha256')
  for (const file of ['../live-smoke.mjs','text-tools.mjs','validation.mjs','catalog.json']) harnessHash.update(await readFile(join(import.meta.dirname,'live',file)))
  if (selected.some(suite => suite.id === 'project')) for (const file of ['runtime/scripts/live/project.mjs','runtime/scripts/live/project-result.mjs','runtime/scripts/live/workspace-scenarios.mjs','clients/desktop/scripts/live-project-host.cjs']) harnessHash.update(await readFile(join(root,file)))
  for (const suite of selected.filter(suite=>suite.structuredReport)) harnessHash.update(await readFile(resolve(root,'runtime',suite.entry)))
  let runtimeHash
  if(selected.some(suite=>suite.structuredReport)){
    const hash=createHash('sha256'),directory=join(root,'runtime/dist/src')
    for(const file of (await readdir(directory,{recursive:true})).filter(file=>file.endsWith('.js')).sort()){hash.update(file);hash.update(await readFile(join(directory,file)))}
    runtimeHash=hash.digest('hex')
  }
  const report = {version:1,...(runtimeHash?{runtimeHash}:{}), harnessHash:harnessHash.digest('hex'), startedAt:new Date().toISOString(), revision:git('rev-parse','HEAD'),
    dirty:git('status','--porcelain').length > 0, node:process.version, platform:process.platform,
    selection:selected.map(suite => suite.id), repeats, fixtures:selected.some(suite => suite.id === 'text-tools') ? cases : [], fixtureHash:createHash('sha256').update(fixtureText).digest('hex'),
    scope:'Only selected suites/cases are accepted. Model-routing never executes tools. Legacy subprocess suites report process-level results.', results:[]}
  const persist = async () => {
    report.summary = summary(report.results)
    report.summary.accepted &&= report.finishedAt !== undefined
    report.caseSummary = [...new Set(report.results.map(result => `${result.suite}/${result.case}`))].map(id => ({
      id, ...summary(report.results.filter(result => `${result.suite}/${result.case}` === id)),
    }))
    await mkdir(dirname(output), {recursive:true})
    await writeFile(output, JSON.stringify(report,null,2)+'\n', {mode:0o600})
  }
  await persist()
  for (const suite of selected) {
    let config, configurationError
    if (suite.id === 'text-tools') {
      try { config = configuration(environment, values.provider, values.model) }
      catch { configurationError = 'invalid_provider_configuration' }
    }
    const missing = suite.requires.filter(group => !group.some(key => environment[key]?.trim())).map(group => group.join('|'))
    const blocked = suite.retired ? 'retired_suite' : configurationError
      ?? (suite.id === 'text-tools' && !config?.apiKey ? 'missing_selected_llm_key' : missing.length ? `missing:${missing.join(',')}` : null)
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const entry of suite.id === 'text-tools' ? cases : [{id:suite.id}]) {
        const start = Date.now()
        const artifact=suite.structuredReport?`${output}.${suite.id}-${repeat}.json`:suite.id==='project'?`${output}.project-${repeat}.json`:undefined
        let result
        if (blocked) result = {status:'blocked', reason:blocked}
        else {
          try {
            result = suite.id === 'text-tools'
              ? await runTextCase(entry, config, suite.timeoutMs)
              : await runProcess(suite, suite.id === 'project' ? {...environment, NOVA_LIVE_PROJECT_REPORT: artifact} : suite.structuredReport ? {...environment,NOVA_LIVE_MODULE_REPORT:artifact} : environment,artifact)
          } catch (error) {
            // Never persist transport messages, URLs, headers, env values, or child stdout.
            const code = ['network','http','timeout','aborted','configuration','protocol','overflow','closed'].includes(error.code) ? error.code : 'runner_error'
            result = {status: ['protocol','overflow'].includes(code) ? 'failed' : 'error', reason:code}
          }
        }
        report.results.push({...(artifact && !blocked ? {artifact} : {}),suite:suite.id, layer:suite.layer, case:entry.id, repeat,
          ...(config ? {provider:config.provider, model:config.model} : {}), ...result, elapsedMs:Date.now()-start})
        console.log(`${suite.id}/${entry.id} #${repeat}: ${result.status}${result.failures?.length ? ` (${result.failures.join(', ')})` : ''}`)
        await persist()
      }
    }
  }
  report.finishedAt = new Date().toISOString()
  await persist()
  console.log(`Report: ${output}\n${JSON.stringify(report.summary)}`)
  process.exitCode = report.summary.failed ? 1 : report.summary.error || report.summary.blocked ? 2 : 0
}

async function runProcess(suite, environment, artifact) {
  const started=Date.now()
  const result = await new Promise(resolveResult => {
    const project = suite.id === 'project'
    const electron=project||suite.electron===true
    const executable = electron ? createRequire(join(root,'clients/desktop/package.json'))('electron') : process.execPath
    const argv = project ? [join(root,'clients/desktop/scripts/live-project-host.cjs')] : [...(suite.id === 'coordinator' ? ['--test'] : []), suite.entry,...(suite.args??[])]
    const childEnvironment={...environment,NOVA_LIVE_TESTS:'1'}
    if(electron)delete childEnvironment.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, argv,
      {cwd:join(root,'runtime'), env:childEnvironment, stdio:['ignore','pipe','pipe']})
    let bytes = 0, timedOut = false, overflow = false, killTimer
    const terminate = () => {
      if (!electron) { child.kill('SIGKILL'); return }
      if (killTimer) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10000)
    }
    const count = data => { bytes += data.length; if (bytes > 2_000_000) { overflow = true; terminate() } }
    child.stdout.on('data',count); child.stderr.on('data',count)
    const timer = setTimeout(() => { timedOut = true; terminate() }, suite.timeoutMs)
    child.on('error', () => { clearTimeout(timer); clearTimeout(killTimer); resolveResult({status:'error', reason:'spawn_failed'}) })
    child.on('close', code => { clearTimeout(timer); clearTimeout(killTimer); resolveResult({status:timedOut || overflow ? 'error' : code === 0 ? 'passed' : 'failed',
      exitCode:code, ...(timedOut ? {reason:'timeout'} : overflow ? {reason:'output_limit'} : {})}) })
  })
  if(!suite.structuredReport||result.status==='error')return result
  try {
    const bytes=await readFile(artifact,'utf8')
    if(bytes.length>8_000_000)throw Error('report_limit')
    const evidence=validateModuleReport(JSON.parse(bytes),suite.id,started)
    if(evidence.status==='passed'&&result.exitCode!==0)return {...result,reason:'module_exit_mismatch'}
    return {...result,status:evidence.status,checks:evidence.checks,coverage:evidence.coverage,...(evidence.status==='blocked'?{reason:'module_precondition'}:{})}
  } catch { return {...result,status:'failed',reason:'missing_or_invalid_module_report'} }
}
