// Explicit model capabilities, checked against provider documentation; custom IDs fail closed.
export const VISION_MODELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  qwen: Object.freeze(['qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-max', 'qwen-vl-plus']),
  stepfun: Object.freeze(['step-3.7-flash']),
  ark: Object.freeze(['doubao-seed-2-0-pro-260215']),
})
export function supportsVision(provider: string, model: string): boolean {
  return VISION_MODELS[provider]?.includes(model) === true
}
