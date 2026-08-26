const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

const WINDOW_SIZE = 184

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    frame: false,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
  })

  try {
    await window.loadFile(join(__dirname, '../test/fixtures/orb-transparency.html'))
    const boxShadow = await window.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('#orb')).boxShadow",
    )
    const secondaryDisplays = await window.webContents.executeJavaScript(`Object.fromEntries(
      ['codex-label', 'aec-label', 'caption'].map(id => [
        id,
        getComputedStyle(document.getElementById(id)).display,
      ]),
    )`)
    const confirmationLayouts = []
    for (const zoomFactor of [1, 1.25, 1.5]) {
      window.webContents.setZoomFactor(zoomFactor)
      const layout = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const label = document.getElementById('codex-label')
        const operation = document.getElementById('codex-operation')
        const expiry = document.getElementById('codex-expiry')
        label.dataset.visible = 'true'
        operation.textContent = '恢复 “' + '工'.repeat(120) + ' / ' + '任'.repeat(120) + '”'
        expiry.textContent = '尚未执行 · 90 秒后自动取消'
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const rect = element => {
            const value = element.getBoundingClientRect()
            return {top: value.top, right: value.right, bottom: value.bottom, left: value.left}
          }
          resolve({
            viewport: {width: innerWidth, height: innerHeight},
            shell: rect(document.getElementById('shell')),
            orb: rect(document.getElementById('orb')),
            state: rect(document.getElementById('state-label')),
            card: rect(label),
            operation: {
              ...rect(operation),
              clientWidth: operation.clientWidth,
              scrollWidth: operation.scrollWidth,
            },
            expiry: {
              ...rect(expiry),
              clientWidth: expiry.clientWidth,
              scrollWidth: expiry.scrollWidth,
            },
          })
        }))
      })`)
      confirmationLayouts.push({zoomFactor, ...layout})
    }
    process.stdout.write(`${JSON.stringify({ boxShadow, secondaryDisplays, confirmationLayouts })}\n`)
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`)
    app.exit(1)
  }
})
