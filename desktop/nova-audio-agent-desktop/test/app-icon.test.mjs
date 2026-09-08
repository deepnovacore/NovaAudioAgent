import assert from 'node:assert/strict'
import test from 'node:test'

import {configureDevelopmentDockIcon} from '../src/main/app-icon.mjs'

function appHarness({isPackaged = false} = {}) {
  const icons = []
  return {
    app: {
      isPackaged,
      dock: {
        setIcon(icon) {
          icons.push(icon)
        },
      },
    },
    icons,
  }
}

test('macOS source launch installs the branded Dock icon', () => {
  const {app, icons} = appHarness()

  configureDevelopmentDockIcon({
    app,
    platform: 'darwin',
    iconFile: '/repo/resources/icon-source/1024x1024.png',
  })

  assert.deepEqual(icons, ['/repo/resources/icon-source/1024x1024.png'])
})

test('packaged macOS launch leaves the bundle-owned Dock icon untouched', () => {
  const {app, icons} = appHarness({isPackaged: true})

  configureDevelopmentDockIcon({
    app,
    platform: 'darwin',
    iconFile: '/repo/resources/icon-source/1024x1024.png',
  })

  assert.deepEqual(icons, [])
})

test('non-macOS source launch does not access the Dock API', () => {
  const app = {isPackaged: false}

  assert.doesNotThrow(() => configureDevelopmentDockIcon({
    app,
    platform: 'win32',
    iconFile: '/repo/resources/icon-source/1024x1024.png',
  }))
})
