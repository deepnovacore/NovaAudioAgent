/** Native SDK planner; Nova alone grants authority for each atomic device write. */
import {createAndroidDevice} from './mobile-android.js'
import {execFile} from 'node:child_process'
import {basename} from 'node:path'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {Agent, z, type DeviceAction} from '@midscene/core'
import {actionTapParamSchema, actionScrollParamSchema, type AbstractInterface} from '@midscene/core/device'
import {setLogDirectoryResolver} from '@midscene/shared/logger'

// The SDK writes raw model traffic even with reports disabled. Its public resolver disables these file sinks.
setLogDirectoryResolver(() => '/dev/null')

export interface MobileIosConfig {
  deviceId: string
  deviceType: 'ios' | 'ios-simulator' | 'android'
  wdaUrl: string
  baseUrl: string
  model: string
  modelFamily: string
  apiKey: string
  maxSteps: number
  budgetMs: number
  settleMs?: number
  lockRoot: string
}
export interface MobileIosProgress {
  phase: 'planning' | 'action_pending' | 'action_returned' | 'model_finished'
  steps: number
  actionName?: string
}
interface RunOptions {
  signal: AbortSignal
  approve: (actionName: string, params: unknown) => Promise<boolean>
  progress: (event?: MobileIosProgress) => void
}
const exec = promisify(execFile)
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** AutoGLM emits distance in screenshot pixels; the SDK only rescales locator centers. */
export function logicalSwipeDistance(distance: number, screenshotToLogicalRatio: number): number {
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(screenshotToLogicalRatio)
    || screenshotToLogicalRatio <= 0) throw new Error('needs_user_action')
  return distance / screenshotToLogicalRatio
}

/** Only positively acknowledged ADB refusals are safe to release; transport ambiguity wins over cancellation. */
export function mobileWriteFailure(error: unknown, android: boolean, stopped?: string): string {
  const reason = error instanceof Error ? error.message : ''
  if (android && ['action_failed', 'needs_user_action', 'cancelled', 'invalid_configuration'].includes(reason)) return stopped ?? reason
  return 'cleanup_unknown'
}

