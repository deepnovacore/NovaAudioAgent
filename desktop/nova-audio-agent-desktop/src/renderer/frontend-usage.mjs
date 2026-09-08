const services = {realtime:'实时语音',llm:'文本模型',asr:'语音识别',tts:'语音合成'}
const fields = {inputTokens:'输入 tokens',outputTokens:'输出 tokens',inputTextTokens:'输入文本 tokens',inputAudioTokens:'输入音频 tokens',outputTextTokens:'输出文本 tokens',outputAudioTokens:'输出音频 tokens',cachedTokens:'缓存命中 tokens',reasoningTokens:'推理 tokens',characters:'计费字符'}
const money = value => value > 0 && value < 0.0001 ? '< ¥0.0001' : `¥${value.toFixed(4)}`
export function frontendUsageText(view) {
  if (!view?.requests) return '本次运行前台估算费用：暂无用量报告'
  const partial = view.truncated || view.missingReports || view.unpricedReports
  const total = view.pricedReports ? `${money(view.costCny)}${partial ? '（部分费用）' : ''}` : '暂不可估算'
  const lines = [`本次运行前台估算费用：${total}`, `已报告 ${view.requests} 次；缺失用量 ${view.missingReports} 次；未配置价格 / 计费信息不足 ${view.unpricedReports} 次。`]
  if (view.truncated) lines.push('已达统计容量上限，部分用量未计入；退出并重新打开应用可重新统计。')
  for (const row of view.rows) {
    const counts = Object.entries(fields).filter(([key]) => row[key] !== undefined).map(([key,label]) => `${label} ${row[key].toLocaleString('zh-CN')}`)
    if (row.audioDurationMs !== undefined) counts.push(`音频 ${(row.audioDurationMs/1000).toFixed(3)} 秒`)
    lines.push(`${services[row.service]} · ${row.provider} / ${row.model} · ${row.pricingRegion}：${row.pricedReports ? money(row.costCny) : '未配置价格 / 用量不足'}${row.missingReports || row.unpricedReports ? '（不完整）' : ''}\n${counts.join('；') || '未返回计费用量'}`)
  }
  lines.push(`按 ${view.priceDate} 官方按量原价估算，不含优惠、套餐及 Codex 执行费用；仅汇总已收到的前台用量报告。退出桌面应用后清零。`)
  for (const source of new Set(view.rows.map(row => row.source).filter(Boolean))) lines.push(`价格来源：${source}`)
  return lines.join('\n\n')
}
