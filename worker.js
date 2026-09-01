// 通用中转: worker 自身不保存任何密钥. 每个用户部署自己的一份,
// 应用在每次请求里带上自己的 Deepgram key 和模型配置 (OpenAI 兼容的
// chat/completions 接口), worker 只负责转发.
// 注意: 本文件只是仓库里的记录, 部署靠手动把内容粘贴到 Cloudflare.

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      // X-Deepgram-Key 是自定义头, GET /deepgram-token 会先触发预检
      'Access-Control-Allow-Headers': 'Content-Type, X-Deepgram-Key',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors })
    }

    // 手机app开麦前, 先拿请求头里的 Deepgram key 换一个30~60秒的临时通行证,
    // 拿着它直连Deepgram. master key 只出现在这一次请求里.
    if (url.pathname === '/deepgram-token' && request.method === 'GET') {
      const key = request.headers.get('X-Deepgram-Key')
      if (!key) {
        return new Response('missing X-Deepgram-Key header', { status: 400, headers: cors })
      }
      const resp = await fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: {
          Authorization: `Token ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl_seconds: 60 }),
      })
      const data = await resp.text()
      return new Response(data, {
        status: resp.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // app把识别出的一段文字(+可选的已定稿前文 +模型配置)发过来, 原样转发到
    // 用户配置的模型接口, 流式响应原样传回. 模型接口必须是 OpenAI 兼容的
    // /chat/completions 形状.
    if (url.pathname === '/translate' && request.method === 'POST') {
      const { text, targetLang, context, model } = await request.json()
      if (!model?.url || !model?.name || !model?.key) {
        return new Response('missing model { url, name, key } in body', { status: 400, headers: cors })
      }
      let upstream_url
      try {
        upstream_url = new URL(model.url)
      } catch {
        return new Response('model.url is not a valid URL', { status: 400, headers: cors })
      }
      if (upstream_url.protocol !== 'https:' && upstream_url.protocol !== 'http:') {
        return new Response('model.url must be http(s)', { status: 400, headers: cors })
      }

      // 顺序有讲究: 指令在前(每次请求完全一致, 命中前缀缓存),
      // 前文在后(切段时才变). 前文只许参考, 禁止翻译复述, 输出才不会膨胀.
      const system = [
        'You are a real-time speech translator powering live captions.',
        "The user's text comes from automatic speech recognition: it may be missing punctuation and contain recognition errors. Interpret it tolerantly and translate what the speaker most plausibly meant.",
        `Translate the user's text into ${targetLang} for someone following a live conversation: natural, fluent, conversational phrasing. Translate the meaning, not word-for-word.`,
        'Keep your phrasing deterministic: never offer alternatives, notes, or explanations.',
        context
          ? `Already said (for reference only — use it to resolve pronouns and ellipsis; NEVER translate, repeat, or continue it):\n${context}`
          : '',
      ].filter(Boolean).join('\n')

      // 模型配置里的 extraParams (厂商专属参数, 例如 DeepSeek/GLM 的
      // {"thinking":{"type":"disabled"}}) 原样合并进请求体; 标准字段最后
      // 写, 用户的参数覆盖不了它们. 形状不对时整个忽略, 请求照发.
      const extra =
        model.extraParams && typeof model.extraParams === 'object' && !Array.isArray(model.extraParams)
          ? model.extraParams
          : {}
      const upstream = await fetch(upstream_url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${model.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...extra,
          // 模型卡上单独填的 effort 口, 写在 extra 之后 → 覆盖 extraParams
          // 里的同名参数; 留空或形状不对时不发.
          ...(typeof model.reasoningEffort === 'string' && model.reasoningEffort
            ? { reasoning_effort: model.reasoningEffort }
            : {}),
          model: model.name,
          stream: true,
          temperature: 0.1,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
        }),
      })
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'text/event-stream' },
      })
    }

    return new Response('not found', { status: 404, headers: cors })
  },
}
