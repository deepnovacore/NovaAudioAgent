/**
 * The desktop wire format: audio frames, control messages, and the delivery report.
 *
 * Ported from the codec half of `src/nova_audio_agent/realtime/desktop.py`. Everything here is
 * byte-exact by requirement rather than by preference -- a renderer built against one runtime has to
 * work against the other, and a header that differs by a separator or a field order is a renderer that
 * silently drops audio.
 *
 * Two encodings, and the difference is deliberate. Audio headers and playback control use
 * `ensure_ascii=True`, because they carry only identifiers and integers and an ASCII-only frame is one
 * fewer thing to get wrong in a transport. Captions and the project view use `ensure_ascii=False`,
 * because they carry text a person reads and escaping every CJK character would triple the frame for
 * nothing.
 */

import type { PlaybackCompletion, PlaybackFrame } from './playback.js'
import {codePointLengthLikePython, stripLikePython} from './python-text.js'
import type { CaptionFrame } from './realtime/session-state.js'
import type { CodexState } from './realtime/service-state.js'
import {PROJECT_CONFIRMATION_TTL_SECONDS} from './realtime/project-confirmation.js'

export const MAX_DESKTOP_JSON_BYTES = 16 * 1_024
export const MAX_DESKTOP_PCM_BYTES = 64 * 1_024
/** Bounded so a malformed length prefix cannot make a reader allocate arbitrarily. */
export const MAX_AUDIO_HEADER_BYTES = 2_048
/** `NOVA`, so a frame that is not one is rejected before its length is trusted. */
const AUDIO_MAGIC = new Uint8Array([0x4e, 0x4f, 0x56, 0x41])

export class DesktopProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopProtocolError'
  }
}

/** What the renderer shows for the current Codex project, with nothing internal in it. */
export interface PublicProjectView {
  readonly workspace_display_name: string | null
  readonly session_title: string | null
  readonly pending_confirmation: boolean
  readonly pending_action?:
    | 'create_workspace'
    | 'reuse_workspace'
    | 'select_workspace'
    | 'resume_session'
    | null
  readonly pending_workspace_display_name?: string | null
  readonly pending_session_title?: string | null
  readonly pending_expires_in_seconds?: number | null
}

/**
 * Frame one PCM chunk for the renderer.
 *
 * Magic, then a two-byte big-endian header length, then an ASCII JSON header, then the raw PCM. The
 * length prefix is what lets a reader find the audio without scanning it -- and scanning would be
 * wrong anyway, since PCM can contain any byte sequence including the magic.
 */
export function encodeAudioFrame(frame: PlaybackFrame): Uint8Array {
  validatePlaybackFrame(frame)
  if (frame.pcm.length > MAX_DESKTOP_PCM_BYTES) {
    throw new DesktopProtocolError('desktop PCM frame is too large')
  }
  const header = asciiJson({
    utterance_id: frame.utterance_id,
    generation_epoch: frame.generation_epoch,
    sequence: frame.sequence,
  })
  const headerBytes = new TextEncoder().encode(header)
  if (headerBytes.length > MAX_AUDIO_HEADER_BYTES) {
    throw new DesktopProtocolError('desktop audio header is too large')
  }
  const out = new Uint8Array(AUDIO_MAGIC.length + 2 + headerBytes.length + frame.pcm.length)
  out.set(AUDIO_MAGIC, 0)
  out[AUDIO_MAGIC.length] = (headerBytes.length >> 8) & 0xff
  out[AUDIO_MAGIC.length + 1] = headerBytes.length & 0xff
  out.set(headerBytes, AUDIO_MAGIC.length + 2)
  out.set(frame.pcm, AUDIO_MAGIC.length + 2 + headerBytes.length)
  return out
}

/**
 * Read one framed PCM chunk.
 *
 * Every bound is checked before the byte range it guards is used: the magic before the length, the
 * length before the split, the split before the slice. A reader that trusted the prefix first would
 * hand an attacker the shape of its own memory.
 */
