const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')
const source = ts.transpileModule(fs.readFileSync('worker.js', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function relay(fetch) {
  const module = { exports: {} }
  vm.runInNewContext(`(function(module,exports){${source}\n})`, { URL, Response, fetch })(module, module.exports)
  return module.exports.default
}
const model = { name: 'model', url: 'https://provider.invalid/chat/completions', key: 'test-only',
  extraParams: { thinking: { type: 'disabled' }, stream: true }, reasoningEffort: 'low' }
function request(body) {
  return new Request('https://relay.invalid/summary', { method: 'POST', body: JSON.stringify(body) })
}

test('Summary route sends the entire original and selected model as a non-streaming request', async () => {
  const calls = []
  const worker = relay(async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) })
    return Response.json({ choices: [{ message: { content: 'Summary result' } }] })
  })
  const text = 'Earlier discussion\n'.repeat(400) + 'Final decision: launch Friday.'
  const response = await worker.fetch(request({ text, targetLang: 'Chinese (Simplified)', model }))
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, model.url)
  assert.equal(calls[0].body.messages[1].content, text)
  assert.match(calls[0].body.messages[0].content, /Chinese \(Simplified\)/)
  assert.equal(calls[0].body.stream, false)
  assert.equal(calls[0].body.model, 'model')
  assert.equal(calls[0].body.reasoning_effort, 'low')
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' })
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-only')
  assert.equal((await response.json()).choices[0].message.content, 'Summary result')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
})

test('Summary route rejects empty transcript or missing model without contacting a provider', async () => {
  const worker = relay(() => { throw new Error('Must not send invalid requests') })
  assert.equal((await worker.fetch(request({ text: '', targetLang: 'English', model }))).status, 400)
  assert.equal((await worker.fetch(request({ text: 'Transcript', targetLang: 'English' }))).status, 400)
})
