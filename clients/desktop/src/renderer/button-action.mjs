/** Keep existing disabled-state ownership; only pending actions block repeat activation. */
export function onButton(button, action, onError = error => { throw error }) {
  let pending = false
  button.addEventListener('click', async event => {
    if (pending || button.disabled) return
    pending = true
    try {
      const result = action(event)
      if (result?.then) {
        button.setAttribute('aria-busy', 'true')
        await result
      }
    } catch (error) { onError(error) }
    finally { pending = false; button.setAttribute('aria-busy', 'false') }
  })
}
