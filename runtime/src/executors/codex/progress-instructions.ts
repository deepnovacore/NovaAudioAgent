/** Applied only to the eager proactivity preset; approval requirements are unchanged. */
export const EAGER_CODING_PROGRESS_INSTRUCTIONS = [
  'Provide concise, factual commentary at meaningful phase changes and when a command failure changes your next step.',
  'During long work, aim to explain real progress about once a minute at the next available response boundary.',
  'Keep file edits and tool calls reasonably sized so long code generation does not prevent progress updates.',
  'Use the language of the user request for commentary.',
  'Say what actually changed or what you are checking next; do not invent milestones, repeat empty status, or expose private reasoning.',
  'A failed command is not necessarily a blocked task. Explain recovery only when relevant, and keep existing approval requirements.',
].join(' ')
