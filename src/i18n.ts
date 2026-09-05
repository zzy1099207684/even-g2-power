// Companion-UI language toggle (English / Chinese). English source strings
// double as lookup keys, so any string missing from the table falls back to
// the English text instead of breaking. The choice is persisted in UiConfig
// (config.ts); this module only holds the live value.

export type UiLang = 'en' | 'zh'

let lang: UiLang = 'en'

export function getUiLang(): UiLang {
  return lang
}

export function setUiLang(next: UiLang): void {
  lang = next
}

// Look up the Chinese string for an English UI text; untranslated keys pass
// through unchanged so a missed entry can never render as "undefined".
export function t(en: string): string {
  if (lang !== 'zh') return en
  return UI_STRINGS_ZH[en] ?? en
}

// t() for strings with interpolated values: the table (and the key) carries
// {name} placeholders, filled here after lookup.
export function tf(en: string, vars: Record<string, string | number>): string {
  let out = t(en)
  for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value))
  return out
}

const UI_STRINGS_ZH: Record<string, string> = {
  'Diagnostics': '诊断日志',
  'Copy all logs': '复制全部日志',
  'Close': '关闭',
  'Recent app activity. No keys, audio or conversation text.': '保留近期运行记录, 不含密钥、录音或对话正文.',
  'Select all below and copy manually.': '已选中日志, 请长按后复制.',
  // Start screen
  'Settings': '设置',
  'History': '历史记录',
  'Model': '模型',
  'Start': '开始',
  'Connecting…': '连接中…',
  'No saved sessions yet.': '还没有保存的会话.',

  // Language sheet
  'Listen for': '收听语言',
  'up to 3': '最多 3 个',
  'Translate to': '翻译成',
  'Up to 3 languages — drop one first.': '最多选 3 种语言, 请先取消一个.',

  // Settings page
  'Back': '返回',
  'Relay URL': '中转地址',
  'Soniox API Key': 'Soniox API 密钥',
  'Your Soniox key': '你的 Soniox 密钥',
  'Keep sessions for (days)': '会话保留天数',
  'Keep at most (sessions)': '最多保留条数',
  'Display': '显示',
  'Clear screen after silence (seconds)': '静音后清屏 (秒)',
  'Translation models': '翻译模型',
  '+ Add': '+ 添加',
  'Save': '保存',
  'No models yet — add the one you want to translate with.': '还没有模型, 先添加一个用来翻译.',
  'No models — open Settings': '没有模型 — 打开设置',
  '(unnamed model)': '(未命名模型)',
  'NAME (shown in the list, e.g. DeepSeek)': '名称 (显示在列表里, 如 DeepSeek)',
  'MODEL ID (pick or type, e.g. deepseek-v4-flash)': '模型 ID (选择或输入, 如 deepseek-v4-flash)',
  'URL (e.g. https://api.deepseek.com/chat/completions)': 'URL (如 https://api.deepseek.com/chat/completions)',
  'API KEY': 'API 密钥',
  'EXTRA PARAMS (optional JSON, e.g. {"thinking":{"type":"disabled"}} to disable thinking)':
    '额外参数 (可选 JSON, 如 {"thinking":{"type":"disabled"}} 关闭思考)',
  'REASONING EFFORT (optional, e.g. low / high / max for GLM-5.3+)': '思考力度 (可选, GLM-5.3+ 可填 low / high / max)',
  'Remove': '删除',
  'Edit': '编辑',
  'Cancel': '取消',
  'OK': '确定',
  'Name': '名称',
  'Model ID': '模型 ID',
  'API Key': 'API 密钥',
  'Extra params (JSON)': '额外参数 (JSON)',
  'Reasoning effort': '思考力度',

  // Running screen
  'Original': '原文',
  'Translation': '译文',
  'Copy original': '复制原文',
  'Copy translation': '复制译文',
  'Copy summary': '复制总结',
  'AI summary': 'AI 总结',
  'Generating AI summary…': '正在生成 AI 总结...',
  'Saving session…': '正在保存会话...',
  'Returning home when ready.': '完成后自动返回首页.',
  'No summary yet.': '暂无总结.',
  'Generate summary': '生成总结',
  'Configure a relay and model in Settings first.': '请先在设置中配置中转地址和模型.',
  'Summary failed. Try again.': '总结生成失败, 请重试.',
  'Summary failed. Transcript saved; retry from History.': '总结生成失败. 原文已保存, 可在历史记录中重试.',
  'Could not save this session.': '本次会话保存失败.',
  'Copied': '已复制',
  'No text to copy': '暂无可复制内容',
  'Copy failed. Try again.': '复制失败, 请重试.',
  'Microphone live': '麦克风开启',
  'Pause': '暂停',
  'Resume': '继续',
  'End': '结束',
  'Tap glasses: toggle layout · swipe: browse history · double-tap: exit':
    '点眼镜: 切换布局 · 滑动: 浏览历史 · 双击: 退出',
  'Microphone live · glasses: original + translation': '麦克风开启 · 眼镜: 原文 + 译文',
  'Microphone live · glasses: translation only': '麦克风开启 · 眼镜: 仅译文',
  'Idle · mic listening, reopens on speech': '空闲 · 麦克风收音, 有声音自动重连',
  'Paused · glasses frozen on the last turn': '已暂停 · 眼镜停留在最后一句',

  // Record detail
  'Delete': '删除',

  // Errors
  'Pick 1 to 3 languages to listen for.': '请选 1 到 3 种要收听的语言.',
  'Configure in Settings': '请在设置里配置',
  'relay URL': '中转地址',
  'Soniox key': 'Soniox 密钥',
  'a model': '模型',
  'a selected model': '已选中的模型',
  'History days must be a whole number of 1 or more.': '会话保留天数必须是 1 以上的整数.',
  'History record cap must be a whole number of 1 or more.': '最多保留条数必须是 1 以上的整数.',
  'Screen clear must be a whole number of {min} seconds or more.': '清屏秒数必须是 {min} 以上的整数.',
  '"{label}": extra params are not valid JSON.': '“{label}” 的额外参数不是合法 JSON.',
  'Extra params must be a JSON object, e.g. {"thinking":{"type":"disabled"}}.':
    '额外参数必须是 JSON 对象, 如 {"thinking":{"type":"disabled"}}.',
  'New model': '新模型',
  'Each model needs a name, model ID, URL, and key — fill it in or remove it.':
    '每个模型都要填名称、模型 ID、URL 和密钥 — 要么填完, 要么删掉.',
  '"{label}": the URL doesn\'t look like a valid http(s) address.': '“{label}” 的 URL 不是有效的 http(s) 地址.',
  "The relay URL doesn't look like a valid http(s) address.": '中转地址不是有效的 http(s) 地址.',
  'Failed to start speech recognition': '语音识别启动失败',
  'Exit failed — double-tap the glasses to exit': '退出失败 — 请双击眼镜退出',
}
