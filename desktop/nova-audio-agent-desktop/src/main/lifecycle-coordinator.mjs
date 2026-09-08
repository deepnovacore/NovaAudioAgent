export function createLifecycleCoordinator({ onChange = () => {} } = {}) {
  let owner = null

  return Object.freeze({
    get busy() {
      return owner !== null
    },
    get owner() {
      return owner
    },
    async run(kind, operation) {
      if (owner !== null) return Object.freeze({ status: 'busy' })
      owner = kind
      onChange(Object.freeze({ busy: true, owner }))
      try {
        return Object.freeze({ status: 'completed', value: await operation() })
      } finally {
        owner = null
        onChange(Object.freeze({ busy: false, owner: null }))
      }
    },
  })
}
