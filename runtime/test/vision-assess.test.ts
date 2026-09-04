import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  VISION_ASSESS_SYSTEM,
  VisionMonitorMachine,
  assessVision,
  visionAssessSchema,
  type VisionAssessContext,
  type VisionIdentity,
} from '../src/vision-assess.js'

const identity: VisionIdentity = {request_id: 'vision-1', revision: 4, session_epoch: 9}

function context(overrides: Partial<VisionAssessContext> = {}): VisionAssessContext {
  return {
    request_id: identity.request_id,
    revision: identity.revision,
    session_epoch: identity.session_epoch,
    original_user_text: '如果猫进入沙发区域，紧急提醒我。',
    stillWanted: () => true,
    ...overrides,
  }
}

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: identity.request_id,
    revision: identity.revision,
    kind: 'monitor',
    condition: '猫进入沙发区域',
    urgency: 'urgent',
    urgency_evidence: '紧急提醒我',
    interval_s: null,
    duration_s: null,
    question: null,
    ...overrides,
  }
}

test('strict vision schema accepts the exact assess shape', () => {
  assert.equal(visionAssessSchema.safeParse(raw()).success, true)
})

test('assesses Chinese urgent monitoring only with exact source evidence', () => {
  const result = assessVision(raw(), context())
  assert.equal(result.code, 'monitor')
  if (result.code !== 'monitor') return
  assert.equal(result.assessment.urgency, 'urgent')
  assert.equal(result.recheck(), true)
})

test('urgent evidence must be an exact nonempty substring', () => {
  assert.equal(assessVision(raw({urgency_evidence: '猫进来'}), context()).code, 'unclear')
  assert.equal(assessVision(raw({urgency_evidence: ''}), context()).code, 'unclear')
  assert.equal(assessVision(raw({urgency_evidence: null}), context()).code, 'unclear')
})

test('explicit silence or negative wording cannot become urgent', () => {
  const negative = context({original_user_text: '猫进入区域时不要提醒我，保持静默。'})
  const result = assessVision(raw({urgency_evidence: '不要提醒我'}), negative)
  assert.equal(result.code, 'unclear')
  assert.notEqual(result.code, 'monitor')
})

test('routine monitor defaults interval and duration and keeps urgency non-preemptive', () => {
  const result = assessVision(raw({
    urgency: 'routine', urgency_evidence: null, interval_s: null, duration_s: null,
  }), context())
  assert.equal(result.code, 'monitor')
  if (result.code !== 'monitor') return
  assert.deepEqual(
    {interval_s: result.assessment.interval_s, duration_s: result.assessment.duration_s},
    {interval_s: 2.5, duration_s: 1800},
  )
})

test('explicit interval and duration are accepted only inside bounded ranges', () => {
  const result = assessVision(raw({
    urgency: 'routine', urgency_evidence: null, interval_s: 30, duration_s: 30,
  }), context())
  assert.equal(result.code, 'monitor')
  if (result.code !== 'monitor') return
  assert.equal(result.assessment.interval_s, 30)
  assert.equal(result.assessment.duration_s, 30)
  assert.equal(assessVision(raw({interval_s: 1}), context()).code, 'unclear')
  assert.equal(assessVision(raw({duration_s: 1801}), context()).code, 'unclear')
})

test('condition must be nonempty and bounded', () => {
  assert.equal(assessVision(raw({condition: '   '}), context()).code, 'unclear')
  assert.equal(assessVision(raw({condition: 'x'.repeat(301)}), context()).code, 'unclear')
})

test('stop is a recheckable decision and unclear has exactly one bounded question', () => {
  const stop = assessVision(raw({
    kind: 'stop', condition: null, urgency: null, urgency_evidence: null,
  }), context())
  assert.equal(stop.code, 'stop')
  assert.equal(stop.recheck(), true)
  const unclear = assessVision(raw({
    kind: 'unclear', condition: null, urgency: null, urgency_evidence: null,
    question: '请说明要监控的画面。',
  }), context())
  assert.equal(unclear.code, 'unclear')
  if (unclear.code !== 'unclear') return
  assert.equal(typeof unclear.question, 'string')
  assert.ok(unclear.question.length > 0 && unclear.question.length <= 300)
  assert.equal(unclear.urgency, null)
})

test('ASR punctuation does not forge urgency evidence', () => {
  const source = context({original_user_text: '猫进入沙发区域！！！紧急提醒我。'})
  assert.equal(assessVision(raw({urgency_evidence: '紧急提醒我'}), source).code, 'monitor')
  assert.equal(assessVision(raw({urgency_evidence: '紧急提醒一下'}), source).code, 'unclear')
})

test('stale request, revision, epoch, or desire supersedes the decision', () => {
  assert.equal(assessVision(raw({request_id: 'old'}), context()).code, 'superseded')
  assert.equal(assessVision(raw({revision: 3}), context()).code, 'superseded')
  assert.equal(assessVision(raw(), context({current_session_epoch: () => 10})).code, 'superseded')
  let wanted = true
  const result = assessVision(raw(), context({stillWanted: () => wanted}))
  assert.equal(result.code, 'monitor')
  wanted = false
  assert.equal(result.recheck(), false)
})

test('malformed host context fails closed without attempting an effect', () => {
  const malformed = context({original_user_text: undefined as unknown as string})
  assert.equal(assessVision(raw(), malformed).code, 'no_action')
})

test('single-active monitor reservation is busy before permission and launch', () => {
  const machine = new VisionMonitorMachine()
  assert.equal(machine.reserve(identity).code, 'reserved')
  assert.equal(machine.state, 'permission-pending')
  assert.equal(machine.reserve({...identity, request_id: 'vision-2'}).code, 'busy')
})

test('cancel while permission is pending fences a late grant and duplicate cancel is safe', () => {
  const machine = new VisionMonitorMachine()
  machine.reserve(identity)
  assert.equal(machine.cancel(identity).code, 'cancelled')
  assert.equal(machine.state, 'terminal')
  assert.equal(machine.cancel(identity).code, 'already_cancelled')
  assert.equal(machine.grant(identity).code, 'stale')
})

test('late hit cannot resurrect a cancelled reservation', () => {
  const machine = new VisionMonitorMachine()
  machine.reserve(identity)
  machine.cancel(identity)
  machine.cleanup(identity)
  assert.equal(machine.hit(identity).code, 'stale')
  assert.equal(machine.state, 'idle')
})

test('permission grant activates the exact reservation and terminal cleanup releases the slot', () => {
  const machine = new VisionMonitorMachine()
  machine.reserve(identity)
  assert.equal(machine.grant(identity).code, 'active')
  assert.equal(machine.hit(identity).code, 'hit')
  assert.equal(machine.cancel(identity).code, 'cancelled')
  assert.equal(machine.cleanup(identity).code, 'cleaned')
  assert.equal(machine.state, 'idle')
  assert.equal(machine.reserve({...identity, revision: 5}).code, 'reserved')
})

test('the system prompt defines exact evidence and silence safety', () => {
  assert.match(VISION_ASSESS_SYSTEM, /urgency_evidence/u)
  assert.match(VISION_ASSESS_SYSTEM, /不要提醒|保持静默/u)
})
