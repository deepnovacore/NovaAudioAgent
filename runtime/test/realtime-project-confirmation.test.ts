/**
 * The Node leg of the project-confirmation parity suite.
 *
 * Two surfaces, pinned for different reasons. The classifier decides whether a spoken sentence
 * authorizes a workspace change, so its verdict for every phrasing is a security boundary. The
 * controller owns the reservation and the single-use commit authority, so its sequence of outcomes
 * over a scripted conversation is what stops a confirmation being replayed or answered by the wrong
 * utterance.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import { VirtualClock } from '../src/clock.js'
import { isOtherCategory, isPunctuationCategory } from '../src/unicode-tables.js'
import {
  CONFIRMATION_LEADING,
  CONFIRMATION_NEGATIVE,
  CONFIRMATION_POSITIVE,
  CONFIRMATION_TRAILING,
  ProjectConfirmationController,
  classifyConfirmation,
  type ConfirmationOutcome,
  type ConfirmedProjectOperation,
  type ProjectAction,
  type ProjectConfirmationView,
} from '../src/realtime/project-confirmation.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/realtime/confirmation/v1')

interface ControllerStep {
  readonly kind: string
  readonly action?: ProjectAction
  readonly workspace_display_name?: string
  readonly workspace_id?: string | null
  readonly session_title?: string | null
  readonly session_id?: string | null
  readonly work_order?: string | null
  readonly origin_ref?: string
  readonly epoch?: number
  readonly item_id?: string
  readonly text?: string
  readonly reason?: string
  readonly to?: number
}

interface ControllerScenario {
  readonly name: string
  readonly covers: readonly string[]
  readonly steps: readonly ControllerStep[]
  readonly nonces?: readonly string[]
}

const document = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios.json'), 'utf8'),
) as {readonly classifier: readonly string[]; readonly controller: readonly ControllerScenario[]}

const golden = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios-expected.json'), 'utf8'),
) as {
  readonly classifier: readonly {readonly text: string; readonly verdict: string}[]
  readonly controller: readonly Record<string, unknown>[]
}

function runController(scenario: ControllerScenario): Record<string, unknown> {
  const clock = new VirtualClock()
  const views: ProjectConfirmationView[] = []
  const expiries: number[] = []
  const nonces = [...(scenario.nonces ?? ['nonce-1', 'nonce-2', 'nonce-3'])]
  let nonceIndex = 0
  const controller = new ProjectConfirmationController({
    clock,
    idFactory: () => {
      const value = nonces[nonceIndex]
      if (value === undefined) throw new Error('nonce sequence exhausted')
      nonceIndex += 1
      return value
    },
    onChange: view => {
      views.push(view)
    },
  })
  controller.observeExpiry(() => {
    expiries.push(views.length)
  })

  const steps: Record<string, unknown>[] = []
  let held: ConfirmedProjectOperation | null = null
  for (const [index, step] of scenario.steps.entries()) {
    const viewMark = views.length
    const expiryMark = expiries.length
    let result: unknown
    try {
      switch (step.kind) {
        case 'prepare':
          result = controller.prepare({
            action: step.action!,
            workspace_display_name: step.workspace_display_name!,
            workspace_id: step.workspace_id ?? null,
            session_title: step.session_title ?? null,
            session_id: step.session_id ?? null,
            work_order: step.work_order ?? null,
            origin_ref: step.origin_ref!,
          })
          break
        case 'reserve':
          result = controller.reserveUserItem({
            epoch: step.epoch!,
            itemId: step.item_id!,
          })
          break
        case 'accept': {
          const outcome: ConfirmationOutcome = controller.acceptTranscript({
            epoch: step.epoch!,
            itemId: step.item_id!,
            text: step.text!,
          })
          if (outcome.operation !== null) held = outcome.operation
          result = outcome
          break
        }
        case 'fail':
          result = controller.failTranscript({
            epoch: step.epoch!,
            itemId: step.item_id!,
          })
          break
        case 'claim':
          result = held !== null && controller.claimConfirmed(held)
          break
        case 'claim_forged':
          // A reconstructed operation with identical fields must not commit: authority is identity.
          if (held === null) throw new Error('claim_forged needs a prior confirmation')
          result = controller.claimConfirmed({...held})
          break
        case 'expire':
          result = controller.expire()
          break
        case 'invalidate':
          result = controller.invalidate(step.reason ?? 'test')
          break
        case 'set_clock':
          // Time moves; nothing scheduled gets a chance to run. Whether a timer would have fired by
          // now is a property of each runtime's loop, so draining it here would pin the harness.
          clock.advanceTo(step.to!)
          result = null
          break
        case 'view':
          result = controller.view
          break
        default:
          throw new Error(`unsupported step kind: ${step.kind}`)
      }
    } catch (cause) {
      result = {error: (cause as Error).message}
    }
    steps.push({
      step: index,
      kind: step.kind,
      result,
      views: views.slice(viewMark),
      expiry_notifications: expiries.length - expiryMark,
      state: {
        pending: controller.pending,
        view: controller.view,
        clock: clock.now(),
      },
    })
  }
  return {name: scenario.name, steps}
}

test('every classifier phrase gets the verdict the oracle gives it', () => {
  // The security-relevant half. A phrase that confirms here and not there, or the reverse, means the
  // two runtimes disagree about whether a user authorized a workspace change.
  const divergent: string[] = []
  for (const [index, text] of document.classifier.entries()) {
    const expected = golden.classifier[index]
    if (expected?.text !== text) {
      divergent.push(`${index}: fixture and golden are out of order`)
      continue
    }
    const verdict = classifyConfirmation(text)
    if (verdict !== expected.verdict) {
      divergent.push(`${JSON.stringify(text)}: python=${expected.verdict} node=${verdict}`)
    }
  }
  assert.deepEqual(divergent, [], 'classifier verdicts differ from the oracle')
})

test('every controller scenario matches the Python-exported golden', () => {
  const mismatched: string[] = []
  for (const [index, scenario] of document.controller.entries()) {
    const actual = runController(scenario)
    if (canonicalJson(actual) !== canonicalJson(golden.controller[index])) {
      mismatched.push(scenario.name)
    }
  }
  assert.deepEqual(mismatched, [], 'controller behavior differs from the oracle')
})

test('the golden records one result per scenario, in order', () => {
  assert.deepEqual(
    golden.controller.map(entry => entry.name),
    document.controller.map(scenario => scenario.name),
  )
  assert.deepEqual(
    golden.classifier.map(entry => entry.text),
    [...document.classifier],
  )
})

test('every scenario declares what it covers', () => {
  for (const scenario of document.controller) {
    assert.ok(scenario.covers.length > 0, scenario.name)
    assert.ok(scenario.steps.length > 0, scenario.name)
  }
})

test('the classifier set exercises confirmations, cancellations, and near-misses', () => {
  // A set of only positives would prove nothing: what matters is that speech which merely sounds
  // affirmative does not confirm.
  const verdicts = new Set(golden.classifier.map(entry => entry.verdict))
  assert.deepEqual([...verdicts].sort(), ['cancel', 'confirm', 'unknown'])
  // The specific traps: a refusal containing a positive word, and a positive word inside a sentence.
  const verdictOf = (text: string): string | undefined =>
    golden.classifier.find(entry => entry.text === text)?.verdict
  assert.equal(verdictOf('可以取消吗'), 'cancel', 'a refusal containing 可以 must not confirm')
  assert.equal(verdictOf('不可以'), 'unknown')
  assert.equal(verdictOf('我觉得可以但是等一下'), 'unknown')
  assert.equal(verdictOf('确认一下这个是什么'), 'unknown')
})

test('a non-string utterance is unknown rather than a crash', () => {
  // The oracle takes `object` and type-checks, so the boundary accepts anything a caller has.
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(classifyConfirmation(value), 'unknown', JSON.stringify(value ?? null))
  }
})

test('an unheld operation cannot be claimed', () => {
  const controller = new ProjectConfirmationController({
    clock: new VirtualClock(),
    idFactory: () => 'nonce-1',
  })
  const proposal = controller.prepare({
    action: 'create',
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  })
  // Nothing has been confirmed, so there is no authority to spend -- not even for a real proposal.
  assert.equal(
    controller.claimConfirmed({
      action: proposal.action,
      workspace_display_name: proposal.workspace_display_name,
      workspace_id: proposal.workspace_id,
      session_title: proposal.session_title,
      session_id: proposal.session_id,
      work_order: proposal.work_order,
      origin_ref: proposal.origin_ref,
      nonce: proposal.nonce,
    }),
    false,
  )
})

test('proposal and confirmed commit capability are immutable snapshots', () => {
  const controller = new ProjectConfirmationController({
    clock: new VirtualClock(),
    idFactory: () => 'immutable-nonce',
  })
  const proposal = controller.prepare({
    action: 'create',
    workspace_display_name: 'alpha',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: 'exact work',
    origin_ref: 'conversation:1',
  })
  assert.equal(Object.isFrozen(proposal), true)
  assert.equal(controller.reserveUserItem({epoch: 1, itemId: 'confirm'}), true)
  const accepted = controller.acceptTranscript({epoch: 1, itemId: 'confirm', text: '确认'})
  assert.ok(accepted.operation)
  assert.equal(Object.isFrozen(accepted.operation), true)
  assert.throws(() => {
    ;(accepted.operation as {action: string}).action = 'select'
  }, TypeError)
  assert.equal(accepted.operation.action, 'create')
})

test('a nonce that is empty or oversized is refused', () => {
  for (const nonce of ['', 'x'.repeat(129)]) {
    const controller = new ProjectConfirmationController({
      clock: new VirtualClock(),
      idFactory: () => nonce,
    })
    assert.throws(
      () => controller.prepare({
        action: 'create',
        workspace_display_name: '研究项目',
        workspace_id: null,
        session_title: null,
        session_id: null,
        work_order: null,
        origin_ref: 'conversation:1',
      }),
      /invalid confirmation nonce/u,
      `nonce length ${nonce.length}`,
    )
  }
  const accepted = new ProjectConfirmationController({
    clock: new VirtualClock(),
    idFactory: () => '😀'.repeat(128),
  })
  assert.doesNotThrow(() => accepted.prepare({
    action: 'create',
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  }))
  const rejected = new ProjectConfirmationController({
    clock: new VirtualClock(),
    idFactory: () => '😀'.repeat(129),
  })
  assert.throws(() => rejected.prepare({
    action: 'create',
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  }), /invalid confirmation nonce/u)
})

test('an observer that throws does not strand the ones after it', () => {
  // A renderer that cannot accept the notification must not prevent the others from learning the
  // proposal is gone: by the time observers run, the state change has already happened.
  const clock = new VirtualClock()
  const controller = new ProjectConfirmationController({clock, idFactory: () => 'nonce-1'})
  const seen: string[] = []
  controller.observeExpiry(() => {
    seen.push('first')
    throw new Error('renderer is gone')
  })
  controller.observeExpiry(() => {
    seen.push('second')
  })
  controller.prepare({
    action: 'create',
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  })
  clock.advanceTo(90)
  assert.equal(controller.expire(), true)
  assert.deepEqual(seen, ['first', 'second'])
})

test('unsubscribing during notification does not skip the next observer', () => {
  // The observer list is copied before notifying, so an observer that removes itself -- which is the
  // ordinary way to clean up -- cannot shift the one behind it out of the iteration.
  const clock = new VirtualClock()
  const controller = new ProjectConfirmationController({clock, idFactory: () => 'nonce-1'})
  const seen: string[] = []
  const unsubscribe = controller.observeExpiry(() => {
    seen.push('first')
    unsubscribe()
  })
  controller.observeExpiry(() => {
    seen.push('second')
  })
  controller.prepare({
    action: 'create',
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  })
  clock.advanceTo(90)
  controller.expire()
  assert.deepEqual(seen, ['first', 'second'])
})

test('cancellation is decided before confirmation, and the sets make that safe', () => {
  // The order in `classifyConfirmation` is a security property: a sentence that both contains a
  // refusal and matches a confirmation must cancel. Today the closed sets do not intersect, so
  // swapping the two checks changes nothing -- which means the safety rests on the *sets*, not on the
  // order. This test pins the set property directly, so adding a phrase that breaks it fails here
  // rather than silently making the order load-bearing and untested.
  // The real sets, not a copy: a test restating them would pass while the module's own lists drift.
  const positives = [...CONFIRMATION_POSITIVE]
  const negatives = CONFIRMATION_NEGATIVE
  const leading = CONFIRMATION_LEADING
  const trailing = CONFIRMATION_TRAILING

  // Every phrase the classifier can reach the confirm branch with, including filler-wrapped forms.
  const confirmable: string[] = [...positives]
  for (const positive of positives) {
    for (const filler of leading) confirmable.push(filler + positive)
    for (const filler of trailing) confirmable.push(positive + filler)
    for (const before of leading) {
      for (const after of trailing) confirmable.push(before + positive + after)
    }
  }
  const unsafe = confirmable.filter(phrase =>
    negatives.some(negative => phrase.includes(negative)),
  )
  assert.deepEqual(
    unsafe,
    [],
    'a confirmable phrase containing a refusal would make the check order load-bearing',
  )

  // And the property that matters, stated directly on the classifier: anything containing a refusal
  // cancels, whatever else it contains.
  for (const negative of negatives) {
    for (const positive of positives) {
      assert.equal(classifyConfirmation(positive + negative), 'cancel', positive + negative)
      assert.equal(classifyConfirmation(negative + positive), 'cancel', negative + positive)
    }
  }
})

test('only one filler token is stripped from each end', () => {
  // Stripping repeatedly would let arbitrarily padded speech confirm. One token each side is the
  // whole allowance, so a doubled filler must not reach the positive set.
  assert.equal(classifyConfirmation('好确认'), 'confirm')
  assert.equal(classifyConfirmation('好好确认'), 'unknown')
  assert.equal(classifyConfirmation('确认啊'), 'confirm')
  assert.equal(classifyConfirmation('确认啊啊'), 'unknown')
  // One from each end together is still one each.
  assert.equal(classifyConfirmation('好确认啊'), 'confirm')
})

test('the longest matching filler is stripped, not the shortest', () => {
  // "好的" has to come off as one token: stripping "好" first would leave "的确认", which matches
  // nothing. Ordering the list longest-first is what makes that work.
  assert.equal(classifyConfirmation('好的确认'), 'confirm')
  assert.equal(classifyConfirmation('嗯嗯可以'), 'confirm')
  assert.equal(classifyConfirmation('那就执行吧'), 'confirm')
})

test('the utterance filter drops exactly the code points the oracle drops', () => {
  // `str.isspace()` and `trim()` disagree on six code points -- U+001C..U+001F, U+0085, U+FEFF -- so
  // the whitespace test alone is not equivalent. All six are category C, and the control-character
  // filter beside it catches every one, which is why the *combined* filter agrees everywhere. That
  // is an argument, so it is checked over the whole code space rather than asserted.
  // The disagreement runs both ways: five are whitespace to Python and not to `trim`, and U+FEFF is
  // the reverse. Every one of them is category C, which is what makes the combined filter agree.
  for (const codePoint of [0x1c, 0x1d, 0x1e, 0x1f, 0x85]) {
    const character = String.fromCodePoint(codePoint)
    assert.notEqual(character.trim(), '', `U+${codePoint.toString(16)} is not whitespace to trim`)
    assert.equal(isOtherCategory(codePoint), true, 'but the control filter catches it')
  }
  assert.equal('\ufeff'.trim(), '', 'U+FEFF is whitespace to trim and not to Python')
  assert.equal(isOtherCategory(0xfeff), true, 'and the control filter catches it too')

  // And the property that matters: a character survives the filter here exactly when it survives it
  // in the oracle. Anything that did not would change what a user is understood to have said.
  let surviving = 0
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue
    const character = String.fromCodePoint(codePoint)
    const dropped = character.trim() === ''
      || isPunctuationCategory(codePoint)
      || isOtherCategory(codePoint)
    if (!dropped) surviving += 1
  }
  // Measured against CPython 15.0.0 across every non-surrogate code point.
  assert.equal(surviving, 148155, 'the surviving set must match the oracle exactly')
})

test('whitespace and punctuation inside an utterance do not change its verdict', () => {
  // The filter is what lets a user say "确认。" or "确 认" and be understood. These are the forms the
  // six divergent code points appear in, so they exercise the argument above end to end.
  for (const separator of ['', ' ', '\u00a0', '\u3000', '\u001c', '\u0085', '\ufeff', '。', '，']) {
    assert.equal(
      classifyConfirmation(`确${separator}认`),
      'confirm',
      `separator U+${(separator.codePointAt(0) ?? 0).toString(16)}`,
    )
  }
  // And the same for a cancellation, which is matched as a substring rather than exactly.
  assert.equal(classifyConfirmation('取\u3000消'), 'cancel')
})

test('a numeric item id cannot manufacture a reservation match', () => {
  // The reservation key is built by interpolation, so `7` and `'7'` produce the same string. Without
  // a type check that lets a malformed reservation be answered by an unrelated transcript -- which is
  // the spoken-authorization boundary itself, not a formatting detail. The oracle rejects a
  // non-string item id outright.
  const controller = new ProjectConfirmationController({
    clock: new VirtualClock(),
    idFactory: () => 'nonce-1',
  })
  const proposal = {
    action: 'create' as const,
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  }
  controller.prepare(proposal)

  // Reserving with a number is refused, so the later string cannot answer it.
  assert.equal(controller.reserveUserItem({epoch: 1, itemId: 7 as unknown as string}), false)
  const afterNumeric = controller.acceptTranscript({epoch: 1, itemId: '7', text: '确认'})
  assert.equal(afterNumeric.kind, 'ignored')
  assert.equal(afterNumeric.operation, null, 'no authority may be granted')

  // And the reverse: a real string reservation is not answerable by the number.
  const second = new ProjectConfirmationController({
    clock: new VirtualClock(),
    idFactory: () => 'nonce-1',
  })
  second.prepare(proposal)
  assert.equal(second.reserveUserItem({epoch: 1, itemId: '7'}), true)
  assert.equal(
    second.acceptTranscript({epoch: 1, itemId: 7 as unknown as string, text: '确认'}).kind,
    'ignored',
  )
  assert.equal(
    second.failTranscript({epoch: 1, itemId: 7 as unknown as string}).kind,
    'ignored',
    'the failure path shares the same key construction',
  )
  // The ordinary path still works, so the check is not simply refusing everything.
  assert.equal(second.acceptTranscript({epoch: 1, itemId: '7', text: '确认'}).kind, 'confirmed')
})

test('a non-integer or non-positive epoch cannot reserve', () => {
  const controller = new ProjectConfirmationController({
    clock: new VirtualClock(),
    idFactory: () => 'nonce-1',
  })
  controller.prepare({
    action: 'create',
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  })
  for (const epoch of [0, -1, 1.5, Number.NaN, '1' as unknown as number]) {
    assert.equal(
      controller.reserveUserItem({epoch, itemId: 'item-a'}),
      false,
      `epoch=${String(epoch)}`,
    )
  }
  assert.equal(controller.reserveUserItem({epoch: 1, itemId: 'item-a'}), true)
})

test('a proposal field of the wrong type is refused before any state moves', () => {
  // `prepare` replaces whatever proposal is pending, so a malformed call must fail before it does
  // anything -- otherwise a bad ingress could displace a real proposal, or produce commit authority
  // for a workspace descriptor that is a number.
  const controller = new ProjectConfirmationController({
    clock: new VirtualClock(),
    idFactory: () => 'nonce-1',
  })
  const valid = {
    action: 'create' as const,
    workspace_display_name: '研究项目',
    workspace_id: null,
    session_title: null,
    session_id: null,
    work_order: null,
    origin_ref: 'conversation:1',
  }
  const first = controller.prepare(valid)
  assert.equal(controller.pending, true)

  const malformed = [
    {...valid, workspace_display_name: 42 as unknown as string},
    {...valid, workspace_id: 7 as unknown as string},
    {...valid, session_title: 8 as unknown as string},
    {...valid, session_id: 9 as unknown as string},
    {...valid, work_order: 10 as unknown as string},
    {...valid, origin_ref: 11 as unknown as string},
    {...valid, action: 'delete' as unknown as 'create'},
  ]
  for (const input of malformed) {
    assert.throws(() => controller.prepare(input), TypeError, JSON.stringify(input.action))
  }
  // The original proposal is untouched: nothing consumed a nonce or replaced it.
  assert.equal(controller.view.workspace_display_name, first.workspace_display_name)
  assert.equal(controller.pending, true)
})
