import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const skill = readFileSync(new URL('../skills/ultracode-xmodel-blend/SKILL.md', import.meta.url), 'utf8')
const match = skill.match(/```js\n(async function codexNode[\s\S]*?)\n```/)
assert.ok(match, 'canonical codexNode helper not found in blend SKILL.md')
const load = new Function('agent', `${match[1]}; return codexNode`)

async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

await run('frames schema and arbitrary task text without shell interpolation', async () => {
  const calls = []
  const expected = { refuted: false, reasoning: 'confirmed' }
  const codexNode = load(async (prompt, opts) => {
    calls.push({ prompt, opts })
    return expected
  })
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['refuted', 'reasoning'],
    properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
  }
  const task = 'Verify `$HOME`; keep ---TASK--- and CODEX_TASK_EOF literal.'
  const result = await codexNode(task, {
    schema, model: 'gpt-5.6-sol', cwd: '/tmp/project with spaces',
    effort: 'high', phase: 'Verify', label: 'verify:x',
  })
  assert.deepEqual(result, expected)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.agentType, 'ultracode-xmodel:codex-structured')
  assert.equal(calls[0].opts.schema, schema)
  assert.match(calls[0].prompt, /^MODEL: gpt-5\.6-sol\nEFFORT: high\nDIR: \/tmp\/project with spaces\nSCHEMA_JSON: /)
  assert.ok(calls[0].prompt.endsWith(`---TASK---\n${task}`))
})

await run('supports unnamespaced agents for manual installs', async () => {
  let seen
  const codexNode = load(async (_prompt, opts) => {
    seen = opts.agentType
    return { ok: true }
  })
  const schema = {
    type: 'object', additionalProperties: false, required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  }
  await codexNode('Check this.', { schema, agentPrefix: '' })
  assert.equal(seen, 'codex-structured')
})

await run('rejects empty task before dispatch', async () => {
  let calls = 0
  const codexNode = load(async () => { calls++; return { ok: true } })
  const result = await codexNode('  ', { schema: { type: 'object' } })
  assert.equal(calls, 0)
  assert.equal(result._codex_error, true)
  assert.match(result.error, /taskText/)
})

await run('rejects absent or non-object schema before dispatch', async () => {
  let calls = 0
  const codexNode = load(async () => { calls++; return { ok: true } })
  for (const schema of [undefined, null, [], 'object']) {
    const result = await codexNode('Check this.', { schema })
    assert.equal(result._codex_error, true)
  }
  assert.equal(calls, 0)
})

await run('converts relay or schema-validation throws into infrastructure errors', async () => {
  const codexNode = load(async () => { throw new Error('schema validation failed') })
  const result = await codexNode('Check this.', { schema: { type: 'object' } })
  assert.deepEqual(result, { _codex_error: true, error: 'schema validation failed' })
})

await run('rejects raw wrapper-error text even if the runtime does not throw', async () => {
  const codexNode = load(async () => 'CODEX-WRAPPER-ERROR: auth expired')
  const result = await codexNode('Check this.', { schema: { type: 'object' } })
  assert.deepEqual(result, {
    _codex_error: true,
    error: 'structured relay returned non-object data',
  })
})

if (!process.exitCode) console.log('6/6 blend scenarios passed')
