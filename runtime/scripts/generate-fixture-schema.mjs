import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runtimeFixtureJsonSchema } from '../dist/src/fixtures.js'
import { workspaceGraphFixtureJsonSchema } from '../dist/src/workspace-graph/models.js'

const targets = [
  [resolve(import.meta.dirname, '../../fixtures/runtime/v1/schema.json'), runtimeFixtureJsonSchema()],
  [resolve(import.meta.dirname, '../../fixtures/workspace-graph/schema.json'), workspaceGraphFixtureJsonSchema()],
]

for (const [target, schema] of targets) {
  await writeFile(target, `${JSON.stringify(schema, null, 2)}\n`, 'utf8')
}
