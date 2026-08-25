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
    process.stdout.write(`${JSON.stringify({ boxShadow, secondaryDisplays })}\n`)
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`)
    app.exit(1)
  }
})
