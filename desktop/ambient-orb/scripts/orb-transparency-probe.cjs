const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

const WINDOW_SIZE = 160
const visualSmoke = process.env.NOVA_ORB_VISUAL_SMOKE === '1'

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    minWidth: WINDOW_SIZE,
    minHeight: WINDOW_SIZE,
    maxWidth: WINDOW_SIZE,
    resizable: false,
    frame: false,
    show: visualSmoke,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      backgroundThrottling: false,
    },
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
      window.setSize(WINDOW_SIZE, Math.max(WINDOW_SIZE, Math.ceil(WINDOW_SIZE * zoomFactor)))
      const layout = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const shell = document.getElementById('shell')
        const label = document.getElementById('codex-label')
        const operation = document.getElementById('codex-operation')
        const expiry = document.getElementById('codex-expiry')
        const actions = document.getElementById('codex-confirmation-actions')
        const confirm = document.getElementById('codex-confirm')
        const cancel = document.getElementById('codex-cancel')
        shell.dataset.confirmationPlacement = 'below'
        label.dataset.mode = 'confirmation'
        operation.textContent = '恢复 “' + '工'.repeat(120) + ' / ' + '任'.repeat(120) + '”'
        expiry.textContent = '90 秒'
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const rect = element => {
            const value = element.getBoundingClientRect()
            return {
              top: value.top,
              right: value.right,
              bottom: value.bottom,
              left: value.left,
              width: value.width,
              height: value.height,
            }
          }
          resolve({
            viewport: {width: innerWidth, height: innerHeight},
            shell: rect(document.getElementById('shell')),
            orb: rect(document.getElementById('orb')),
            state: {
              ...rect(document.getElementById('state-label')),
              display: getComputedStyle(document.getElementById('state-label')).display,
            },
            card: {
              ...rect(label),
              borderRadius: getComputedStyle(label).borderRadius,
            },
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
            actions: rect(actions),
            confirm: rect(confirm),
            cancel: {
              ...rect(cancel),
              color: getComputedStyle(cancel).color,
            },
          })
        }))
      })`)
      confirmationLayouts.push({zoomFactor, ...layout})
    }
    process.stdout.write(`${JSON.stringify({ boxShadow, secondaryDisplays, confirmationLayouts })}\n`)
    if (visualSmoke) {
      window.center()
      window.setAlwaysOnTop(true, 'floating')
      app.focus({ steal: true })
      window.focus()
      return
    }
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`)
    app.exit(1)
  }
})
