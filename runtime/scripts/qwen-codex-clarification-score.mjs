const QUESTION_PATTERN = /[?？]|什么|哪(?:个|种|些)?|是否|还是|吗|呢|怎样|如何|请问/u

/** Score one provider turn without retaining its transcript or instruction content. */
export function scoreCodexClarificationTurn(criterion, observation) {
  const failures = []
  const transcript = observation.transcript.trim()
  // Spec 08: every coding request is one host `dispatch`; the model never sees executor ops.
  const projectCalls = observation.toolCalls.filter(call => call.name === 'dispatch')

  if ((criterion.expectation === 'dispatch' || criterion.expectation === 'intake')) {
    if (projectCalls.length !== 1) {
      failures.push(`expected exactly one dispatch, got ${projectCalls.length}`)
    }
    const workOrder = projectCalls[0]?.arguments.instruction
    if (typeof workOrder === 'string') {
      for (const term of criterion.requiredWorkOrderTerms ?? []) {
        if (!workOrder.includes(term)) failures.push(`instruction is missing required term: ${term}`)
      }
    } else if (projectCalls.length > 0) {
      failures.push('dispatch instruction is missing')
    }
    return Object.freeze(failures)
  }

  if (projectCalls.length > 0) failures.push('unexpected dispatch')
  if (transcript === '') {
    failures.push(criterion.expectation === 'clarify'
      ? 'clarification response is empty'
      : 'response is empty')
  } else if (criterion.expectation === 'clarify' && !QUESTION_PATTERN.test(transcript)) {
    failures.push('clarification response does not contain a question')
  }
  return Object.freeze(failures)
}
