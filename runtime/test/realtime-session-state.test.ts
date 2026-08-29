import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROGRESS_SUMMARY_LIMIT } from '../src/events.js'
import { hostFact, type HostResponseIntent } from '../src/realtime/protocol.js'
import {
  EpochLedger,
  MAX_CAPTION_CHARS,
  MAX_PENDING_HOST_EVENTS,
  MAX_PREMAP_AUDIO_BYTES,
  MAX_TRACKED_HOST_EVENTS,
  MAX_TRACKED_PROVIDER_TURNS,
  MAX_TRACKED_USER_TRANSCRIPTS,
  RealtimeSessionState,
  activeExecutorContextData,
  activeExecutorContextRecords,
  truncateCaption,
  type PendingResponse,
} from '../src/realtime/session-state.js'

/** Distinct code points, so a truncation's retained half is provable, not just its length. */
function distinctCharacters(count: number): string[] {
  return Array.from({length: count}, (_unused, index) => String.fromCodePoint(0x4e00 + index))
}

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
  state.openProviderTurn('resp-1')
  assert.equal(state.providerTurnIsStale('resp-1'), false)

  state.acceptUserTurn('turn-2')
  assert.equal(state.providerTurnIsStale('resp-1'), true, 'its world no longer exists')

  state.openProviderTurn('resp-2')
  assert.equal(state.providerTurnIsStale('resp-2'), false)
  // An unknown response is not stale; it is simply unknown.
  assert.equal(state.providerTurnIsStale('never-seen'), false)
  assert.equal(state.providerTurnIsStale(null), false)
})

test('a new epoch starts provider-allocated answers over, and only those', () => {
  const state = new RealtimeSessionState()
  state.acceptUserTurn('item-1')
  state.markEventResponded('event-1')
  state.openProviderTurn('resp-1')
  state.trackUserCaption('item-1')
  state.setCaption({role: 'user', text: '说了什么', final: false})
  state.trackAssistantCaption('resp-1')
  state.setCaption({role: 'assistant', text: '好的', final: false})
  const before = state.snapshotVersion

  state.beginEpoch(1)

  // Provider-allocated identities are scoped to the session that issued them.
  assert.equal(state.hasUserTurn('item-1'), false)
  assert.equal(state.providerTurnPhase('resp-1'), undefined)
  // A host event the host already answered stays answered: the host owns that identity, and
  // re-answering it would repeat the utterance to the user after a reconnect.
  assert.equal(state.hostEventIsDeduplicated('event-1'), true)
  // Captions are not this layer's to clear; the layer above resets them around a reconnect.
  assert.equal(state.userCaption, '说了什么')
  assert.equal(state.assistantCaption, '好的')
  // The revision is a monotonic counter for the whole session, not per epoch.
  assert.equal(state.userInputRevision, 1)
  assert.ok(state.snapshotVersion > before, 'a new identity is a published change')
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
    state.openProviderTurn(`resp-${index}`)
  }
  assert.equal(state.providerTurnPhase('resp-0'), undefined, 'the oldest turn was evicted')
  assert.equal(state.providerTurnPhase(`resp-${MAX_TRACKED_PROVIDER_TURNS}`), 'active')
})

for (const phase of ['cancel_requested', 'completed', 'cancelled', 'failed'] as const) {
  test(`reopening a ${phase} response returns the existing turn untouched`, () => {
    const state = new RealtimeSessionState()
    state.acceptUserTurn('turn-1')
    const opened = state.openProviderTurn('resp-1')
    opened.phase = phase
    opened.locally_fenced = true
    opened.defer_playback_fence = true

    // Newer user input arrives, so a rebuilt entry would be re-dated against the new revision.
    state.acceptUserTurn('turn-2')
    const reopened = state.openProviderTurn('resp-1')

    assert.equal(reopened, opened, 'the same entry, not a replacement')
    assert.equal(reopened.phase, phase, `a ${phase} turn must not revive as active`)
    assert.equal(reopened.locally_fenced, true, 'a fence is a decision already taken')
    assert.equal(reopened.defer_playback_fence, true)
    assert.equal(reopened.user_input_revision, 1, 'it still answers the world it opened in')
    assert.equal(state.providerTurnIsStale('resp-1'), true)
  })
}

