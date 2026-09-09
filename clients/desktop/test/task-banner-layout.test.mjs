import assert from 'node:assert/strict'
import test from 'node:test'
const module = await import('../src/renderer/task-banner-layout.mjs').catch(() => ({}))
test('a suppressed combined reservation does not discard an alert before fallback', async () => {
  assert.equal(typeof module.createTaskAreaReservation, 'function')
  const published = [], reservations = []
  let area
  area = module.createTaskAreaReservation({
    reserve: async rows => {
      reservations.push(rows)
      const layout = {rows, suppressed: rows > 3, bubblePlacement: 'above'}
      area.onNativeLayout(layout)
      return layout
    },
    onLayout: layout => published.push(layout),
  })
  await area.reserveBanner(true)
  published.length = 0
  const result = await area.reserveProgress(1)
  assert.deepEqual(reservations, [3, 4, 1])
  assert.equal(result.bannerSuppressed, true)
  assert.equal(result.suppressed, false)
  assert.equal(published.length, 1)
  assert.equal(published[0].suppressed, false)
  area.onNativeLayout({rows: 1, suppressed: false, bubblePlacement: 'above'})
  assert.equal(published.at(-1).bannerSuppressed, true, 'native drag cannot expose an unreserved card')
  assert.deepEqual(reservations, [3, 4, 1])
  await area.reserveProgress(0)
  assert.equal(published.at(-1).bannerSuppressed, false)
  assert.equal(published.at(-1).rows, 3)
})
