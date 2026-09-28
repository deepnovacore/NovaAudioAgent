const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaAudioAgentDesktop', Object.freeze({
  visor: Object.freeze({
    snapshot:()=>ipcRenderer.invoke('nova:visor:get'),
    configure:patch=>ipcRenderer.invoke('nova:visor:configure',patch),
    report:value=>ipcRenderer.send('nova:visor:state',value),
    onRefresh:callback=>{const listener=()=>callback();ipcRenderer.on('nova:visor:refresh',listener);return ()=>ipcRenderer.removeListener('nova:visor:refresh',listener)},
  }),
  language: process.argv.includes('--nova-language=en') ? 'en' : 'zh-CN',
  wakeWord: Object.freeze({
    sleep: () => ipcRenderer.send('nova:wake-word:sleep'),
    wake: () => ipcRenderer.send('nova:wake-word:wake'),
    report: value => ipcRenderer.send('nova:wake-word:report', value),
    audio: value => ipcRenderer.send('nova:wake-word:audio', value),
    activity: () => ipcRenderer.send('nova:wake-word:activity'),
    retry: () => ipcRenderer.invoke('nova:wake-word:retry'),
    onChanged: callback => {
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('nova:wake-word:changed', listener)
      return () => ipcRenderer.removeListener('nova:wake-word:changed', listener)
    },
  }),
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
  setup: Object.freeze({
    open: () => ipcRenderer.send('nova:setup:open'),
    status: () => ipcRenderer.invoke('nova:setup:status'),
    // The key travels into main for the probe or the save; replies never carry it back.
    testKey: (key, value) => ipcRenderer.invoke('nova:setup:test-key', key, value),
    save: choice => ipcRenderer.invoke('nova:setup:save', choice),
    onChanged: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('nova:setup:changed', listener)
      return () => ipcRenderer.removeListener('nova:setup:changed', listener)
    },
  }),
  orbMenu: Object.freeze({
    show: () => ipcRenderer.send('nova:orb-menu:show'),
    openSettings: () => ipcRenderer.send('nova:settings:open'),
  }),
  releaseCamera: Object.freeze({
    report: result => ipcRenderer.send('nova:release-camera:result', result),
  }),
  camera: Object.freeze({
    listDevices: () => ipcRenderer.invoke('nova:camera:devices'),
    onEnumerate: callback => {
      const listener = async (_event, id) => {
        let devices = []
        try { devices = await callback() } catch {}
        ipcRenderer.send('nova:camera:devices-result', {id, devices})
      }
      ipcRenderer.on('nova:camera:enumerate', listener)
      return () => ipcRenderer.removeListener('nova:camera:enumerate', listener)
    },
    requestPermission: () => ipcRenderer.invoke('nova:camera:permission'),
  }),
  microphone: Object.freeze({
    onToggle: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = () => callback()
      ipcRenderer.on('nova:microphone:toggle', listener)
      return () => ipcRenderer.removeListener('nova:microphone:toggle', listener)
    },
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
    clear: () => ipcRenderer.invoke('nova:memory-board:clear'),
    request: detail => ipcRenderer.invoke(
      'nova:memory-board:request',
      detail === 'full' || (detail && typeof detail === 'object') ? detail : undefined,
    ),
    copyJson: () => ipcRenderer.invoke('nova:memory-board:copy-json'),
    export: () => ipcRenderer.invoke('nova:memory-board:export'),
  }),
  executorResult: Object.freeze({
    open: result => ipcRenderer.invoke('nova:executor-result:open', result),
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
    setDormant: value => {
      if (typeof value !== 'boolean') return false
      ipcRenderer.send('nova:orb:dormant', value)
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
    reserveBubbleArea: (rows, taskRows = 0) => ipcRenderer.invoke(
      'nova:bubbles:reserve', Number.isInteger(rows) && rows >= 0 && rows <= 6 ? rows : -1,
      Number.isInteger(taskRows) && taskRows >= 0 && taskRows <= 5 ? taskRows : -1,
    ),
    onBubbleLayout: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, layout) => callback(layout)
      ipcRenderer.on('nova:bubble-layout', listener)
      return () => ipcRenderer.removeListener('nova:bubble-layout', listener)
    },
  }),
  settings: Object.freeze({
    phoneAction: (action, deviceId) => ipcRenderer.invoke('nova:phone:action', action, deviceId),
    openPairing: () => ipcRenderer.send('nova:pairing:open'),
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
    set: commit => ipcRenderer.invoke('nova:settings:set', commit),
    restart: () => ipcRenderer.invoke('nova:settings:set', {settingsPatch: {}}, true),
    probeCapabilities: payload => ipcRenderer.invoke('nova:capabilities:probe', payload),
    knowledgeAction: payload => ipcRenderer.invoke('nova:knowledge:action', payload),
    onChanged: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('nova:settings:changed', listener)
      return () => ipcRenderer.removeListener('nova:settings:changed', listener)
    },
  }),
}))
