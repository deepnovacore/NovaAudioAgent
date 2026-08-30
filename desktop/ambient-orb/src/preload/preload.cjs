const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaAudioAgentDesktop', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('nova:bootstrap'),
  onBackendExit: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = () => callback()
    ipcRenderer.on('nova:backend-exit', listener)
    return () => ipcRenderer.removeListener('nova:backend-exit', listener)
  },
  onBackendReady: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, connection) => callback(connection)
    ipcRenderer.on('nova:backend-ready', listener)
    return () => ipcRenderer.removeListener('nova:backend-ready', listener)
  },
  onBackendStatus: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('nova:backend-status', listener)
    return () => ipcRenderer.removeListener('nova:backend-status', listener)
  },
  orbMenu: Object.freeze({
    show: () => ipcRenderer.send('nova:orb-menu:show'),
    openSettings: () => ipcRenderer.send('nova:settings:open'),
  }),
  releaseCamera: Object.freeze({
    report: result => ipcRenderer.send('nova:release-camera:result', result),
  }),
  camera: Object.freeze({
    requestPermission: () => ipcRenderer.invoke('nova:camera:permission'),
  }),
  microphone: Object.freeze({
    requestPermission: () => ipcRenderer.invoke('nova:microphone:permission'),
    report: status => ipcRenderer.send('nova:microphone:status', status),
    onRetry: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = () => callback()
      ipcRenderer.on('nova:microphone:retry', listener)
      return () => ipcRenderer.removeListener('nova:microphone:retry', listener)
    },
  }),
  memoryBoard: Object.freeze({
    request: () => ipcRenderer.invoke('nova:memory-board:request'),
    export: () => ipcRenderer.invoke('nova:memory-board:export'),
  }),
  graphBoard: Object.freeze({
    request: () => ipcRenderer.invoke('nova:workspace-graph-board:request'),
  }),
  nativeAudio: Object.freeze({
    setCaptureEnabled: enabled => ipcRenderer.invoke(
      'nova:native-audio:capture',
      enabled === true,
    ),
    setPlaybackMuted: muted => ipcRenderer.invoke(
      'nova:native-audio:playback-muted',
      muted === true,
    ),
    play: (pcm, utteranceId, generationEpoch) => ipcRenderer.send(
      'nova:native-audio:play',
      { pcm, utteranceId, generationEpoch },
    ),
    terminal: (utteranceId, generationEpoch) => ipcRenderer.send(
      'nova:native-audio:terminal',
      { utteranceId, generationEpoch },
    ),
    clear: (utteranceId, generationEpoch) => ipcRenderer.invoke(
      'nova:native-audio:clear',
      utteranceId === undefined && generationEpoch === undefined
        ? null
        : { utteranceId, generationEpoch },
    ),
    onEvent: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('nova:native-audio:event', listener)
      return () => ipcRenderer.removeListener('nova:native-audio:event', listener)
    },
  }),
  windowDrag: Object.freeze({
    start: () => ipcRenderer.send('nova:window-drag:start'),
    move: (dx, dy) => ipcRenderer.send('nova:window-drag:move', { dx, dy }),
    end: () => ipcRenderer.send('nova:window-drag:end'),
  }),
  windowLayout: Object.freeze({
    setConfirmationMode: value => {
      if (typeof value !== 'boolean') return false
      ipcRenderer.send('nova:confirmation-mode', value)
      return true
    },
    onConfirmationPlacement: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, value) => {
        if (value === 'above' || value === 'below') callback(value)
      }
      ipcRenderer.on('nova:confirmation-placement', listener)
      return () => ipcRenderer.removeListener('nova:confirmation-placement', listener)
    },
  }),
  settings: Object.freeze({
    get: () => ipcRenderer.invoke('nova:settings:get'),
    rescanCodex: () => ipcRenderer.invoke('nova:codex:rescan'),
    retryBackend: () => ipcRenderer.invoke('nova:backend:retry'),
    retryMicrophone: () => ipcRenderer.invoke('nova:microphone:retry'),
    repairProjects: root => ipcRenderer.invoke('nova:projects:repair', root),
    openCurrentManagedWorkspace: () => ipcRenderer.invoke('nova:workspaces:open-current'),
    clearCurrentManagedWorkspace: () => ipcRenderer.invoke('nova:workspaces:clear-current'),
    clearAllManagedWorkspaces: () => ipcRenderer.invoke('nova:workspaces:clear-all'),
    // The payload may carry plaintext key values on their way *into* main; the
    // reply never carries any back out.
    set: patch => ipcRenderer.invoke('nova:settings:set', patch),
    onChanged: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('nova:settings:changed', listener)
      return () => ipcRenderer.removeListener('nova:settings:changed', listener)
    },
  }),
}))
