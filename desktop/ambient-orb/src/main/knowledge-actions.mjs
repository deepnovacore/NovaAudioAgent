const rejected = () => new Error('knowledge action rejected')

/** Only this main-process admission translates a native picker result into a path. */
export function createKnowledgeActions({request, pick}) {
  return {async run(input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw rejected()
    const exact = keys => Object.keys(input).sort().join(',') === keys.sort().join(',')
    if (input.action === 'status' && exact(['action'])) return request('knowledge.status', {})
    if (input.action === 'remove' || input.action === 'reindex') {
      const reindex = input.action === 'reindex'
      if (!exact(reindex ? ['action', 'id', 'consent'] : ['action', 'id'])
        || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(input.id)
        || reindex && input.consent !== true) throw rejected()
      return request(`knowledge.${input.action}`, {id: input.id, ...(reindex ? {consent: true} : {})})
    }
    if (input.consent !== true) throw rejected()
    if (input.action === 'url' && exact(['action', 'url', 'consent'])) {
      if (typeof input.url !== 'string' || input.url.length > 2048) throw rejected()
      let url
      try {url = new URL(input.url)} catch {throw rejected()}
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw rejected()
      // Network address and content admission belong to the utility's bounded fetcher.
      return request('knowledge.ingest', {kind: 'url', locator: url.href, consent: true})
    }
    if (!['files', 'folder'].includes(input.action) || !exact(['action', 'consent'])) throw rejected()
    const result = await pick(input.action === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'])
    if (result.canceled) return {cancelled: true}
    if (!Array.isArray(result.filePaths) || result.filePaths.length > 100
      || result.filePaths.some(value => typeof value !== 'string' || value.length > 4096)) throw rejected()
    const results = []
    for (const locator of result.filePaths) results.push(await request('knowledge.ingest', {
      kind: input.action === 'folder' ? 'folder' : 'file', locator, consent: true,
    }))
    return {results}
  }}
}
