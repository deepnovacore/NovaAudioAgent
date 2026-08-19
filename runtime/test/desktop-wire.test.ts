/**
 * The Node leg of the desktop wire parity suite.
 *
 * Byte-exactness is the requirement, not a preference: a renderer built against one runtime has to work
 * against the other, and a header differing by a separator, a field order, or an escaping rule is a
 * renderer that silently drops audio. So the golden records hex bytes rather than a parsed view -- a
 * parsed comparison would agree on two frames no renderer would accept interchangeably.
 *
 * Rejections are compared too. What the wire refuses is as much of the contract as what it accepts.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import {
  DesktopProtocolError,
  captionMessage,
  codexProjectMessage,
  codexStateMessage,
  decodeAudioFrame,
  deliveryToEvent,
  encodeAudioFrame,
  playbackAlertMessage,
  playbackClearMessage,
  playbackTerminalMessage,
  validateInputPcm,
} from '../src/desktop-wire.js'
import { parseClientMessage } from '../src/desktop-bridge.js'
import type { PlaybackCompletion } from '../src/playback.js'
import type { CodexState } from '../src/realtime/service-state.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/desktop/wire/v1')

interface Case {
  readonly name: string
  readonly kind: string
  readonly utterance_id?: string
  readonly generation_epoch?: number
  readonly sequence?: number
  readonly pcm?: string
  readonly bytes?: string
  readonly state?: string
  readonly workspace_display_name?: string | null
  readonly session_title?: string | null
  readonly pending_confirmation?: boolean
  readonly role?: string
  readonly text?: string
  readonly final?: boolean
  readonly raw?: string
  readonly token?: string
  readonly authenticated?: boolean
}

const document = JSON.parse(readFileSync(resolve(fixtureRoot, 'cases.json'), 'utf8')) as {
  readonly cases: readonly Case[]
}
const golden = JSON.parse(readFileSync(resolve(fixtureRoot, 'cases-expected.json'), 'utf8')) as {
  readonly cases: readonly Record<string, unknown>[]
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function runCase(spec: Case): Record<string, unknown> {
  try {
    switch (spec.kind) {
      case 'encode_audio':
        return {
          bytes: toHex(encodeAudioFrame({
            utterance_id: spec.utterance_id!,
            generation_epoch: spec.generation_epoch!,
            sequence: spec.sequence!,
            pcm: fromHex(spec.pcm!),
          })),
        }
      case 'decode_audio': {
        const frame = decodeAudioFrame(fromHex(spec.bytes!))
        return {
          utterance_id: frame.utterance_id,
          generation_epoch: frame.generation_epoch,
          sequence: frame.sequence,
          pcm: toHex(frame.pcm),
        }
      }
      case 'roundtrip_audio': {
        const encoded = encodeAudioFrame({
          utterance_id: spec.utterance_id!,
          generation_epoch: spec.generation_epoch!,
          sequence: spec.sequence!,
          pcm: fromHex(spec.pcm!),
        })
        const decoded = decodeAudioFrame(encoded)
        return {
          bytes: toHex(encoded),
          utterance_id: decoded.utterance_id,
          generation_epoch: decoded.generation_epoch,
          sequence: decoded.sequence,
          pcm: toHex(decoded.pcm),
        }
      }
      case 'validate_input_pcm':
        return {bytes: toHex(validateInputPcm(fromHex(spec.pcm!)))}
      case 'playback_clear':
        return {text: playbackClearMessage(spec.utterance_id!, spec.generation_epoch!)}
      case 'playback_alert':
        return {
          text: playbackAlertMessage(
            spec.utterance_id ?? null,
            spec.generation_epoch ?? null,
          ),
        }
      case 'playback_terminal':
        return {text: playbackTerminalMessage(spec.utterance_id!, spec.generation_epoch!)}
      case 'codex_state':
        return {text: codexStateMessage(spec.state as CodexState)}
      case 'codex_project':
        return {
          text: codexProjectMessage({
            workspace_display_name: spec.workspace_display_name ?? null,
            session_title: spec.session_title ?? null,
            pending_confirmation: spec.pending_confirmation!,
          }),
        }
      case 'parse_client': {
        const command = parseClientMessage(spec.raw!, {
          expectedToken: spec.token ?? '0'.repeat(32),
          authenticated: spec.authenticated!,
        })
        return {command: command.kind, payload: {...command.payload}}
      }
      case 'caption':
        return {
          text: captionMessage(
            {
              role: spec.role as 'user' | 'assistant',
              text: spec.text!,
              final: spec.final!,
            },
            // The fixture carries it alongside the frame, as the oracle's signature does.
            (spec as unknown as {readonly sequence: number}).sequence,
          ),
        }
      default:
        throw new Error(`unsupported case kind: ${spec.kind}`)
    }
  } catch (cause) {
    if (cause instanceof DesktopProtocolError) return {error: cause.message}
    return {error: (cause as Error).constructor.name}
  }
}

test('every desktop wire case matches the Python-exported golden, byte for byte', () => {
  const divergent: string[] = []
  for (const [index, spec] of document.cases.entries()) {
    const actual = {name: spec.name, ...runCase(spec)}
    const expected = golden.cases[index]
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      divergent.push(
        `${spec.name}\n    python: ${canonicalJson(expected)}\n    node:   ${canonicalJson(actual)}`,
      )
    }
  }
  assert.deepEqual(divergent, [], 'desktop wire format differs from the oracle')
})

test('the golden records one result per case, in order', () => {
  assert.deepEqual(
    golden.cases.map(entry => entry.name),
    document.cases.map(spec => spec.name),
  )
})

test('the case set covers both what the wire accepts and what it refuses', () => {
  // A set of only valid frames would pass with every bound deleted. Most of this module is refusal.
  const accepted = golden.cases.filter(entry => !('error' in entry)).length
  const refused = golden.cases.filter(entry => 'error' in entry).length
  assert.ok(accepted >= 15, `only ${accepted} accepted cases`)
  assert.ok(refused >= 15, `only ${refused} refusal cases`)
})

test('an audio frame survives PCM that contains the magic bytes', () => {
  // The header carries a length precisely so a reader never has to scan for a delimiter -- PCM can
  // contain any byte sequence, including `NOVA`.
  const pcm = new Uint8Array([0x4e, 0x4f, 0x56, 0x41, 0x00, 0x01])
  const decoded = decodeAudioFrame(encodeAudioFrame({
    utterance_id: 'u-1',
    generation_epoch: 1,
    sequence: 0,
    pcm,
  }))
  assert.deepEqual([...decoded.pcm], [...pcm])
})

test('a decoded frame does not hold the received buffer alive', () => {
  // A subarray would keep the whole read buffer reachable, and a frame outlives the read that produced
  // it -- so the PCM is copied out.
  const encoded = encodeAudioFrame({
    utterance_id: 'u-1',
    generation_epoch: 1,
    sequence: 0,
    pcm: new Uint8Array([0x11, 0x22]),
  })
  const decoded = decodeAudioFrame(encoded)
  assert.equal(decoded.pcm.byteOffset, 0, 'a fresh buffer, not a window into the frame')
  assert.equal(decoded.pcm.buffer.byteLength, 2, 'and no larger than the audio itself')
})

test('a delivery nobody heard produces no Memory event', () => {
  // Suppressed audio never played, and empty text is no words. Recording either would put something in
  // Memory the user did not hear, which later turns would then treat as shared context.
  const completion = (
    text: string,
    disposition: 'spoken' | 'interrupted' | 'suppressed',
    playedMs: number | null,
  ): PlaybackCompletion => ({
    session_epoch: 1,
    response_id: 'r-1',
    utterance_id: 'u-1',
    generation_epoch: 1,
    text,
    disposition,
    started: disposition !== 'suppressed',
    played_ms: playedMs,
  })
  assert.equal(deliveryToEvent(completion('hello', 'suppressed', 0)), null)
  assert.equal(deliveryToEvent(completion('', 'spoken', 120)), null)
  assert.deepEqual(
    deliveryToEvent(completion('hello', 'interrupted', 40)),
    {text: 'hello', utterance_id: 'u-1', delivery: 'interrupted', played_ms: 40},
  )
})

test('a non-integer epoch from a programmatic caller is refused', () => {
  // The wire side of this is covered by the golden's `decode-float-epoch`, where the literal is checked
  // against the header text. This is the other side: a caller inside the process passing a JavaScript
  // float. No shared JSON fixture can express it -- `1.0` in the fixture reaches JavaScript as `1` --
  // so it is stated directly.
  for (const epoch of [1.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => playbackClearMessage('u-1', epoch),
      DesktopProtocolError,
      `epoch ${String(epoch)}`,
    )
    assert.throws(
      () => encodeAudioFrame({
        utterance_id: 'u-1',
        generation_epoch: epoch,
        sequence: 0,
        pcm: new Uint8Array([0, 1]),
      }),
      DesktopProtocolError,
    )
  }
  // And a whole number is accepted, so the check is not simply refusing everything.
  assert.ok(playbackClearMessage('u-1', 2).includes('"generation_epoch":2'))
})

test('a header size below the smallest possible object is refused', () => {
  // Redundant with the JSON parse, which fails on one byte too -- both produce
  // `desktop audio header is invalid`, so a mutation removing the size check is correctly
  // undetectable. Kept because the oracle keeps it, and because it refuses *before* decoding, which a
  // future header format with a cheaper parse would still want.
  for (const declared of [0, 1]) {
    const raw = new Uint8Array([0x4e, 0x4f, 0x56, 0x41, 0x00, declared, 0x7b, 0x00, 0x01])
    assert.throws(() => decodeAudioFrame(raw), /desktop audio header is invalid/u)
  }
})

test('a non-integer sequence from a programmatic caller is refused', () => {
  // A fractional sequence would order frames between two integers, which the renderer's queue cannot
  // represent -- so it is refused rather than rounded.
  assert.throws(
    () => encodeAudioFrame({
      utterance_id: 'u-1',
      generation_epoch: 1,
      sequence: 1.5,
      pcm: new Uint8Array([0, 1]),
    }),
    /desktop audio sequence is invalid/u,
  )
})
