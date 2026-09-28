import os from 'node:os'
import {statfs} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec = promisify(execFile)
export const VISOR_DEFAULTS = Object.freeze({enabled:false, mode:'focus', opacity:0.8, motion:true, hardware:true, ai:true})
export function visorPreferences(input = {}) {
  return Object.fromEntries(Object.entries(VISOR_DEFAULTS).map(([key, fallback]) => [key,
    key === 'mode' ? (['focus','showcase'].includes(input[key]) ? input[key] : fallback)
    : key === 'opacity' ? (Number.isFinite(input[key]) ? Math.min(1, Math.max(.3, input[key])) : fallback)
    : typeof input[key] === 'boolean' ? input[key] : fallback]))
}
export function cpuSample(cpus) {
  return cpus.reduce((sum, cpu) => ({idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0})
}
export function cpuPercent(previous, current) {
  const total = current.total - previous.total
  return total > 0 ? Math.max(0, Math.min(100, 100*(1-(current.idle-previous.idle)/total))) : null
}
export function parseBattery(text) {
  const match = text.match(/(\d+)%;\s*([^;\n]+)/)
  return match ? {percent:Math.min(100,Number(match[1])),charging:/charging|charged|AC attached/.test(match[2]) && !/discharging/.test(match[2])} : null
}
export function createHardwareSampler() {
  let previous = cpuSample(os.cpus()), slowAt = 0, disk = null, battery = null
  return async () => {
    const next = cpuSample(os.cpus()), cpu = cpuPercent(previous,next); previous = next
    if (Date.now()-slowAt > 30000) {
      slowAt = Date.now()
      const result = await Promise.allSettled([
        statfs(os.homedir()).then(s=>s.blocks>0 ? 100*(1-s.bavail/s.blocks) : null),
        process.platform === 'darwin' ? exec('/usr/bin/pmset',['-g','batt'],{timeout:1500,maxBuffer:8192}).then(r=>parseBattery(r.stdout)) : Promise.resolve(null),
      ])
      disk = result[0].status === 'fulfilled' ? result[0].value : null
      battery = result[1].status === 'fulfilled' ? result[1].value : null
    }
    return {cpu,memoryUsed:os.totalmem()-os.freemem(),memoryTotal:os.totalmem(),disk,battery,updatedAt:Date.now()}
  }
}
