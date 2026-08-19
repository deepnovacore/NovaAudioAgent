import { Buffer } from 'node:buffer'
import type { Channel, Memory, MemoryItem } from '../memory.js'

export const MAX_BOARD_MESSAGE_BYTES = 256 * 1024
export const MAX_BOARD_ITEMS_PER_CHANNEL = 50
export const MAX_BOARD_CONTENT_CHARS = 2048
export const MAX_BOARD_SUMMARY_CHARS = 4096

interface BoardItem {
  readonly seq: number
  readonly ts: number
  readonly trust: MemoryItem['trust']
  readonly priority: number
  readonly outcome: MemoryItem['outcome']
  readonly refs: readonly string[]
  readonly content: string
  readonly truncated?: true
}

interface BoardChannel {
  readonly name: string
  summary: string | null
  readonly uncompressed: number
  readonly item_count: number
  items: BoardItem[]
}

export function memoryBoardMessage(requestId: string, memory: Memory): string {
  const channels = [...memory.channels.values()].map(channelView)
  let summariesDropped = false
  while (true) {
    const message = JSON.stringify({type: 'memory.board', request_id: requestId, channels})
    if (Buffer.byteLength(message, 'utf8') <= MAX_BOARD_MESSAGE_BYTES) return message
    const populated = channels.filter(channel => channel.items.length > 0)
    if (populated.length > 0) {
      const largest = populated.reduce((current, candidate) => (
        candidate.items.length > current.items.length ? candidate : current
      ))
      largest.items = largest.items.slice(1)
      continue
    }
    if (!summariesDropped) {
      summariesDropped = true
      for (const channel of channels) channel.summary = null
      continue
    }
    return message
  }
}

function channelView(channel: Channel): BoardChannel {
  return {
    name: channel.name,
    summary: channel.summary === null
      ? null
      : sliceCodePoints(channel.summary, MAX_BOARD_SUMMARY_CHARS),
    uncompressed: channel.uncompressed,
    item_count: channel.items.length,
    items: channel.items.slice(-MAX_BOARD_ITEMS_PER_CHANNEL).map(itemView),
  }
}

function itemView(item: MemoryItem): BoardItem {
  const content = JSON.stringify(item.content)
  const truncated = [...content].length > MAX_BOARD_CONTENT_CHARS
  return {
    seq: item.seq,
    ts: item.ts,
    trust: item.trust,
    priority: item.priority,
    outcome: item.outcome,
    refs: [...item.refs],
    content: sliceCodePoints(content, MAX_BOARD_CONTENT_CHARS),
    ...(truncated ? {truncated: true as const} : {}),
  }
}

function sliceCodePoints(value: string, limit: number): string {
  return [...value].slice(0, limit).join('')
}
