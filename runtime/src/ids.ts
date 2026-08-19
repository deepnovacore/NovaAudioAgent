export interface IdFactory {
  next(namespace: string): string
}

export class MonotonicIdFactory implements IdFactory {
  readonly #sequences = new Map<string, number>()

  next(namespace: string): string {
    const sequence = (this.#sequences.get(namespace) ?? 0) + 1
    this.#sequences.set(namespace, sequence)
    return `${namespace}-${sequence}`
  }
}

export class ScriptedIdFactory implements IdFactory {
  readonly #values: Readonly<Record<string, readonly string[]>>
  readonly #offsets = new Map<string, number>()

  constructor(values: Readonly<Record<string, readonly string[]>>) {
    this.#values = structuredClone(values)
  }

  next(namespace: string): string {
    const offset = this.#offsets.get(namespace) ?? 0
    const value = this.#values[namespace]?.[offset]
    if (value === undefined) throw new Error(`scripted id sequence exhausted: ${namespace}`)
    this.#offsets.set(namespace, offset + 1)
    return value
  }

  assertExhausted(): void {
    const unused = Object.entries(this.#values).flatMap(([namespace, values]) => {
      const remaining = values.length - (this.#offsets.get(namespace) ?? 0)
      return remaining === 0 ? [] : [`${namespace}:${remaining}`]
    })
    if (unused.length > 0) throw new Error(`unused scripted ids: ${unused.join(', ')}`)
  }
}
