import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sessionFixtureJsonSchema } from '../dist/src/realtime/session-fixtures.js'

const target = resolve(import.meta.dirname, '../../fixtures/realtime/session/v1/schema.json')
await writeFile(target, `${JSON.stringify(sessionFixtureJsonSchema(), null, 2)}\n`, 'utf8')
