const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const source = fs.readFileSync(path.resolve(__dirname, '../src/segmenter.ts'), 'utf8')
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const loaded = { exports: {} }
vm.runInNewContext(`(function(module, exports) { ${code}\n})`)(loaded, loaded.exports)

function start() {
  const commits = []
  const segmenter = loaded.exports.createSegmenter({
    commit: (text, langs) => commits.push({ text, langs: Array.from(langs) }),
  })
  return { segmenter, commits }
}

for (const [text, lang] of [['Yes.', 'en'], ['No.', 'en'], ['好的。', 'zh'], ['谢谢', 'zh'], ['Да.', 'ru'], ['はい', 'ja'], ['7', 'en']]) {
  test(`utterance end submits the short reply ${text}`, () => {
    const { segmenter, commits } = start()
    const langs = Array(text.length).fill(lang)
    segmenter.setLive(text, langs)
    assert.equal(commits.length, 0, 'A short revisable draft must still wait for the utterance end')
    segmenter.end(text, langs)
    assert.deepEqual(commits, [{ text, langs }])
    assert.equal(segmenter.getPendingText(), '')
    segmenter.end('', [])
    assert.equal(commits.length, 1, 'An empty endpoint must not repeat the reply')
  })
}

test('stable short replies submit at an empty endpoint and genuine repeated replies survive', () => {
  const { segmenter, commits } = start()
  segmenter.addStable('Yes.', ['en', 'en', 'en', 'en'])
  segmenter.end('', [])
  segmenter.end('Yes.', ['en', 'en', 'en', 'en'])
  assert.deepEqual(commits.map(entry => entry.text), ['Yes.', 'Yes.'])
})

test('an endpoint submits the short tail after a sentence already committed from its draft', () => {
  const { segmenter, commits } = start()
  const text = 'Hello there. Yes.'
  segmenter.setLive(text, Array(text.length).fill('en'))
  assert.deepEqual(commits.map(entry => entry.text), ['Hello there.'])
  segmenter.end(text, Array(text.length).fill('en'))
  assert.deepEqual(commits.map(entry => entry.text), ['Hello there.', 'Yes.'])
})

test('a final sentence keeps a short new reply after peeling its already committed draft prefix', () => {
  const { segmenter, commits } = start()
  segmenter.setLive('Hello there.', Array(12).fill('en'))
  const text = 'Hello there yes.'
  segmenter.end(text, Array(text.length).fill('en'))
  assert.deepEqual(commits.map(entry => entry.text), ['Hello there.', 'yes.'])
  assert.deepEqual(commits[1].langs, ['en', 'en', 'en', 'en'])
})

test('empty and punctuation-only endpoints submit no translation', () => {
  const { segmenter, commits } = start()
  for (const text of ['', '   ', '。！？', ':;—', '…', ' ; ; ; ; ;.']) segmenter.end(text, Array(text.length).fill(undefined))
  assert.deepEqual(commits, [])
  assert.equal(segmenter.getPendingText(), '')
})
