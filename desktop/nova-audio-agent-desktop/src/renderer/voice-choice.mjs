export const CUSTOM_VOICE_VALUE = '__custom__'

export const QWEN_VOICES = Object.freeze([
  Object.freeze({ value: 'longanqian', label: 'Longan Qian（默认）' }),
  Object.freeze({ value: 'longanlingxin', label: 'Longan Lingxin' }),
  Object.freeze({ value: 'longanlingxi', label: 'Longan Lingxi' }),
  Object.freeze({ value: 'longanxiaoxin', label: 'Longan Xiaoxin' }),
  Object.freeze({ value: 'longanlufeng', label: 'Longan Lufeng' }),
])

export const VOLCENGINE_TTS_VOICES = Object.freeze([
  Object.freeze({ value: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0（默认）' }),
  Object.freeze({ value: 'zh_female_tianmeitaozi_mars_bigtts', label: '甜美桃子' }),
  Object.freeze({ value: 'zh_male_wenrouxiaoge_mars_bigtts', label: '温柔小哥' }),
  Object.freeze({ value: 'en_female_amanda_mars_bigtts', label: 'Amanda（英语）' }),
  Object.freeze({ value: 'en_male_jackson_mars_bigtts', label: 'Jackson（英语）' }),
])

export function resolveVoiceChoice(value, presets) {
  const voice = typeof value === 'string' ? value : ''
  if (voice && presets.some(preset => preset.value === voice)) {
    return { selected: voice, custom: '' }
  }
  return { selected: CUSTOM_VOICE_VALUE, custom: voice }
}
