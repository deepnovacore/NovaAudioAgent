import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {test} from 'node:test'
import Ajv from 'ajv'

const fixtures = resolve(import.meta.dirname, '../../../fixtures/codex')

test('01 launch and approval examples validate against the Codex 0.152.0 protocol snapshot', () => {
  // Ajv is already installed by the repository's pinned ESLint toolchain; this is test-only.
  const ajv = new Ajv({allErrors: true, unknownFormats: 'ignore', logger: false})
  const examples = JSON.parse(readFileSync(resolve(fixtures, 'approval-examples-0.152.0.json'), 'utf8')) as {
    name: string; schema: string; value: Record<string, unknown>
  }[]
  for (const example of examples) {
    const schema = JSON.parse(readFileSync(resolve(fixtures, 'app-server-schema/0.152.0', example.schema), 'utf8')) as object
    const validate = ajv.compile(schema)
    assert.equal(validate(example.value), true, `${example.name}: ${ajv.errorsText(validate.errors)}`)
    if (example.schema.includes('Thread')) {
      assert.equal(Object.hasOwn(example.value, 'permissions') && Object.hasOwn(example.value, 'sandbox'), false)
    }
  }
})
