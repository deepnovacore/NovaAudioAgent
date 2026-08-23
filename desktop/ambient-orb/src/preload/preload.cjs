const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaAudioAgentDesktop', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('nova:bootstrap'),
  onBackendExit: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = () => callback()
    ipcRenderer.on('nova:backend-exit', listener)
    return () => ipcRenderer.removeListener('nova:backend-exit', listener)
  },
  orbMenu: Object.freeze({
    show: () => ipcRenderer.send('nova:orb-menu:show'),
  }),
  releaseCamera: Object.freeze({
    report: result => ipcRenderer.send('nova:release-camera:result', result),
  }),
  memoryBoard: Object.freeze({
    request: () => ipcRenderer.invoke('nova:memory-board:request'),
    export: payload => ipcRenderer.invoke('nova:memory-board:export', payload),
    onFetch: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, requestId) => callback(requestId)
      ipcRenderer.on('nova:memory-board:fetch', listener)
      return () => ipcRenderer.removeListener('nova:memory-board:fetch', listener)
    },
    publish: payload => ipcRenderer.send('nova:memory-board:data', payload),
  }),
  graphBoard: Object.freeze({
    request: () => ipcRenderer.invoke('nova:workspace-graph-board:request'),
    onFetch: callback => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, requestId) => callback(requestId)
      ipcRenderer.on('nova:workspace-graph-board:fetch', listener)
      return () => ipcRenderer.removeListener('nova:workspace-graph-board:fetch', listener)
    },
    publish: payload => ipcRenderer.send('nova:workspace-graph-board:data', payload),
  }),
  nativeAudio: Object.freeze({
    setCaptureEnabled: enabled => ipcRenderer.invoke(
      'nova:native-audio:capture',
      enabled === true,
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
  settings: Object.freeze({
    get: () => ipcRenderer.invoke('nova:settings:get'),
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