export function decodeAudioFrame(raw: Uint8Array): PlaybackFrame {
  if (raw.length < AUDIO_MAGIC.length + 2) {
    throw new DesktopProtocolError('desktop audio frame is invalid')
  }
  for (const [index, byte] of AUDIO_MAGIC.entries()) {
    if (raw[index] !== byte) throw new DesktopProtocolError('desktop audio frame has invalid magic')
  }
  const headerSize = ((raw[4] ?? 0) << 8) | (raw[5] ?? 0)
  // At least two, because the smallest possible JSON object is `{}`.
  if (headerSize < 2 || headerSize > MAX_AUDIO_HEADER_BYTES) {
    throw new DesktopProtocolError('desktop audio header is invalid')
  }
  const split = 6 + headerSize
  if (split > raw.length) throw new DesktopProtocolError('desktop audio frame is truncated')
  let header: unknown
  let headerText: string
  try {
    headerText = new TextDecoder('utf-8', {fatal: true}).decode(raw.subarray(6, split))
  } catch {
    throw new DesktopProtocolError('desktop audio header is invalid')
  }
  try {
    header = parseJsonWithIntegerFields(
      headerText,
      ['generation_epoch', 'sequence'],
      field => new DesktopProtocolError(`desktop ${field} is invalid`),
    )
  } catch (cause) {
    // A refusal from the integer check is specific and kept; a parse failure is not.
    if (cause instanceof DesktopProtocolError) throw cause
    throw new DesktopProtocolError('desktop audio header is invalid')
  }
  // Copied, not referenced: a subarray keeps the whole received buffer alive, and this frame outlives
  // the read that produced it.
  const pcm = new Uint8Array(raw.subarray(split))
  const frame: PlaybackFrame = {
    utterance_id: readIdentifier(header, 'utterance_id'),
    generation_epoch: readPositiveInteger(header, 'generation_epoch'),
    sequence: readNonNegativeInteger(header, 'sequence'),
    pcm,
  }
  validatePlaybackFrame(frame)
  if (pcm.length > MAX_DESKTOP_PCM_BYTES) {
    throw new DesktopProtocolError('desktop PCM frame is too large')
  }
  return frame
}

/**
 * Accept microphone PCM, or refuse it.
 *
 * Odd length means the renderer is not sending PCM16, and a half sample would shift every sample after
 * it -- so this refuses rather than truncating, because truncating would produce audio that sounds
 * plausible and is wrong.
 */
export function validateInputPcm(raw: Uint8Array): Uint8Array {
  if (raw.length === 0 || raw.length % 2 !== 0) {
    throw new DesktopProtocolError('desktop input must be aligned PCM16 bytes')
  }
  if (raw.length > MAX_DESKTOP_PCM_BYTES) {
    throw new DesktopProtocolError('desktop input PCM frame is too large')
  }
  return raw
}

export function playbackClearMessage(utteranceId: string, generationEpoch: number): string {
  return asciiJson({
    type: 'playback.clear',
    utterance_id: plainIdentifier(utteranceId),
    generation_epoch: plainPositiveInteger(generationEpoch),
  })
}

/**
 * Tell the renderer playback stalled.
 *
 * The identity is all-or-nothing: a half-identified alert names a generation without an utterance or
 * the reverse, and the renderer cannot act on either. An alert with no identity at all is the
 * legitimate "something is wrong and I cannot say which turn" case.
 */
export function playbackAlertMessage(
  utteranceId: string | null,
  generationEpoch: number | null,
): string {
  if ((utteranceId === null) !== (generationEpoch === null)) {
    throw new DesktopProtocolError('desktop alert identity must be complete')
  }
  if (utteranceId === null || generationEpoch === null) {
    return asciiJson({type: 'playback.alert'})
  }
  return asciiJson({
    type: 'playback.alert',
    utterance_id: plainIdentifier(utteranceId),
    generation_epoch: plainPositiveInteger(generationEpoch),
  })
}

export function playbackTerminalMessage(utteranceId: string, generationEpoch: number): string {
  return asciiJson({
    type: 'playback.terminal',
    utterance_id: plainIdentifier(utteranceId),
    generation_epoch: plainPositiveInteger(generationEpoch),
  })
}

export function codexStateMessage(state: CodexState): string {
  if (state !== 'idle' && state !== 'running') {
    throw new DesktopProtocolError('desktop Codex state is invalid')
  }
  return asciiJson({type: 'codex.state', state})
}

/**
 * The project view the renderer displays.
 *
 * Non-ASCII is left literal here: these are names a person reads, and escaping every CJK character
 * would triple the frame to no benefit.
 */
