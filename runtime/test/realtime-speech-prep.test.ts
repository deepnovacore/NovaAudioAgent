import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareForSpeech, SPEECH_FINAL_LIMIT } from '../src/realtime/speech-prep.js'

test('speech preparation strips code, links, digests, and markdown structure', () => {
  const digest = 'af8a7d2c440a3463f6df0188beae281fae9685d70fe1d2d9f1460186b480ff52'
  const prepared = prepareForSpeech(
    '## 结果\n**完成** [文件](/private/path) https://example.com/docs ' +
      `\`${'R'}\` ${digest} \n\`\`\`bash\nnpm install\n\`\`\``,
    {limit: SPEECH_FINAL_LIMIT},
  )
  assert.equal(prepared.truncated, false)
  for (const secret of ['##', '**', '/private/path', 'example.com', digest, 'npm install', '`']) {
    assert.doesNotMatch(prepared.text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
  assert.match(prepared.text, /文件/u)
  assert.match(prepared.text, /R/u)
  assert.match(prepared.text, /（链接略）/u)
  assert.match(prepared.text, /（代码示例略）/u)
})

test('speech preparation preserves prose after bare URLs and unclosed fences', () => {
  const url = prepareForSpeech('详见 https://example.com/docs。然后继续下一步。', {limit: 600})
  assert.match(url.text, /然后继续下一步/u)
  assert.doesNotMatch(url.text, /example\.com/u)

  const fence = prepareForSpeech(
    'Implemented core. ```python print(1) Tests passed and docs updated.',
    {limit: 600},
  )
  assert.match(fence.text, /Implemented core/u)
  assert.match(fence.text, /Tests passed and docs updated/u)
  assert.doesNotMatch(fence.text, /```/u)
})

test('speech preparation clips by Unicode code point without splitting an emoji', () => {
  const prepared = prepareForSpeech('😀'.repeat(601), {limit: SPEECH_FINAL_LIMIT})
  assert.equal(prepared.truncated, true)
  assert.equal([...prepared.text].length, SPEECH_FINAL_LIMIT)
  assert.ok(!prepared.text.endsWith('\uD83D'))
})