test('touching a provider turn moves it to the back of the eviction order', () => {
  const state = new RealtimeSessionState()
  for (let index = 0; index < MAX_TRACKED_PROVIDER_TURNS; index += 1) {
    state.openProviderTurn(`resp-${index}`)
  }
  // Re-touch the oldest so the second-oldest becomes next to go.
  state.openProviderTurn('resp-0')
  state.openProviderTurn('overflow')

  assert.equal(state.providerTurnPhase('resp-0'), 'active', 'the re-touched turn survived')
  assert.equal(state.providerTurnPhase('resp-1'), undefined, 'the oldest-touched was evicted')
  assert.equal(state.providerTurnPhase('overflow'), 'active')
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

test('a progress summary keeps its head, bounded by code point', () => {
  // Distinct code points, so the retained half is provable rather than merely the right length.
  const state = new RealtimeSessionState()
  const characters = distinctCharacters(PROGRESS_SUMMARY_LIMIT + 50)
  state.registerDelegate('d-1', {
    summary: 's',
    state: 'running',
    progress_summary: characters.join(''),
  })
  const stored = state.snapshot().active_delegates[0]?.[1].progress_summary ?? ''
  assert.equal([...stored].length, PROGRESS_SUMMARY_LIMIT)
  assert.equal(stored, characters.slice(0, PROGRESS_SUMMARY_LIMIT).join(''))
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

test('active executor context buckets volatile heartbeat counters into one canonical record', () => {
  const first = activeExecutorContextRecords([['d-1', {
    summary: '跑测试', state: 'running', channel: 'codex', progress_summary: '编译中',
    internal_activity: 9, elapsed: 16,
  }]])
  const sameWindow = activeExecutorContextRecords([['d-1', {
    summary: '跑测试', state: 'running', channel: 'codex', progress_summary: '编译中',
    internal_activity: 15, elapsed: 29.9,
  }]])
  const nextWindow = activeExecutorContextRecords([['d-1', {
    summary: '跑测试', state: 'running', channel: 'codex', progress_summary: '编译中',
    internal_activity: 16, elapsed: 30,
  }]])

  assert.deepEqual(first, sameWindow)
  assert.equal(first[0]?.host_state.elapsed_s, 15)
  assert.equal(first[0]?.host_state.internal_activity, 8)
  assert.notDeepEqual(first, nextWindow)
})

test('active executor dedup data contains exactly the bounded provider-visible records', () => {
  const delegates = Array.from({length: 4}, (_unused, index) => [
    `d-${index}`,
    {
      summary: `任务 ${index}`,
      state: 'running' as const,
      channel: 'codex',
      progress_summary: `进度 ${index}`,
      internal_activity: 0,
      elapsed: 0,
    },
  ] as const)
  const changedOmitted = delegates.map((entry, index) => index === 3
    ? [entry[0], {...entry[1], progress_summary: '不可见的新进度'}] as const
    : entry)

  assert.deepEqual(activeExecutorContextData(delegates), activeExecutorContextData(changedOmitted))
  assert.equal(activeExecutorContextData(delegates).delegates.length, 3)
  assert.equal(activeExecutorContextData(delegates).omitted_count, 1)
})

test('a delegate needs both an id and a summary', () => {
  const state = new RealtimeSessionState()
  assert.throws(() => state.registerDelegate('', {summary: 'a', state: 'running'}), TypeError)
  assert.throws(() => state.registerDelegate('d-1', {summary: '', state: 'running'}), TypeError)
})

test('a caption keeps its newest end, the opposite end from a progress summary', () => {
  // A caption grows by deltas, so the display must follow what is being said now. Keeping the
  // head would freeze the UI on the opening of a long utterance.
  const characters = distinctCharacters(MAX_CAPTION_CHARS + 20)
  const truncated = truncateCaption(characters.join(''))

  assert.equal([...truncated].length, MAX_CAPTION_CHARS)
  assert.equal(truncated, characters.slice(-MAX_CAPTION_CHARS).join(''))
  assert.equal(truncateCaption('短'), '短')
})

test('a caption bound never splits an astral character', () => {
  const astral = '\u{1f600}'
  const truncated = truncateCaption(astral.repeat(MAX_CAPTION_CHARS + 20))
  assert.equal([...truncated].length, MAX_CAPTION_CHARS)
  // Slicing by UTF-16 unit would leave a lone surrogate at one end or the other.
  assert.equal(truncated.replaceAll(astral, ''), '', 'no half of a surrogate pair survived')
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

test('appending event ids does not publish; the caller publishes once', () => {
  // A response carries several event ids and is appended in a loop. Counting each append as a
  // published change would make the version a function of how many ids a response happened to
  // carry rather than of how many times state was published.
  const state = new RealtimeSessionState()
  const before = state.snapshotVersion
  state.markEventSpoken('e-1')
  state.markEventSpoken('e-2')
  state.markEventInterrupted('e-3')
  assert.equal(state.snapshotVersion, before, 'no append publishes on its own')

  state.advanceSnapshot()
  assert.equal(state.snapshotVersion, before + 1, 'one publish, whatever the id count')
})

test('a host event is answered at most once', () => {
  const state = new RealtimeSessionState()
  assert.equal(state.markEventResponded('event-1'), true)
  assert.equal(state.markEventResponded('event-1'), false)
  assert.equal(state.hostEventIsDeduplicated('event-1'), true)
  assert.equal(state.hostEventIsDeduplicated('event-2'), false)
})

test('withdrawing an answer makes the event answerable again', () => {
  // A suggestion whose response was interrupted never reached the user, so its authority goes
  // back and the event must be eligible again.
  const state = new RealtimeSessionState()
  state.markEventResponded('suggestion:1')
  assert.equal(state.releaseRespondedEvent('suggestion:1'), true)
  assert.equal(state.hostEventIsDeduplicated('suggestion:1'), false)
  assert.equal(state.releaseRespondedEvent('suggestion:1'), false, 'withdrawing twice is a no-op')
  assert.equal(state.markEventResponded('suggestion:1'), true)
})

test('answered events are bounded only when pruned, oldest-touched first', () => {
  const state = new RealtimeSessionState()
  for (let index = 0; index < MAX_TRACKED_HOST_EVENTS; index += 1) {
    state.markEventResponded(`event-${index}`)
  }
  // Re-answering the oldest moves it to the back, so the next few become the ones to go.
  state.markEventResponded('event-0')
  // Several excess entries, so a prune that drops one and stops leaves the ledger over bound.
  const excess = 5
  for (let index = 0; index < excess; index += 1) state.markEventResponded(`overflow-${index}`)

  // Recording does not evict: a burst must not drop an event the same burst still needs.
  assert.equal(state.respondedEventIds.length, MAX_TRACKED_HOST_EVENTS + excess)
  assert.equal(state.hostEventIsDeduplicated('event-1'), true)

  state.pruneRespondedEvents()
  assert.equal(state.respondedEventIds.length, MAX_TRACKED_HOST_EVENTS)
  for (let index = 1; index <= excess; index += 1) {
    assert.equal(
      state.hostEventIsDeduplicated(`event-${index}`),
      false,
      `event-${index} was among the oldest-touched`,
    )
  }
  assert.equal(state.hostEventIsDeduplicated(`event-${excess + 1}`), true, 'and no further')
  assert.equal(state.hostEventIsDeduplicated('event-0'), true, 'the re-answered one survived')
  assert.equal(state.hostEventIsDeduplicated(`overflow-${excess - 1}`), true)
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

function hostFactIntent(eventId: string): HostResponseIntent {
  return hostFact({
    kind: 'progress',
    host_item_id: `host-${eventId}`,
    event_id: eventId,
    content: '在跑。',
    call_id: null,
  })
}

function pending(eventId: string, revision: number): PendingResponse {
  const intent = hostFactIntent(eventId)
  return {intents: [intent], provider_intent: intent, user_input_revision: revision}
}

test('an injected event records its epoch and is withdrawable', () => {
  const state = new RealtimeSessionState()
  state.recordInjectedEvent('progress:1')
  assert.equal(state.injectedEventEpoch('progress:1'), 0)

  state.beginEpoch(3)
  state.recordInjectedEvent('progress:2')
  assert.equal(state.injectedEventEpoch('progress:2'), 3)
  // The earlier one keeps the epoch it was injected in: that is the question being asked of it.
  assert.equal(state.injectedEventEpoch('progress:1'), 0)

  assert.equal(state.releaseInjectedEvent('progress:1'), true)
  assert.equal(state.injectedEventEpoch('progress:1'), undefined)
  assert.equal(state.releaseInjectedEvent('progress:1'), false)
})

test('recording an injected event tolerates more than pruning reclaims', () => {
  // The record bound is above the prune target on purpose: recording must never drop an item the
  // caller is about to reference, and pruning reclaims the slack once entries become prunable.
  assert.ok(MAX_PENDING_HOST_EVENTS > MAX_TRACKED_HOST_EVENTS)
  const state = new RealtimeSessionState()
  for (let index = 0; index < MAX_PENDING_HOST_EVENTS; index += 1) {
    state.recordInjectedEvent(`event-${index}`)
  }
  // Re-touch the oldest, so the next one becomes the eviction candidate.
  state.recordInjectedEvent('event-0')
  state.recordInjectedEvent('overflow')

  assert.equal(state.injectedEventEpoch('event-0'), 0, 'the re-touched entry survived')
  assert.equal(state.injectedEventEpoch('event-1'), undefined, 'the oldest-touched was evicted')
  assert.equal(state.injectedEventEpoch('overflow'), 0)
})

test('pruning reclaims only answered injections, and stops at the target', () => {
  const state = new RealtimeSessionState()
  for (let index = 0; index < MAX_PENDING_HOST_EVENTS; index += 1) {
    state.recordInjectedEvent(`event-${index}`)
  }
  // Only the first three are answered, so only they may be reclaimed.
  for (const index of [0, 1, 2]) state.markEventResponded(`event-${index}`)
  const before = state.snapshotVersion

  state.pruneHostEventLedgers([])

  const surplus = MAX_PENDING_HOST_EVENTS - MAX_TRACKED_HOST_EVENTS
  assert.ok(surplus >= 3, 'the fixture needs more surplus than answered entries')
  for (const index of [0, 1, 2]) {
    assert.equal(
      state.injectedEventEpoch(`event-${index}`),
      undefined,
      `event-${index} was answered and reclaimable`,
    )
  }
  // Unanswered entries stay even though the ledger is still above target.
  assert.equal(state.injectedEventEpoch('event-3'), 0, 'an unanswered injection is not reclaimed')
  assert.ok(state.snapshotVersion > before, 'a prune publishes once')
})

test('a completed event id is prunable even before it was answered', () => {
  // The caller passes the ids it has just finished with; they are prunable by that fact alone.
  const state = new RealtimeSessionState()
  for (let index = 0; index < MAX_PENDING_HOST_EVENTS; index += 1) {
    state.recordInjectedEvent(`event-${index}`)
  }
  state.pruneHostEventLedgers(['event-0'])
  assert.equal(state.injectedEventEpoch('event-0'), undefined)
  assert.equal(state.injectedEventEpoch('event-1'), 0)
})

test('a retained suggestion injection is revoked in one go, and dies with its slot', () => {
  const state = new RealtimeSessionState()
  state.recordInjectedEvent('suggestion:1')
  state.recordInjectedEvent('suggestion:2')
  state.retainSuggestionInjection('suggestion:1')

  state.revokeRetainedSuggestionInjections()
  assert.equal(state.injectedEventEpoch('suggestion:1'), undefined)
  assert.equal(state.injectedEventEpoch('suggestion:2'), 0, 'only retained ones are revoked')

  // Revoking consumes the retentions. Re-injecting the same event afterwards must not be revoked
  // again by a retention that was already spent.
  state.recordInjectedEvent('suggestion:1')
  state.revokeRetainedSuggestionInjections()
  assert.equal(state.injectedEventEpoch('suggestion:1'), 0, 'a spent retention does not re-fire')

  // A retention whose injection was evicted must not resurrect anything later.
  state.recordInjectedEvent('suggestion:3')
  state.retainSuggestionInjection('suggestion:3')
  state.releaseInjectedEvent('suggestion:3')
  state.revokeRetainedSuggestionInjections()
  assert.equal(state.injectedEventEpoch('suggestion:3'), undefined)
})

test('pending responses are a queue, and the head is what the provider starts next', () => {
  // Read the head into a local each time: `assert.equal` from node:assert/strict carries an
  // assertion signature, so asserting a getter is undefined narrows every later read of it.
  const state = new RealtimeSessionState()
  const eventIdOf = (entry: PendingResponse | undefined): string | undefined =>
    entry?.provider_intent.item.event_id

  assert.equal(state.pendingResponseCount, 0)
  assert.equal(eventIdOf(state.headPendingResponse), undefined)

  state.queuePendingResponse(pending('progress:1', 0))
  state.queuePendingResponse(pending('progress:2', 1))
  assert.equal(state.pendingResponseCount, 2)
  assert.equal(eventIdOf(state.headPendingResponse), 'progress:1')

  assert.equal(eventIdOf(state.popPendingResponse()), 'progress:1')
  assert.equal(eventIdOf(state.headPendingResponse), 'progress:2')
  assert.deepEqual(
    state.pendingResponses.map((entry: PendingResponse) => entry.provider_intent.item.event_id),
    ['progress:2'],
  )

  state.clearPendingResponses()
  assert.equal(state.pendingResponseCount, 0)
  assert.equal(eventIdOf(state.popPendingResponse()), undefined)
})

test('a pending response remembers the world it answers', () => {
  // A continuation is only suppressible while the user input it answers is still current, so the
  // revision travels with the pending entry rather than being read at start time.
  const state = new RealtimeSessionState()
  state.acceptUserTurn('turn-1')
  state.queuePendingResponse(pending('progress:1', state.userInputRevision))
  state.acceptUserTurn('turn-2')

  assert.equal(state.headPendingResponse?.user_input_revision, 1)
  assert.notEqual(state.headPendingResponse?.user_input_revision, state.userInputRevision)
})

test('suppression is per response and reversible', () => {
  const state = new RealtimeSessionState()
  assert.equal(state.responseIsSuppressed('resp-1'), false)
  state.suppressResponse('resp-1')
  assert.equal(state.responseIsSuppressed('resp-1'), true)
  assert.equal(state.responseIsSuppressed('resp-2'), false)

  assert.equal(state.releaseSuppressedResponse('resp-1'), true)
  assert.equal(state.releaseSuppressedResponse('resp-1'), false)

  state.suppressResponse('resp-1')
  state.suppressResponse('resp-2')
  state.clearSuppressedResponses()
  assert.equal(state.responseIsSuppressed('resp-1'), false)
  assert.equal(state.responseIsSuppressed('resp-2'), false)
})

test('the pre-map buffer belongs to one response and is discarded whole', () => {
  const state = new RealtimeSessionState()
  assert.equal(state.premapResponseId, null)
  assert.equal(state.premapAudioBytes, 0)

  state.bufferPremapAudio('resp-1', new Uint8Array([0, 1]))
  state.bufferPremapAudio('resp-1', new Uint8Array([2, 3, 4, 5]))
  assert.equal(state.premapResponseId, 'resp-1')
  assert.equal(state.premapAudioBytes, 6)
  assert.deepEqual(state.premapAudio.map(chunk => chunk.byteLength), [2, 4])

  // Over budget means the buffered audio is unusable, not that one delta is: everything goes.
  state.clearPremapAudio()
  assert.equal(state.premapResponseId, null)
  assert.equal(state.premapAudioBytes, 0)
  assert.deepEqual(state.premapAudio, [])
})

test('the pre-map budget is asked about separately from buffering', () => {
  // Two guards share this question and then do different things with the answer, so the check
  // cannot be folded into the buffer call.
  const state = new RealtimeSessionState()
  assert.equal(state.premapAudioWouldExceed(MAX_PREMAP_AUDIO_BYTES), false, 'exactly at the bound')
  assert.equal(state.premapAudioWouldExceed(MAX_PREMAP_AUDIO_BYTES + 1), true)

  state.bufferPremapAudio('resp-1', new Uint8Array(MAX_PREMAP_AUDIO_BYTES - 2))
  assert.equal(state.premapAudioWouldExceed(2), false)
  assert.equal(state.premapAudioWouldExceed(4), true)
  // Asking does not mutate: a refused delta leaves the buffer exactly as it was.
  assert.equal(state.premapAudioBytes, MAX_PREMAP_AUDIO_BYTES - 2)
})

test('pruning stops at the target even when more entries are reclaimable', () => {
  // Reclaiming everything eligible would throw away injections the caller can still reference for
  // the rest of the epoch. The ledger is trimmed to the target, not emptied of answered entries.
  const state = new RealtimeSessionState()
  for (let index = 0; index < MAX_PENDING_HOST_EVENTS; index += 1) {
    state.recordInjectedEvent(`event-${index}`)
  }
  const surplus = MAX_PENDING_HOST_EVENTS - MAX_TRACKED_HOST_EVENTS
  const answered = surplus + 8
  for (let index = 0; index < answered; index += 1) state.markEventResponded(`event-${index}`)

  state.pruneHostEventLedgers([])

  for (let index = 0; index < surplus; index += 1) {
    assert.equal(
      state.injectedEventEpoch(`event-${index}`),
      undefined,
      `event-${index} was within the surplus`,
    )
  }
  for (let index = surplus; index < answered; index += 1) {
    assert.equal(
      state.injectedEventEpoch(`event-${index}`),
      0,
      `event-${index} is answered but the ledger was already at target`,
    )
  }
})

test('pruning an injection drops the retention that was holding it', () => {
  // A retention outliving its injection is worse than useless: the same event re-injected later
  // would be revoked by a retention that belongs to a response already finished with.
  const state = new RealtimeSessionState()
  for (let index = 0; index < MAX_PENDING_HOST_EVENTS; index += 1) {
    state.recordInjectedEvent(`suggestion:${index}`)
  }
  state.markEventResponded('suggestion:0')
  state.retainSuggestionInjection('suggestion:0')

  state.pruneHostEventLedgers([])
  assert.equal(state.injectedEventEpoch('suggestion:0'), undefined, 'pruned as answered')

  state.recordInjectedEvent('suggestion:0')
  state.revokeRetainedSuggestionInjections()
  assert.equal(
    state.injectedEventEpoch('suggestion:0'),
    0,
    'the stale retention must not revoke the new injection',
  )
})