export function codexProjectMessage(view: PublicProjectView): string {
  const pendingAction = view.pending_action ?? null
  const pendingWorkspace = view.pending_workspace_display_name ?? null
  const pendingSession = view.pending_session_title ?? null
  const pendingExpires = view.pending_expires_in_seconds ?? null
  for (const value of [
    view.workspace_display_name,
    view.session_title,
    pendingWorkspace,
    pendingSession,
  ]) {
    if (value === null) continue
    if (typeof value !== 'string' || value === '' || codePointLengthLikePython(value) > 120) {
      throw new DesktopProtocolError('desktop Codex project view is invalid')
    }
  }
  if (typeof view.pending_confirmation !== 'boolean') {
    throw new DesktopProtocolError('desktop Codex project view is invalid')
  }
  if (
    pendingAction !== null
    && pendingAction !== 'create_workspace'
    && pendingAction !== 'reuse_workspace'
    && pendingAction !== 'select_workspace'
    && pendingAction !== 'resume_session'
  ) {
    throw new DesktopProtocolError('desktop Codex project view is invalid')
  }
  if (
    pendingExpires !== null
    && (
      typeof pendingExpires !== 'number'
      || !Number.isFinite(pendingExpires)
      || pendingExpires < 0
      || pendingExpires > PROJECT_CONFIRMATION_TTL_SECONDS
    )
  ) {
    throw new DesktopProtocolError('desktop Codex project view is invalid')
  }
  const hasPendingMetadata = pendingAction !== null
    || pendingWorkspace !== null
    || pendingSession !== null
    || pendingExpires !== null
  if (!view.pending_confirmation && hasPendingMetadata) {
    throw new DesktopProtocolError('desktop Codex project view is invalid')
  }
  if (
    view.pending_confirmation
    && hasPendingMetadata
    && (pendingAction === null || pendingWorkspace === null || pendingExpires === null)
  ) {
    throw new DesktopProtocolError('desktop Codex project view is invalid')
  }
  if (pendingAction === 'resume_session' && pendingSession === null) {
    throw new DesktopProtocolError('desktop Codex project view is invalid')
  }
  return unicodeJson({
    type: 'codex.project',
    workspace_display_name: view.workspace_display_name,
    session_title: view.session_title,
    pending_confirmation: view.pending_confirmation,
    pending_action: pendingAction,
    pending_workspace_display_name: pendingWorkspace,
    pending_session_title: pendingSession,
    pending_expires_in_seconds: pendingExpires,
  })
}

/** Speculative or final transcript text. The sequence lets the renderer drop what arrives late. */
export function captionMessage(frame: CaptionFrame, sequence: number): string {
  return unicodeJson({
    type: 'caption',
    role: frame.role,
    text: frame.text,
    final: frame.final,
    sequence,
  })
}

/**
 * Map a delivery report to the Memory event; words nobody heard yield null.
 *
 * Suppressed means the audio never played, and empty text means there were no words -- either way
 * recording it would put something in Memory the user did not hear, which later turns would then treat
 * as shared context.
 */
export function deliveryToEvent(completion: PlaybackCompletion): {
  readonly text: string
  readonly utterance_id: string
  readonly delivery: 'spoken' | 'interrupted'
  readonly played_ms: number | null
} | null {
  if (completion.disposition === 'suppressed' || completion.text === '') return null
  return {
    text: completion.text,
    utterance_id: completion.utterance_id,
    delivery: completion.disposition,
    played_ms: completion.played_ms,
  }
}

/**
 * Parse JSON, refusing any named field that is not written as an exactly-representable integer.
 *
 * Two problems the text cannot be trusted with, and one mechanism for both.
 *
 * **Spelling.** `json.loads` makes `1.0` a float and the oracle's `type(value) is not int` refuses it,
 * while `JSON.parse` cannot tell `1.0` from `1`. The reviver's `context.source` carries the original
 * literal, so the distinction survives the parse.
 *
 * **Range.** Python integers are unbounded; a JavaScript number is not. `9007199254740993` parses to
 * `9007199254740992` here, and `Number.isInteger` is perfectly happy with the result -- so a renderer
 * could have a generation fenced that is not the one it sent. Comparing the source against the parsed
 * value catches exactly the cases where something was lost.
 *
 * This replaced a regex over the raw text, which was bypassable two ways: an escaped key spelling
 * (`generation_\u0065poch`) decodes to the field name but does not match the pattern, and a duplicated
 * key resolves to its *last* value in both parsers while a pattern finds the first. The reviver sees
 * decoded keys and fires once per member with the surviving value, so neither applies.
 *
 * Refusing an out-of-range integer is a deliberate divergence: the oracle accepts it. Refusing is
 * strictly safer than acting on a different number than the renderer sent.
 */
