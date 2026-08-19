import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROGRESS_SUMMARY_LIMIT } from '../src/events.js'
import {
  EpochLedger,
  MAX_CAPTION_CHARS,
  MAX_TRACKED_PROVIDER_TURNS,
  MAX_TRACKED_USER_TRANSCRIPTS,
  RealtimeSessionState,
  truncateCaption,
} from '../src/realtime/session-state.js'

test('a ledger counts once and evicts oldest-first at its bound', () => {
  const ledger = new EpochLedger(3)
  assert.equal(ledger.add(1, 'a'), true)
  assert.equal(ledger.add(1, 'a'), false, 'a repeat must not count twice')
  ledger.add(1, 'b')
  ledger.add(1, 'c')
  assert.equal(ledger.size, 3)

  // The fourth entry evicts the first, so the bound really holds.
  ledger.add(1, 'd')
  assert.equal(ledger.size, 3)
  assert.equal(ledger.has(1, 'a'), false, 'oldest-first eviction')
  assert.equal(ledger.has(1, 'd'), true)
})

test('an id from a previous epoch never satisfies a dedup check', () => {
  // A reconnect starts a new provider session; its item ids are unrelated to the old one's.
  const ledger = new EpochLedger(8)
  ledger.add(1, 'item-a')
  assert.equal(ledger.has(2, 'item-a'), false)
  assert.equal(ledger.add(2, 'item-a'), true, 'the same id in a new epoch is new')
})

test('renaming a turn keeps its eviction position instead of moving it to the end', () => {
  // The provider can reveal a turn's real item id later. Re-adding would move it to the end
  // of the eviction order and could evict an older turn that is still live.
  const ledger = new EpochLedger(3)
  ledger.add(1, 'oldest')
  ledger.add(1, 'provisional')
  ledger.add(1, 'newest')
  assert.equal(ledger.replace(1, 'provisional', 'real'), true)
  assert.equal(ledger.has(1, 'provisional'), false)
  assert.equal(ledger.has(1, 'real'), true)

  // 'oldest' must still be the next to go, which proves the slot was rewritten in place.
  ledger.add(1, 'fourth')
  assert.equal(ledger.has(1, 'oldest'), false)
  assert.equal(ledger.has(1, 'real'), true)
})

test('renaming refuses an unknown source or an occupied target', () => {
  const ledger = new EpochLedger(4)
  ledger.add(1, 'a')
  ledger.add(1, 'b')
  assert.equal(ledger.replace(1, 'missing', 'c'), false)
  assert.equal(ledger.replace(1, 'a', 'b'), false, 'a rename must not collapse two entries')
  assert.equal(ledger.has(1, 'a'), true)
  assert.equal(ledger.has(1, 'b'), true)
})

test('the user input revision advances once per genuinely new turn', () => {
  const state = new RealtimeSessionState()
  assert.equal(state.userInputRevision, 0)
  assert.equal(state.acceptUserTurn('item-1'), true)
  assert.equal(state.userInputRevision, 1)
  // A duplicate must not advance it, or a response would look stale against its own turn.
  assert.equal(state.acceptUserTurn('item-1'), false)
  assert.equal(state.userInputRevision, 1)
  assert.equal(state.acceptUserTurn('item-2'), true)
  assert.equal(state.userInputRevision, 2)
  // A rename is the same turn, so it must not advance either.
  assert.equal(state.replaceUserTurnIdentity('item-2', 'item-2-real'), true)
  assert.equal(state.userInputRevision, 2)
})

test('a response is stale exactly when newer user input has arrived', () => {
  const state = new RealtimeSessionState()
  state.acceptUserTurn('turn-1')
  state.openProviderTurn('resp-1', state.userInputRevision)
  assert.equal(state.providerTurnIsStale('resp-1'), false)

  state.acceptUserTurn('turn-2')
  assert.equal(state.providerTurnIsStale('resp-1'), true, 'its world no longer exists')

  state.openProviderTurn('resp-2', state.userInputRevision)
  assert.equal(state.providerTurnIsStale('resp-2'), false)
  // An unknown response is not stale; it is simply unknown.
  assert.equal(state.providerTurnIsStale('never-seen'), false)
  assert.equal(state.providerTurnIsStale(null), false)
})

test('a new epoch starts every epoch-scoped answer over', () => {
  const state = new RealtimeSessionState()
  state.acceptUserTurn('item-1')
  state.markEventResponded('event-1')
  state.openProviderTurn('resp-1', 1)
  state.trackUserCaption('item-1')
  state.setCaption({role: 'user', text: '说了什么', final: false})

  state.beginEpoch(1)
  assert.equal(state.hasUserTurn('item-1'), false)
  assert.equal(state.hostEventIsDeduplicated('event-1'), false)
  assert.equal(state.providerTurnPhase('resp-1'), undefined)
  assert.equal(state.userCaption, '', 'captions belong to the session that produced them')
  // The revision is a monotonic counter for the whole session, not per epoch.
  assert.equal(state.userInputRevision, 1)
})

test('the session epoch must strictly increase', () => {
  const state = new RealtimeSessionState()
  state.beginEpoch(1)
  assert.throws(() => state.beginEpoch(1), RangeError)
  assert.throws(() => state.beginEpoch(0), RangeError)
})

