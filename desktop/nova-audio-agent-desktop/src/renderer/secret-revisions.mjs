// Password input correlation is intentionally kept outside the settings
// controller. It records only a monotonic revision; submitted text is held by
// the caller while it forwards that one write through the bridge.
export function createSecretRevisions(keys) {
  const revisions = new Map(keys.map(key => [key, 0]))

  function noteInput(key) {
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
  }

  function capture(key, value) {
    return { key, value, revision: revisions.get(key) ?? 0 }
  }

  function matches(key, value, submission) {
    return submission.key === key
      && submission.value === value
      && submission.revision === (revisions.get(key) ?? 0)
  }

  return { capture, matches, noteInput }
}
