import {createBrowserAudio} from './audio.mjs'
import {Transcript} from './transcript.mjs'

export function createSession({onStatus = () => {}, onCaption = () => {}, onState = () => {}, onLevel = () => {}, onSettings = () => {}} = {}) {
  const transcript = new Transcript()
  let socket, connectionId, serverId, credential = '', wanted = false, timer, attempts = 0, epoch = 0
  let pendingProject, pendingApproval
  const audio = createBrowserAudio({send, onLevel, onSettings})
  const status = (phase, message) => onStatus({phase, message})
  function clearApprovals() {
    pendingProject = pendingApproval = null
    onState({type: 'project.state', pending_confirmation_id: null})
    // No executor means clear every pending executor card, including sent decisions.
    onState({type: 'executor.approval', pending_approval_id: null})
  }
  function send(payload) {
    if (!connectionId || socket?.readyState !== WebSocket.OPEN) return false
    if (socket.bufferedAmount > 256 * 1024) { socket.close(4008, 'connection overloaded'); return false }
    socket.send(payload instanceof Uint8Array ? payload : JSON.stringify({
      type: 'client.command', request_id: crypto.randomUUID(), connection_id: connectionId,
      payload: {...payload, ...(/^playback\./.test(payload.type) ? {t_render_ms: performance.now()} : {})},
    }))
    return true
  }
  function stop() {
    wanted = false; credential = ''; epoch++; clearTimeout(timer)
    connectionId = null
    const old = socket; socket = null; old?.close()
    audio.stop(); clearApprovals()
    status('idle', '随时开始一段对话')
  }
  function fail(message) { stop(); status('error', message) }
  function connect() {
    if (!wanted) return
    connectionId = null; clearApprovals()
    status('connecting', attempts ? '连接中断，正在重新连接…' : '正在连接 Nova…')
    const endpoint = new URL('/client/v1', location.href)
    endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const current = new WebSocket(endpoint)
    socket = current
    current.binaryType = 'arraybuffer'
    const handshake = setTimeout(() => { if (current === socket && !connectionId) current.close(4000, 'ready timeout') }, 6000)
    let tail = Promise.resolve()
    current.onopen = () => {
      if (socket !== current || !wanted) return
      current.send(JSON.stringify({type:'hello', token:credential, protocol_version:1, media:{transports:['host_pcm_v1']}}))
    }
    current.onmessage = event => {
      tail = tail.then(async () => {
        if (socket !== current || !wanted) return
        if (event.data instanceof ArrayBuffer) {
          if (!connectionId) throw new Error('audio before ready')
          await audio.receive(event.data); return
        }
        if (typeof event.data !== 'string' || event.data.length > 128 * 1024) throw new Error('invalid frame')
        const frame = JSON.parse(event.data)
        if (frame.type === 'client.ready') {
          if (connectionId || frame.protocol_version !== 1 || typeof frame.connection_id !== 'string'
            || typeof frame.server_instance_id !== 'string' || frame.media?.transport !== 'host_pcm_v1'
            || frame.input_audio?.sample_rate !== 16000 || frame.output_audio?.sample_rate !== 24000
            || frame.input_audio?.encoding !== 'pcm_s16le' || frame.output_audio?.encoding !== 'pcm_s16le'
            || frame.input_audio?.channels !== 1 || frame.output_audio?.channels !== 1) {
            fail('服务端音频模式不兼容，请使用 relay 模式。'); return
          }
          if (serverId !== frame.server_instance_id) {
            audio.resetPlayback({serverChanged:true}); transcript.newServer()
          }
          serverId = frame.server_instance_id; connectionId = frame.connection_id
          clearTimeout(handshake); attempts = 0
          status('connected', '已连接，Nova 正在聆听'); return
        }
        if (!connectionId) throw new Error('frame before ready')
        if (frame.type === 'clock.ping') send({type:'clock.pong', ping_id:frame.ping_id, t_render_ms:performance.now()})
        else if (frame.type?.startsWith('playback.')) await audio.control(frame)
        else if (frame.type === 'caption') { if (transcript.receive(frame)) onCaption(transcript.items.map(item => ({...item}))) }
        else if (frame.type === 'client.command_result') {
          if (frame.status !== 'applied') current.close(4008, 'refresh rejected command')
        } else {
          if (frame.type === 'project.state') pendingProject = frame.pending_confirmation_id
          if (frame.type === 'executor.approval') pendingApproval = frame
          onState(frame)
        }
      }).catch(() => { if (current === socket) fail('连接数据或音频处理失败，请重新连接。') })
    }
    current.onerror = () => { /* close supplies a safe, credential-free diagnostic */ }
    current.onclose = event => {
      clearTimeout(handshake)
      if (current !== socket || !wanted) return
      socket = null; connectionId = null; clearApprovals(); audio.resetPlayback()
      if (event.code === 4003) { fail('连接凭证无效或已撤销，请在设置中更新。'); return }
      if (event.code === 4009) { fail('Nova 正被另一客户端使用，请先断开该客户端。'); return }
      if (event.code === 4006) { fail('服务端音频协议不兼容，请使用 relay 模式。'); return }
      if (++attempts > 5) { fail('无法连接服务端，请检查服务是否运行。'); return }
      status('connecting', '连接中断，正在重新连接…')
      timer = setTimeout(connect, Math.min(8000, 500 * 2 ** (attempts - 1)))
    }
  }
  return {
    async start({credential: token, microphoneId} = {}) {
      stop()
      if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token.trim())) { status('error', '请先在设置中填写有效的连接凭证。'); return }
      wanted = true; credential = token.trim(); attempts = 0
      const started = ++epoch
      status('connecting', '正在启用麦克风…')
      try {
        await audio.start({microphoneId})
        if (started === epoch && wanted) connect()
      } catch (error) {
        if (started !== epoch) return
        fail(error?.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器中允许访问。' : '无法启用音频，请检查麦克风及 HTTPS / localhost 访问方式。')
      }
    },
    stop,
    setMuted: value => audio.setMuted(value),
    setVolume: value => audio.setVolume(value),
    decide(control) {
      if (control?.type === 'project.confirmation_decision' && typeof control.confirmed === 'boolean'
        && typeof pendingProject === 'string' && control.proposal_id === pendingProject) {
        const sent = send({type:control.type, proposal_id:pendingProject, confirmed:control.confirmed})
        if (sent) pendingProject = null
        return sent
      }
      if (control?.type === 'executor.approval_decision' && typeof control.approved === 'boolean' && control.scope === undefined
        && typeof pendingApproval?.pending_approval_id === 'string'
        && control.approval_id === pendingApproval.pending_approval_id && control.executor === pendingApproval.executor) {
        const sent = send({type:control.type, executor:pendingApproval.executor, approval_id:control.approval_id, approved:control.approved})
        if (sent) pendingApproval = null
        return sent
      }
      return false
    },
    get active() { return wanted },
  }
}
