const { app, BrowserWindow, safeStorage } = require('electron')
const { join, resolve, sep } = require('node:path')
const { mkdtempSync, mkdirSync, realpathSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { fileURLToPath } = require('node:url')
const assert = require('node:assert/strict')

// macOS Electron paths do not follow Node's HOME/TMPDIR environment overrides.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'nova-orb-probe-')))
const paths = {}
for (const name of ['home', 'appData', 'userData', 'temp', 'cache', 'logs', 'sessionData', 'crashDumps']) {
  const path = join(fixtureRoot, name)
  mkdirSync(path, { mode: 0o700 })
  app.setPath(name, path)
  paths[name] = app.getPath(name)
  assert.equal(paths[name], path)
}
Object.assign(process.env, { HOME: paths.home, USERPROFILE: paths.home, CODEX_HOME: join(paths.home, '.codex'), TMPDIR: paths.temp })
mkdirSync(process.env.CODEX_HOME, { mode: 0o700 })
const denied = { credentials: 0, network: 0, permissions: 0, windows: 0, navigation: 0 }
const credentialMethods = [], permissionChecks = {}, permissionCheckDetails = []
for (let object = safeStorage; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
  for (const name of Object.getOwnPropertyNames(object)) {
    if (name === 'constructor' || credentialMethods.includes(name) || typeof safeStorage[name] !== 'function') continue
    credentialMethods.push(name)
    Object.defineProperty(safeStorage, name, { value: () => { denied.credentials++; throw Error('credential access forbidden in orb probe') } })
  }
}
assert.ok(credentialMethods.includes('isEncryptionAvailable'))
app.commandLine.appendSwitch('disable-background-networking')
// Test-only: Chromium cookie encryption must not consult the real macOS keychain.
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain')

const WINDOW_SIZE = 160
// Mirrors DORMANT_ORB_WINDOW_SIZE in src/main/window-position.mjs; this probe is
// plain CJS and cannot import the ESM module.
const DORMANT_WINDOW_SIZE = 64
const visualSmoke = process.env.NOVA_ORB_VISUAL_SMOKE === '1'

app.whenReady().then(async () => {
  const { browserWindowOptions } = await import('../src/main/security.mjs')
  const { bubbleWindowLayout } = await import('../src/main/window-position.mjs')
  const window = new BrowserWindow({
    ...browserWindowOptions(join(__dirname, '../src/preload/preload.cjs'), 'layout-probe'),
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    // Same floor as the real orb window: Electron clamps setBounds to these,
    // so a 160 minimum here would silently defeat the dormant measurement.
    minWidth: DORMANT_WINDOW_SIZE,
    minHeight: DORMANT_WINDOW_SIZE,
    resizable: false,
    frame: false,
    show: visualSmoke,
    transparent: true,
    backgroundColor: '#00000000',
  })

  try {
    const session = window.webContents.session
    session.setPermissionCheckHandler((_contents, permission, _origin, details) => {
      permissionChecks[permission] = (permissionChecks[permission] ?? 0) + 1
      permissionCheckDetails.push({ permission, mediaType: details.mediaType ?? null, isMainFrame: details.isMainFrame ?? null })
      return false
    })
    session.setPermissionRequestHandler((_contents, _permission, callback) => { denied.permissions++; callback(false) })
    window.webContents.setWindowOpenHandler(() => { denied.windows++; return { action: 'deny' } })
    window.webContents.on('will-navigate', event => { denied.navigation++; event.preventDefault() })
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let local = false
      try { const path = resolve(fileURLToPath(details.url)); local = ['../src', '../test/fixtures'].some(root => path.startsWith(resolve(__dirname, root) + sep)) } catch { /* Non-file URLs are forbidden. */ }
      if (!local) denied.network++
      callback({ cancel: !local || details.url.endsWith('/renderer/index.mjs') })
    })
    await window.loadFile(join(__dirname, '../src/renderer/index.html'))
    await window.webContents.insertCSS('#orb-rail { opacity: 1 !important; transition: none !important; }')
    const bubbleLayouts = []
    for (const zoomFactor of [1, 1.5]) {
      for (const [x, y, rows = 1] of [[0, 500], [600, 500], [1280, 500], [1280, 0], [1280, 500, 3]]) {
        const layout = bubbleWindowLayout({
          normalBounds: { x, y, width: 160, height: 160 },
          rows, zoomFactor, scaleFactor: 2,
          workArea: { x: 0, y: 0, width: 1440, height: 900 },
        })
        window.webContents.setZoomFactor(zoomFactor)
        window.setBounds(layout.bounds)
        const rendered = await window.webContents.executeJavaScript(`new Promise(resolve => {
          const shell = document.getElementById('shell')
          document.getElementById('codex-label').dataset.mode = 'project'
          document.getElementById('codex-summary').textContent = '工作区 kart-racing-game · Session 任务 2'
          document.getElementById('state-label').textContent = '待命'
          const stack = document.getElementById('bubble-stack')
          stack.dataset.placement = '${layout.bubblePlacement}'
          stack.dataset.alignment = '${layout.bubbleAlignment}'
          stack.innerHTML = '<button class="progress-bubble" data-level="milestone">你好，有什么我可以帮你的吗？</button>'.repeat(${rows})
          shell.dataset.bubbles = 'true'
          shell.style.setProperty('--bubble-orb-x', '${layout.orbOffsetCssX}px')
          shell.style.setProperty('--bubble-orb-y', '${layout.orbOffsetCssY}px')
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            width: innerWidth, height: innerHeight,
            orb: document.getElementById('orb').getBoundingClientRect().toJSON(),
            placement: stack.dataset.placement,
            tail: (() => {
              const style = getComputedStyle(stack, '::before')
              const box = stack.getBoundingClientRect()
              return { content: style.content, x: box.left + parseFloat(style.left),
                bottom: box.bottom - parseFloat(style.bottom) }
            })(),
            surfaces: ['#orb', '#codex-label', '#state-label', '#orb-rail', '.progress-bubble'].map(selector => ({
              selector, ...document.querySelector(selector).getBoundingClientRect().toJSON(),
            })),
          })))
        })`)
        bubbleLayouts.push({ expected: layout.bounds, actual: window.getBounds(), ...rendered })
        if (process.env.NOVA_BUBBLE_SCREENSHOT && zoomFactor === 1 && x === 1280 && y === 500 && rows === 1) {
          const { pathToFileURL } = require('node:url')
          const visualUrl = pathToFileURL(join(__dirname, '../src/renderer/orb-visual.mjs')).href
          await window.webContents.executeJavaScript(`import('${visualUrl}').then(({createOrbVisualSafe}) => createOrbVisualSafe(document.querySelector('.orb-canvas')).setState('idle'))`)
          const background = await window.webContents.insertCSS('body { background: #f8f8f8 !important; }')
          await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 250))')
          require('node:fs').writeFileSync(process.env.NOVA_BUBBLE_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
          await window.webContents.removeInsertedCSS(background)
        }
      }
    }
    window.webContents.setZoomFactor(1)
    window.setSize(WINDOW_SIZE, WINDOW_SIZE)
    const naturalProject = await window.webContents.executeJavaScript(`new Promise(resolve => {
      document.getElementById('shell').removeAttribute('data-bubbles')
      document.getElementById('bubble-stack').replaceChildren()
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(
        Object.fromEntries(['orb', 'orb-rail', 'state-label', 'codex-label'].map(id =>
          [id, document.getElementById(id).getBoundingClientRect().toJSON()]))
      )))
    })`)
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
    // The standby states (muted, disconnected) carry their own softened disc
    // and, for disconnected, an amber label. Those selectors out-specify the
    // high-contrast fallback, which is a cascade fault the stylesheet guard
    // cannot see: it checks that rules exist, not which one wins. Read the
    // resolved styles under both media states instead.
    window.webContents.debugger.attach('1.3')
    const readStandby = async contrast => {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-contrast', value: contrast }],
      })
      return window.webContents.executeJavaScript(`Object.fromEntries(
        ['idle', 'muted', 'disconnected'].map(state => {
          document.getElementById('shell').dataset.state = state
          const orb = getComputedStyle(document.getElementById('orb'))
          const label = getComputedStyle(document.getElementById('state-label'))
          return [state, {
            orbBorderColor: orb.borderTopColor,
            orbBorderWidth: orb.borderTopWidth,
            orbBackground: orb.backgroundColor,
            labelColor: label.color,
          }]
        }),
      )`)
    }
    const standbyStyles = {
      normal: await readStandby('no-preference'),
      highContrast: await readStandby('more'),
    }

    // High contrast hides the particle canvas, so #orb::after is the whole of
    // what the orb shows. Its inset is a fixed margin sized for the 98px box,
    // which resting's 40px box turns into a speck — measure the disc that
    // actually renders in both sizes rather than trusting the rule exists.
    const contrastDiscSizes = await window.webContents.executeJavaScript(`(async () => {
      const shell = document.getElementById('shell')
      const orb = document.getElementById('orb')
      // The box is on a 320ms spring, and getComputedStyle mid-flight returns
      // the in-between value, so every sample has to wait the transition out.
      const settle = () => new Promise(resolve => {
        const done = () => { orb.removeEventListener('transitionend', onEnd); clearTimeout(timer); resolve() }
        const onEnd = event => { if (event.propertyName === 'width') done() }
        orb.addEventListener('transitionend', onEnd)
        const timer = setTimeout(done, 1200)
      })
      const read = () => ({
        box: getComputedStyle(orb).width,
        disc: getComputedStyle(orb, '::after').width,
      })
      shell.dataset.state = 'idle'
      shell.removeAttribute('data-dormant')
      await settle()
      const natural = read()
      const shrunk = settle()
      shell.dataset.dormant = 'true'
      await shrunk
      const resting = read()
      const regrown = settle()
      shell.removeAttribute('data-dormant')
      await regrown
      return { natural, resting }
    })()`)

    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    window.webContents.debugger.detach()
    await window.webContents.executeJavaScript(
      "document.getElementById('shell').removeAttribute('data-state')",
    )

    // Dormancy shrinks the window past the orb's own 98px column. The shell
    // centres its tracks vertically but not horizontally, so without a scoped
    // justify-content that column overflows to the right and parks the bubble
    // off-axis — invisible to any source-level check, so measure it.
    // Resting is a 320ms spring on the orb's real width and height, so both the
    // measurement and the restore have to wait it out: sampling mid-flight
    // reads an in-between size, and leaving it in flight would corrupt the
    // confirmation layout measured next.
    const settleOrbTransform = `new Promise(resolve => {
      const orb = document.getElementById('orb')
      const done = () => { orb.removeEventListener('transitionend', onEnd); clearTimeout(timer); resolve() }
      const onEnd = event => { if (event.propertyName === 'width') done() }
      orb.addEventListener('transitionend', onEnd)
      const timer = setTimeout(done, 1200)
    })`
    window.setBounds({ x: 0, y: 0, width: DORMANT_WINDOW_SIZE, height: DORMANT_WINDOW_SIZE })
    const dormantLayout = await window.webContents.executeJavaScript(`(async () => {
      const shell = document.getElementById('shell')
      // Project mode is the workspace pill's visible state: resting has to hide
      // it like every other sibling, which a list-based rule kept missing.
      document.getElementById('codex-label').dataset.mode = 'project'
      const settled = ${settleOrbTransform}
      shell.dataset.dormant = 'true'
      await settled
      const s = shell.getBoundingClientRect()
      const o = document.getElementById('orb').getBoundingClientRect()
      return {
        shellCenterX: s.x + s.width / 2,
        shellCenterY: s.y + s.height / 2,
        orbCenterX: o.x + o.width / 2,
        orbCenterY: o.y + o.height / 2,
        orbWidth: o.width,
        stateDisplay: getComputedStyle(document.getElementById('state-label')).display,
        indicatorDisplay: getComputedStyle(document.querySelector('.capture-indicator')).display,
        // Every sibling of the disc, so a newly added one cannot quietly hang
        // under the bubble the way the workspace pill did.
        siblingDisplays: Object.fromEntries(
          [...shell.children]
            .filter(child => child.id !== 'orb' && child.id !== 'confirmation-announcement')
            .map(child => [child.id || child.className, getComputedStyle(child).display]),
        ),
      }
    })()`)
    await window.webContents.executeJavaScript(`(async () => {
      const settled = ${settleOrbTransform}
      document.getElementById('shell').removeAttribute('data-dormant')
      document.getElementById('codex-label').dataset.mode = 'hidden'
      await settled
    })()`)
    window.setBounds({ x: 0, y: 0, width: WINDOW_SIZE, height: WINDOW_SIZE })

    // Bubble mode and resting both size and place the orb. The renderer lifts
    // dormancy when bubbles appear, but a stale attribute must not render as a
    // vanished orb: at equal specificity the later rule would otherwise win and
    // draw a 40px disc against coordinates computed for a 98px one.
    const dormantWithBubbles = await window.webContents.executeJavaScript(`new Promise(resolve => {
      const shell = document.getElementById('shell')
      shell.dataset.dormant = 'true'
      shell.dataset.bubbles = 'true'
      shell.style.setProperty('--bubble-orb-x', '80px')
      shell.style.setProperty('--bubble-orb-y', '60px')
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const rect = document.getElementById('orb').getBoundingClientRect()
        // The fixture carries no particle canvas, so this stays null-safe: a
        // throw inside this rAF would leave the promise unresolved and hang
        // the whole probe rather than fail a single assertion.
        const canvas = document.querySelector('.orb-canvas')
        resolve({
          orbWidth: rect.width,
          orbHeight: rect.height,
          canvasTransform: canvas === null ? null : getComputedStyle(canvas).transform,
        })
      }))
    })`)
    await window.webContents.executeJavaScript(`(() => {
      const shell = document.getElementById('shell')
      shell.removeAttribute('data-dormant')
      shell.removeAttribute('data-bubbles')
      shell.style.removeProperty('--bubble-orb-x')
      shell.style.removeProperty('--bubble-orb-y')
    })()`)

    // Use the production four-button rail, not the legacy three-button fixture.
    await window.loadFile(join(__dirname, '../src/renderer/index.html'))
    await window.webContents.insertCSS('#orb-rail { opacity: 1 !important; pointer-events: auto !important; transition: none !important; }')
    const confirmationLayouts = []
    for (const zoomFactor of [1, 1.25, 1.5]) {
      for (const placement of ['below', 'above']) {
      window.webContents.setZoomFactor(zoomFactor)
      window.setSize(Math.ceil(WINDOW_SIZE * zoomFactor), Math.ceil(WINDOW_SIZE * zoomFactor))
      const layout = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const shell = document.getElementById('shell')
        const label = document.getElementById('codex-label')
        const operation = document.getElementById('codex-operation')
        const expiry = document.getElementById('codex-expiry')
        const actions = document.getElementById('codex-confirmation-actions')
        const confirm = document.getElementById('codex-confirm')
        const cancel = document.getElementById('codex-cancel')
        shell.dataset.confirmationPlacement = '${placement}'
        actions.hidden = false
        document.getElementById('mute-toggle').disabled = false
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
            controls: [...document.querySelectorAll('#orb-rail button')].map(button => ({
              id: button.id, ...rect(button),
              hit: document.elementFromPoint(rect(button).left + rect(button).width / 2, rect(button).top + rect(button).height / 2)?.closest('button')?.id,
            })),
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
      confirmationLayouts.push({zoomFactor, placement, ...layout})
      if (process.env.NOVA_CONFIRMATION_SCREENSHOT && zoomFactor === 1 && placement === 'below') {
        require('node:fs').writeFileSync(process.env.NOVA_CONFIRMATION_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      }
      }
    }
    const preferences = window.webContents.getLastWebPreferences()
    const isolation = { fixtureRoot, paths, persistent: session.isPersistent(), credentialMethods, permissionChecks, permissionCheckDetails, denied,
      preferences: { ...Object.fromEntries(['sandbox', 'contextIsolation', 'nodeIntegration', 'webSecurity'].map(key => [key, preferences[key]])),
        backgroundThrottling: window.webContents.getBackgroundThrottling(),
        preloadLoaded: await window.webContents.executeJavaScript("typeof window.novaAudioAgentDesktop?.windowLayout?.setDormant === 'function'") } }
    for (const [name, path] of Object.entries(paths)) assert.equal(app.getPath(name), path)
    assert.deepEqual(denied, { credentials: 0, network: 0, permissions: 0, windows: 0, navigation: 0 })
    await new Promise((resolve, reject) => {
      process.stdout.write(`${JSON.stringify({ isolation, naturalProject, bubbleLayouts, boxShadow, secondaryDisplays, standbyStyles, contrastDiscSizes, dormantLayout, dormantWithBubbles, confirmationLayouts })}\n`, error => error ? reject(error) : resolve())
    })
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
