import type {ExecutorDispatchContext} from './causal-runtime.js'

const CAPABILITIES = new WeakMap<ExecutorDispatchContext, object>()

/** Host-only bridge. Deliberately not exported from the runtime package root. */
export function bindHostExecutorCapability(
  context: ExecutorDispatchContext,
  capability: object,
): void {
  CAPABILITIES.set(context, capability)
}

/** One-shot host-only read. The value never becomes part of a Delegate or JsonValue. */
export function consumeHostExecutorCapability(
  context: ExecutorDispatchContext,
): object | undefined {
  const capability = CAPABILITIES.get(context)
  CAPABILITIES.delete(context)
  return capability
}
