import {readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {publicEnvironmentContract} from '../dist/src/environment-contract.js'

const mode = process.argv[2]
if (mode !== '--check' && mode !== '--write') {
  process.stderr.write('Usage: node runtime/scripts/check-env-contract.mjs --check|--write\n')
  process.exitCode = 2
} else {
  const runtimeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const repositoryRoot = resolve(runtimeRoot, '..')
  const targets = [
    {
      path: resolve(repositoryRoot, '.env.example'),
      start: '# BEGIN GENERATED ENV CONTRACT',
      end: '# END GENERATED ENV CONTRACT',
      render: renderEnv,
    },
    {
      path: resolve(repositoryRoot, 'docs/getting-started.md'),
      start: '<!-- BEGIN GENERATED ENV CONTRACT -->',
      end: '<!-- END GENERATED ENV CONTRACT -->',
      render: () => renderMarkdown('en'),
    },
    {
      path: resolve(repositoryRoot, 'docs/getting-started.zh-CN.md'),
      start: '<!-- BEGIN GENERATED ENV CONTRACT -->',
      end: '<!-- END GENERATED ENV CONTRACT -->',
      render: () => renderMarkdown('zh'),
    },
  ]
  let drift = false
  for (const target of targets) {
    const current = await readFile(target.path, 'utf8')
    const generated = `${target.start}\n${target.render()}\n${target.end}`
    const next = replaceBlock(current, target.start, target.end, generated)
    if (next === current) continue
    drift = true
    if (mode === '--write') await writeFile(target.path, next)
    else process.stderr.write(`environment contract drift: ${target.path}\n`)
  }
  if (mode === '--write') process.stdout.write('wrote generated environment contract blocks\n')
  else if (drift) process.exitCode = 1
  else process.stdout.write('generated environment contract blocks match\n')
}

function replaceBlock(current, start, end, generated) {
  const startIndex = current.indexOf(start)
  const endIndex = current.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) {
    const separator = current.endsWith('\n') ? '\n' : '\n\n'
    return `${current}${separator}${generated}\n`
  }
  const tail = endIndex + end.length
  return `${current.slice(0, startIndex)}${generated}${current.slice(tail)}`
}

function renderEnv() {
  return publicEnvironmentContract().map(entry => {
    const value = entry.secret ? '' : (entry.defaultLabel ?? '')
    return `# ${entry.name}=${value}`
  }).join('\n')
}

function renderMarkdown(language) {
  const heading = language === 'en'
    ? '| Variable | Owner | Required | Default | Description |\n|---|---|---|---|---|'
    : '| 变量 | 所属 | 必需条件 | 默认 | 说明 |\n|---|---|---|---|---|'
  const rows = publicEnvironmentContract().map(entry => {
    const required = language === 'en'
      ? (entry.required === 'never' ? 'No' : 'When selected')
      : (entry.required === 'never' ? '否' : '选择该能力时')
    const fallback = language === 'en' ? 'None' : '无'
    const description = language === 'en' ? entry.descriptionEn : entry.descriptionZh
    return `| \`${entry.name}\` | \`${entry.owner}\` | ${required} | ${escapeCell(entry.defaultLabel ?? fallback)} | ${escapeCell(description)} |`
  })
  return [heading, ...rows].join('\n')
}

function escapeCell(value) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
