/** Interleave bounded evidence groups without letting a large group crowd out its peers. */
export function interleave<T>(groups: Iterable<readonly T[]>, limit: number): T[] {
  const queues = [...groups].map(rows => rows[Symbol.iterator]()), result: T[] = []
  while (result.length < limit) {
    let found = false
    for (const queue of queues) {
      const item = queue.next()
      if (item.done) continue
      found = true; result.push(item.value)
      if (result.length === limit) break
    }
    if (!found) break
  }
  return result
}
