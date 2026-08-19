import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runtimeFixtureJsonSchema } from '../dist/src/fixtures.js'

const target = resolve(import.meta.dirname, '../../fixtures/runtime/v1/schema.json')
await writeFile(target, `${JSON.stringify(runtimeFixtureJsonSchema(), null, 2)}\n`, 'utf8')