export async function runMobileIos(config: MobileIosConfig, instruction: string, options: RunOptions): Promise<{code: string; steps: number}> {
  const controller = new AbortController()
  let code: string | undefined
  let steps = 0
  const stop = (reason: string): never => {
    code ??= reason
    controller.abort()
    throw new Error(code)
  }
  const cancelled = () => { code ??= 'cancelled'; controller.abort() }
  options.signal.addEventListener('abort', cancelled, {once: true})
  if (options.signal.aborted) cancelled()
  const check = () => { if (controller.signal.aborted) throw new Error(code ?? 'cancelled') }
  const timer = setTimeout(() => { code ??= 'timeout'; controller.abort() }, config.budgetMs)
  const emit = (phase: MobileIosProgress['phase'], actionName?: string) => {
    options.progress({phase, steps, ...(actionName ? {actionName} : {})})
  }
  let agent: Agent | undefined
  let configured = false
  try {
    check()
    const settleMs = config.settleMs ?? 4000
    if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 30_000) stop('invalid_configuration')
    const endpoint = new URL(config.wdaUrl)
    const modelEndpoint = new URL(config.baseUrl)
    // ponytail: simulator identity is verifiable locally; physical iOS needs a verified USB/WDA binding first.
    const android = config.deviceType === 'android'
    if ((!android && (config.deviceType !== 'ios-simulator' || process.platform !== 'darwin'
      || !/^[A-Fa-f0-9-]{36}$/u.test(config.deviceId)
      || endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname)
      || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash))
      || modelEndpoint.username || modelEndpoint.password || modelEndpoint.search || modelEndpoint.hash
      || (modelEndpoint.protocol !== 'https:' && !(modelEndpoint.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(modelEndpoint.hostname)))
      || !['auto-glm', 'auto-glm-multilingual'].includes(config.modelFamily)
      || !config.model.trim() || !config.apiKey || !instruction.trim() || instruction.length > 4000
      || !Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1 || config.maxSteps > 100
      || !Number.isSafeInteger(config.budgetMs) || config.budgetMs < 1 || config.budgetMs > 1_800_000) stop('invalid_configuration')
    const adb = android ? await createAndroidDevice(config.deviceId, controller.signal) : undefined
    const ios = android ? undefined : await (async () => {
      const port = Number(endpoint.port || 80)
      const command = async (file: string, args: string[]) => {
        check()
        return (await exec(file, args, {timeout: 5000, signal: controller.signal, maxBuffer: 1024 * 1024})).stdout.trim()
      }
      const listing = record(JSON.parse(await command('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])))
      const devices = Object.values(record(listing.devices)).flatMap(group => Array.isArray(group) ? group as unknown[] : [])
      if (devices.filter(value => { const item = record(value); return item.udid === config.deviceId
        && item.state === 'Booted' && item.isAvailable !== false }).length !== 1) stop('invalid_configuration')
      const identity = async () => {
        const listeners = await command('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'])
        const pids = [...new Set(listeners.split('\n').filter(line => /^p\d+$/u.test(line)).map(line => line.slice(1)))]
        if (pids.length !== 1) stop('invalid_configuration')
        const pid = pids[0]!
        const executable = await command('/bin/ps', ['-p', pid, '-o', 'comm='])
        if (!['WebDriverAgentRunner-Runner', 'WebDriverAgentRunner'].includes(basename(executable))) stop('invalid_configuration')
        const environment = await command('/bin/ps', ['eww', '-p', pid, '-o', 'command='])
        const ids = [...environment.matchAll(/(?:^|\s)SIMULATOR_UDID=([^\s]+)(?=\s|$)/gu)].map(match => match[1])
        if (ids.length !== 1 || ids[0] !== config.deviceId) stop('invalid_configuration')
        return `${pid}:${await command('/bin/ps', ['-p', pid, '-o', 'lstart='])}`
      }
      const initialIdentity = await identity()
      const verify = async () => { check(); if (await identity() !== initialIdentity) stop('invalid_configuration'); check() }
      const read = async (path: string) => {
        await verify()
        const response = await fetch(new URL(path, endpoint), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(config.budgetMs, 30_000))]), redirect: 'error'})
        if (!response.ok) stop('action_failed')
        const data = record(await response.json())
        if (record(data.value).error) stop('action_failed')
        return data
      }
      const status = await read('/status')
      const value = record(status.value)
      const reportedId = value.udid ?? record(value.device).udid
      if (reportedId && reportedId !== config.deviceId) stop('invalid_configuration')
      const sessionId = status.sessionId ?? value.sessionId
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(sessionId)) stop('invalid_configuration')
      // Borrow the verified session without connecting, modifying settings, or installing WDA.
      const sessionPath = `/session/${sessionId as string}`
      const foreground = async () => {
        const bundle = record((await read('/wda/activeAppInfo')).value).bundleId
        if (typeof bundle !== 'string' || !bundle || bundle.length > 300) stop('action_failed')
        return bundle as string
      }
      const capture = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const bundle = await foreground()
          const encoded = (await read(`${sessionPath}/screenshot`)).value
          if (typeof encoded !== 'string' || encoded.length > 40_000_000
            || !/^(?:iVBOR|\/9j\/)/u.test(encoded)) stop('action_failed')
          const image = `data:image/${(encoded as string).startsWith('/9j/') ? 'jpeg' : 'png'};base64,${encoded as string}`
          const rect = record((await read(`${sessionPath}/window/rect`)).value)
          if (![rect.width, rect.height].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) stop('action_failed')
          if (await foreground() === bundle) return {image, bundle, context: JSON.stringify([bundle, rect.width, rect.height])}
          if (attempt < 2) await delay(250, undefined, {signal: controller.signal})
        }
        return stop('screen_changed')
      }
      return {verify, read, capture, sessionPath}
    })()
    const capture = adb ? adb.capture : ios!.capture
    const verify = adb ? adb.verify : ios!.verify
    let latest: Awaited<ReturnType<typeof capture>> | undefined
    let planned: typeof latest
    let size = {width: 0, height: 0}
    const point = (input: unknown): [number, number] => {
      const coordinates = Array.isArray(input) ? input : stop('needs_user_action')
      if (coordinates.length !== 2 || coordinates.some((n, i) => typeof n !== 'number'
        || !Number.isFinite(n) || n < 0 || n >= (i ? size.height : size.width))) stop('needs_user_action')
      return [Math.floor(coordinates[0] as number), Math.floor(coordinates[1] as number)]
    }
    const write = async (name: string, params: unknown, path: string, body: unknown) => {
      try {
        check()
        if (steps >= config.maxSteps) stop('step_limit')
        const baseline = planned
        if (!baseline) stop('screen_changed')
        const fresh = async () => {
          const current = await capture()
          if (current.context !== baseline!.context) {
            stop('screen_changed')
          }
        }
        await fresh()
        emit('action_pending', name)
        const approval = options.approve(name, params)
        // A pending approval must not keep a cancelled run alive.
        const accepted = await new Promise<boolean>((resolve, reject) => {
          const abort = () => reject(new Error(code ?? 'cancelled'))
          controller.signal.addEventListener('abort', abort, {once: true})
          approval.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort)).catch(() => undefined)
          if (controller.signal.aborted) abort()
        })
        check()
        if (!accepted) stop('declined')
        await fresh()
        await verify()
        check()
        steps++
        // Cancellation cannot undo a dispatched action. Await its bounded acknowledgement, including the body.
        let rejected = false
        try {
          if (adb) await adb.perform(name, record(params))
          else {
            const response = await fetch(new URL(`${ios!.sessionPath}${path}`, endpoint), {method: 'POST', redirect: 'error',
              headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
              signal: AbortSignal.timeout(Math.min(config.budgetMs, 30_000))})
            const data = record(await response.json())
            if (!Object.hasOwn(data, 'value')) throw new Error('invalid_wda_acknowledgement')
            rejected = !response.ok || (Boolean(record(data.value).error) || Boolean(data.error))
          }
        } catch (error) {
          code = mobileWriteFailure(error, Boolean(adb), code)
          stop(code)
        }
        if (rejected) stop('action_failed')
        planned = undefined
        emit('action_returned', name)
        check()
      } catch (error) {
        const reason = error instanceof Error ? error.message : ''
        stop(code ?? (['screen_changed', 'needs_user_action', 'invalid_configuration', 'cancelled'].includes(reason) ? reason : 'action_failed'))
      }
    }
    const actions: DeviceAction[] = [
      {name: 'Tap', paramSchema: actionTapParamSchema, call: async (param: unknown) => {
        const [x, y] = point(record(record(param).locate).center)
        await write('Tap', {x, y}, '/wda/tap', {x, y})
      }},
      {name: 'Input', description: 'Type text into the already focused field without clearing it or dismissing the keyboard.',
        paramSchema: z.object({value: z.string().min(1).max(4000)}).strict(), call: async (param: unknown) => {
          const text = record(param).value as string // Already validated by the action schema.
          await write('Type', {text}, '/wda/keys', {value: Array.from(text)})
        }},
      {name: 'AndroidHomeButton', description: 'Press the Home button.', call: async () => {
        await write('Home', {}, '/wda/pressButton', {name: 'home'})
      }},
      {name: 'Scroll', paramSchema: actionScrollParamSchema, call: async (raw: unknown, context) => {
        const param = record(raw)
        if (param.scrollType !== 'singleAction' || typeof param.distance !== 'number' || !Number.isFinite(param.distance)
          || param.distance <= 0 || typeof param.direction !== 'string') stop('needs_user_action')
        const [fromX, fromY] = point(record(param.locate).center)
        const offset = ({down: [0, -1], up: [0, 1], right: [-1, 0], left: [1, 0]} as Record<string, number[]>)[param.direction as string]
        if (!offset) stop('needs_user_action')
        const distance = logicalSwipeDistance(param.distance as number, context?.uiContext?.shrunkShotToLogicalRatio ?? NaN)
        const [toX, toY] = point([fromX + offset![0]! * distance, fromY + offset![1]! * distance])
        await write('Swipe', {fromX, fromY, toX, toY, durationMs: 500}, '/actions', {actions: [{type: 'pointer', id: 'finger1',
          parameters: {pointerType: 'touch'}, actions: [{type: 'pointerMove', duration: 0, x: fromX, y: fromY},
            {type: 'pointerDown', button: 0}, {type: 'pause', duration: 100},
            {type: 'pointerMove', duration: 500, x: toX, y: toY}, {type: 'pointerUp', button: 0}]}]})
      }},
    ]
    if (android) actions.push(
      {name: 'Launch', description: 'Launch an installed Android app by exact package name (for example com.example.app), never a URL or shell command.',
        paramSchema: z.object({uri: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u)}).strict(),
        call: async (param: unknown) => write('Launch', {packageName: record(param).uri}, '', {})},
      {name: 'AndroidBackButton', description: 'Press Android Back.', call: async () => write('Back', {}, '', {})})
    const guarded: AbstractInterface = {interfaceType: android ? 'android' : 'ios',
      size: async () => {
        if (adb) { size = adb.size; return size }
        const value = record((await ios!.read(`${ios!.sessionPath}/window/rect`)).value)
        const parsed = z.object({width: z.number().finite().positive(), height: z.number().finite().positive()}).safeParse(value)
        if (!parsed.success) stop('action_failed')
        size = parsed.data!
        return size
      },
      screenshotBase64: async () => {
        try { latest = await capture(); return latest.image }
        catch (error) { return stop(error instanceof Error && error.message === 'screen_changed' ? 'screen_changed' : 'action_failed') }
      },
      actionSpace: () => actions}
    agent = new Agent(guarded, {modelConfig: {MIDSCENE_MODEL_FAMILY: config.modelFamily, MIDSCENE_MODEL_NAME: config.model,
      MIDSCENE_MODEL_BASE_URL: config.baseUrl, MIDSCENE_MODEL_API_KEY: config.apiKey, MIDSCENE_MODEL_RETRY_COUNT: 0,
      MIDSCENE_MODEL_TIMEOUT: Math.min(config.budgetMs, 60_000)},
    waitAfterAction: settleMs, replanningCycleLimit: config.maxSteps, cache: false,
    generateReport: false, persistExecutionDump: false, autoPrintReportMsg: false})
    let finished = false
    agent.addProgressListener(event => {
      if (event.scope !== 'aiAct') return
      if (event.phase === 'plan_thinking') { planned = latest; emit('planning') }
      if (event.phase === 'complete' && !controller.signal.aborted) finished = true
      if (event.phase === 'failed' && steps >= config.maxSteps) code ??= 'step_limit'
    })
    configured = true
    // Midscene owns visual planning. Nova binds each approved action to the same device/window, not frozen pixels.
    await delay(settleMs, undefined, {signal: controller.signal})
    await agent.aiAct(instruction, {abortSignal: controller.signal, cacheable: false,
      context: android
        ? 'Use only the available actions. Launch requires an exact installed Android package name. Input appends text to the focused field. Never guess package names or execute shell commands.'
        : 'Only Tap, Type into an already focused field, one Swipe, Home, and finish are available. Never launch apps or use other actions.'})
    check()
    const lastTask = agent.dump.executions.at(-1)?.tasks.at(-1)
    finished &&= lastTask?.type === 'Action Space' && lastTask.subType === 'Finished'
      && lastTask.status === 'finished' && !lastTask.error
    if (finished) emit('model_finished')
    return {code: code ?? (finished ? 'model_finished' : 'model_failed'), steps}
  } catch {
    return {code: code ?? (configured ? 'model_failed' : 'invalid_configuration'), steps}
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', cancelled)
    // The guarded interface has no destroy hook: the host owns the existing WDA session.
    await agent?.destroy()
  }
}
