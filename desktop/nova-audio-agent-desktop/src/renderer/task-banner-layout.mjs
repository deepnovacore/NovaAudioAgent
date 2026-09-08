/** One native reservation for the card and independent alerts; never publish interim suppression. */
export function createTaskAreaReservation({reserve, onLayout}) {
  let banner = false, progressRows = 0, reserving = false, bannerSuppressed = false, queue = Promise.resolve()
  function request() {
    const result = queue.then(async () => {
      reserving = true
      try {
        const rows = (banner ? 3 : 0) + progressRows
        let layout = await reserve(rows)
        bannerSuppressed = false
        if (layout?.suppressed && banner && progressRows > 0) {
          layout = await reserve(progressRows)
          bannerSuppressed = true
        }
        const value = {...layout, rows: layout?.rows ?? rows, bannerOffsetRows: progressRows, bannerSuppressed}
        onLayout(value)
        return value
      } finally { reserving = false }
    })
    queue = result.catch(() => {})
    return result
  }
  return Object.freeze({
    reserveBanner(active) { banner = active; return request() },
    reserveProgress(rows) { progressRows = rows; return request() },
    onNativeLayout(layout) {
      if (reserving) return
      if (layout?.suppressed && banner && progressRows > 0) {
        void request().catch(() => {})
        return
      }
      onLayout({...layout, bannerOffsetRows: progressRows, bannerSuppressed})
    },
  })
}
