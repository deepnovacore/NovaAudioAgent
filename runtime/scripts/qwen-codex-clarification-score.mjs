const QUESTION_PATTERN = /[?？]|什么|哪(?:个|种|些)?|是否|还是|吗|呢|怎样|如何|请问/u

/** Score one provider turn without retaining its transcript or work-order content. */
export function scoreCodexClarificationTurn(criterion, observation) {
  const failures = []
  const transcript = observation.transcript.trim()
  const projectCalls = observation.toolCalls.filter(call => call.name === 'codex__project')

  if (criterion.expectation === 'dispatch') {
    if (projectCalls.length !== 1) {
      failures.push(`expected exactly one codex__project dispatch, got ${projectCalls.length}`)
    }
    const workOrder = projectCalls[0]?.arguments.work_order
    if (typeof workOrder === 'string') {
      for (const term of criterion.requiredWorkOrderTerms ?? []) {
        if (!workOrder.includes(term)) failures.push(`work_order is missing required term: ${term}`)
      }
    } else if (projectCalls.length > 0) {
      failures.push('codex__project work_order is missing')
    }
    return Object.freeze(failures)
  }

  if (projectCalls.length > 0) failures.push('unexpected codex__project dispatch')
  if (transcript === '') {
    failures.push(criterion.expectation === 'clarify'
      ? 'clarification response is empty'
      : 'response is empty')
  } else if (criterion.expectation === 'clarify' && !QUESTION_PATTERN.test(transcript)) {
    failures.push('clarification response does not contain a question')
  }
  return Object.freeze(failures)
}