export function parseJsonWithIntegerFields(
  text: string,
  fields: readonly string[],
  onInvalid: (field: string) => Error,
): unknown {
  const named = new Set(fields)
  // Collected rather than judged in place: the reviver runs bottom-up, so the root object's identity is
  // not known until the very end. A nested `{"meta":{"generation_epoch":1.5}}` is forward-compatible
  // renderer metadata that the oracle parses and ignores -- it reads only `value.get(field)` on the
  // root -- so rejecting it here would discard valid acknowledgements and strand playback state.
  const candidates: {readonly holder: object; readonly field: string; readonly source: string}[] = []
  const parsed: unknown = JSON.parse(text, function reviver(
    this: unknown,
    key: string,
    value: unknown,
    context?: {readonly source?: string},
  ): unknown {
    if (
      named.has(key)
      && context?.source !== undefined
      && typeof this === 'object'
      && this !== null
    ) {
      candidates.push({holder: this, field: key, source: context.source})
    }
    return value
  })
  if (typeof parsed !== 'object' || parsed === null) return parsed
  for (const candidate of candidates) {
    // Only the root's own members. Identity works because this reviver returns every value unchanged,
    // so the object the top-level members were revived into is the object that comes back.
    if (candidate.holder !== parsed) continue
    // `null` is a legal value wherever a field is optional; it is not a number at all.
    if (candidate.source === 'null') continue
    if (!/^-?\d+$/u.test(candidate.source) || String((parsed as Record<string, unknown>)[candidate.field]) !== candidate.source) {
      throw onInvalid(candidate.field)
    }
  }
  return parsed
}

function validatePlaybackFrame(frame: PlaybackFrame): void {
  plainIdentifier(frame.utterance_id)
  plainPositiveInteger(frame.generation_epoch)
  if (!Number.isInteger(frame.sequence) || frame.sequence < 0) {
    throw new DesktopProtocolError('desktop audio sequence is invalid')
  }
  if (frame.pcm.length === 0 || frame.pcm.length % 2 !== 0) {
    throw new DesktopProtocolError('desktop audio must be aligned PCM16 bytes')
  }
}

function readIdentifier(payload: unknown, field: string): string {
  if (!isPlainObject(payload)) throw new DesktopProtocolError('desktop frame payload is invalid')
  try {
    return plainIdentifier(payload[field])
  } catch {
    throw new DesktopProtocolError(`desktop ${field} is invalid`)
  }
}

function readPositiveInteger(payload: unknown, field: string): number {
  if (!isPlainObject(payload)) throw new DesktopProtocolError('desktop frame payload is invalid')
  try {
    return plainPositiveInteger(payload[field])
  } catch {
    throw new DesktopProtocolError(`desktop ${field} is invalid`)
  }
}

function readNonNegativeInteger(payload: unknown, field: string): number {
  if (!isPlainObject(payload)) throw new DesktopProtocolError('desktop frame payload is invalid')
  const candidate = payload[field]
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
    throw new DesktopProtocolError(`desktop ${field} is invalid`)
  }
  return candidate
}

/**
 * An identifier the renderer can use.
 *
 * Whitespace-only is refused but whitespace-containing is not, and the value is returned untrimmed:
 * the oracle checks `value.strip()` and returns `value`, so trimming here would produce an identifier
 * that no longer matches the one the session holds.
 */
function plainIdentifier(value: unknown): string {
  if (
    typeof value !== 'string'
    || stripLikePython(value) === ''
    || codePointLengthLikePython(value) > 256
  ) {
    throw new DesktopProtocolError('desktop identity is invalid')
  }
  return value
}

function plainPositiveInteger(value: unknown): number {
  // Integer *and* at least one: a generation epoch counts from one, and a float here would render as
  // `1.5` in a field the renderer reads as an epoch.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new DesktopProtocolError('desktop generation is invalid')
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Compact JSON with every non-ASCII character escaped, matching `ensure_ascii=True`.
 *
 * Field order is insertion order, as the oracle's dict is -- *not* sorted. These frames are compared
 * byte for byte against the Python ones, so the order is part of the format.
 */
function asciiJson(value: Record<string, unknown>): string {
  return escapeNonAscii(compactJson(value))
}

/** Compact JSON leaving non-ASCII literal, matching `ensure_ascii=False`. */
function unicodeJson(value: Record<string, unknown>): string {
  return compactJson(value)
}

function compactJson(value: Record<string, unknown>): string {
  // `JSON.stringify` already emits `{"a":1,"b":2}` with no spaces, which is Python's
  // `separators=(",", ":")`.
  return JSON.stringify(value)
}

/**
 * Escape every non-ASCII code point as `\uXXXX`, the way Python's `ensure_ascii=True` does.
 *
 * Astral characters become a surrogate pair of escapes, which is also what Python emits -- it escapes
 * the UTF-16 encoding rather than the code point.
 */
function escapeNonAscii(text: string): string {
  let out = ''
  for (const unit of text) {
    const code = unit.codePointAt(0) ?? 0
    if (code < 0x80) {
      out += unit
      continue
    }
    if (code > 0xff_ff) {
      // Re-derive the surrogate pair, because that is what Python escapes.
      const offset = code - 0x1_00_00
      const high = 0xd8_00 + (offset >> 10)
      const low = 0xdc_00 + (offset & 0x3ff)
      out += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`
      continue
    }
    out += `\\u${code.toString(16).padStart(4, '0')}`
  }
  return out
}
