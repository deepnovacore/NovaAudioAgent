import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runtimeFixtureJsonSchema } from '../dist/eval/fixtures.js'

const targets = [
  [resolve(import.meta.dirname, '../../tests/fixtures/runtime/v1/schema.json'), runtimeFixtureJsonSchema()],
]

for (const [target, schema] of targets) {
  await writeFile(target, `${JSON.stringify(schema, null, 2)}\n`, 'utf8')
}