test('provider turns are bounded, evicting the oldest', () => {
  const state = new RealtimeSessionState()
  for (let index = 0; index <= MAX_TRACKED_PROVIDER_TURNS; index += 1) {
    state.openProviderTurn(`resp-${index}`, 0)
  }
  assert.equal(state.providerTurnPhase('resp-0'), undefined, 'the oldest turn was evicted')
  assert.equal(state.providerTurnPhase(`resp-${MAX_TRACKED_PROVIDER_TURNS}`), 'active')
})

test('reopening a response does not grow the eviction order twice', () => {
  const state = new RealtimeSessionState()
  state.openProviderTurn('resp-1', 0)
  const reopened = state.openProviderTurn('resp-1', 1)
  assert.equal(reopened.user_input_revision, 1)
  // Fill to the bound; if 'resp-1' occupied two slots the count would be wrong.
  for (let index = 0; index < MAX_TRACKED_PROVIDER_TURNS - 1; index += 1) {
    state.openProviderTurn(`filler-${index}`, 0)
  }
  assert.equal(state.providerTurnPhase('resp-1'), 'active')
})

test('an omitted progress field preserves the slot; an explicit null clears it', () => {
  const state = new RealtimeSessionState()
  state.registerDelegate('d-1', {summary: '跑测试', state: 'running',
    progress_summary: '编译中', internal_activity: 3, elapsed: 1.5})
  // A handoff that never mentions progress must not erase it.
  state.registerDelegate('d-1', {summary: '跑测试', state: 'running'})
  assert.equal(state.snapshot().active_delegates[0]?.[1].progress_summary, '编译中')
  assert.equal(state.snapshot().active_delegates[0]?.[1].internal_activity, 3)

  state.registerDelegate('d-1', {summary: '跑测试', state: 'running', progress_summary: null})
  assert.equal(state.snapshot().active_delegates[0]?.[1].progress_summary, null)
})

test('a progress summary is bounded by code point', () => {
  const state = new RealtimeSessionState()
  const long = '啊'.repeat(PROGRESS_SUMMARY_LIMIT + 50)
  state.registerDelegate('d-1', {summary: 's', state: 'running', progress_summary: long})
  const stored = state.snapshot().active_delegates[0]?.[1].progress_summary ?? ''
  assert.equal([...stored].length, PROGRESS_SUMMARY_LIMIT)
})

test('only running delegates are visible, and the snapshot version advances', () => {
  const state = new RealtimeSessionState()
  const before = state.snapshotVersion
  state.registerDelegate('d-1', {summary: 'a', state: 'running'})
  state.registerDelegate('d-2', {summary: 'b', state: 'completed'})
  state.registerDelegate('d-3', {summary: 'c', state: 'unknown'})
  const snapshot = state.snapshot()
  assert.deepEqual(snapshot.active_delegates.map(([id]) => id), ['d-1'])
  assert.ok(snapshot.version > before)
  assert.equal(state.delegateState('d-2'), 'completed')
  assert.equal(state.delegateState('missing'), undefined)
})

test('a delegate needs both an id and a summary', () => {
  const state = new RealtimeSessionState()
  assert.throws(() => state.registerDelegate('', {summary: 'a', state: 'running'}), TypeError)
  assert.throws(() => state.registerDelegate('d-1', {summary: '', state: 'running'}), TypeError)
})

test('captions are bounded without splitting an astral character', () => {
  const astral = '\u{1f600}'
  const long = astral.repeat(MAX_CAPTION_CHARS + 20)
  const truncated = truncateCaption(long)
  assert.equal([...truncated].length, MAX_CAPTION_CHARS)
  // Splitting by UTF-16 units would leave a lone surrogate here.
  assert.ok(!/[\uD800-\uDFFF]/u.test(truncated.slice(-1)) || truncated.endsWith(astral))
  assert.equal(truncateCaption('短'), '短')
})

test('a new caption target resets the accumulated text', () => {
  const state = new RealtimeSessionState()
  state.trackUserCaption('item-1')
  state.setCaption({role: 'user', text: '第一段', final: false})
  assert.equal(state.userCaption, '第一段')
  assert.equal(state.trackUserCaption('item-1'), false, 'the same target is not a change')
  assert.equal(state.trackUserCaption('item-2'), true)
  assert.equal(state.userCaption, '', 'a new turn starts a new caption')
})

test('spoken and interrupted event ids are recorded once each', () => {
  const state = new RealtimeSessionState()
  state.markEventSpoken('e-1')
  state.markEventSpoken('e-1')
  state.markEventInterrupted('e-2')
  const snapshot = state.snapshot()
  assert.deepEqual(snapshot.spoken_event_ids, ['e-1'])
  assert.deepEqual(snapshot.interrupted_event_ids, ['e-2'])
  assert.equal(state.eventWasSpoken('e-1'), true)
  assert.equal(state.eventWasSpoken('e-2'), false)
})

test('a host event is answered at most once', () => {
  const state = new RealtimeSessionState()
  assert.equal(state.markEventResponded('event-1'), true)
  assert.equal(state.markEventResponded('event-1'), false)
  assert.equal(state.hostEventIsDeduplicated('event-1'), true)
  assert.equal(state.hostEventIsDeduplicated('event-2'), false)
})

test('the transcript ledger is bounded independently of the turn ledger', () => {
  const state = new RealtimeSessionState()
  for (let index = 0; index <= MAX_TRACKED_USER_TRANSCRIPTS; index += 1) {
    state.acceptUserTranscriptTerminal(`t-${index}`)
  }
  // The oldest transcript aged out, but no turn was ever recorded.
  assert.equal(state.acceptUserTranscriptTerminal('t-0'), true)
  assert.equal(state.userInputRevision, 0)
})
