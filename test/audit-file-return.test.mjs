// Verifies audit reviews are returned via run-scoped files (path + byte count),
// not embedded in the workflow result object.
// Usage: node test/audit-file-return.test.mjs
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const SRC = new URL('../skills/ultracode-xmodel/ultracode-xmodel.js', import.meta.url)

function makeRuntime(responder, calls) {
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return responder(prompt, opts)
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      let acc = item
      for (const stage of stages) {
        try { acc = await stage(acc, item, i) } catch { return null }
      }
      return acc
    }))
  return { agent, parallel, pipeline, phase: () => {}, log: () => {},
           budget: { total: null, spent: () => 0, remaining: () => Infinity } }
}

async function runWorkflow(args, responder) {
  const calls = []
  const rt = makeRuntime(responder, calls)
  const body = readFileSync(SRC, 'utf8').replace(/^export /m, '')
  const fn = new Function('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget',
    `return (async () => { ${body} })()`)
  const result = await fn(args, rt.agent, rt.parallel, rt.pipeline, rt.phase, rt.log, rt.budget)
  return { result, calls }
}

const onlyGrok = { config: { auditors: { codex: null } } }

function voiceEntry(item) {
  assert.ok(item && item.audit, 'expected audit map')
  const entries = Object.entries(item.audit)
  assert.equal(entries.length, 1, 'expected exactly one audit voice')
  return entries[0]
}

// Deterministic ~10KB review body (exact UTF-8 byte length 10240).
const TARGET_BYTES = 10 * 1024
const VERDICT = '\nVERDICT: PASS'
const padLen = TARGET_BYTES - Buffer.byteLength(VERDICT, 'utf8')
assert.ok(padLen > 0, 'pad length must be positive')
// Multi-byte UTF-8 (é = 2 bytes) so a JS-string-length count would diverge.
const unit = 'é'
const unitBytes = Buffer.byteLength(unit, 'utf8')
const units = Math.floor(padLen / unitBytes)
const rem = padLen - units * unitBytes
const SOURCE_BODY = unit.repeat(units) + 'x'.repeat(rem) + VERDICT
const SOURCE_BUF = Buffer.from(SOURCE_BODY, 'utf8')
assert.equal(SOURCE_BUF.length, TARGET_BYTES, 'source body must be exactly 10KB')

// --- baseline: path + byte-faithful file return, no embedded body ---
{
  const { result } = await runWorkflow(
    {
      tasks: [{
        id: 'a1-file-return',
        prompt: 'produce a review artifact',
        lane: 'codex-high',
        effort: 'high',
        complexity: 4,
        stakes: 'high',
      }],
    },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) return SOURCE_BODY
      return 'WORK OUTPUT for audit-file-return'
    },
  )

  const item = result.results && result.results[0]
  assert.ok(item, 'expected one result item')
  assert.ok(item.audit && typeof item.audit === 'object', 'expected audit map')

  // Retention marker: run-scoped root is caller-readable and not deleted by workflow.
  assert.equal(typeof result.review_root, 'string')
  assert.ok(isAbsolute(result.review_root), 'review_root must be absolute')
  assert.equal(typeof result.review_retention, 'string')
  assert.ok(result.review_retention.length > 0, 'review_retention must be documented')
  assert.match(result.review_retention, /caller-owned|run-scoped|not delete/i)

  const entries = Object.entries(item.audit)
  assert.ok(entries.length >= 1, 'expected at least one audit voice')

  const seenPaths = new Set()
  for (const [voiceId, entry] of entries) {
    assert.ok(entry && typeof entry === 'object', `audit[${voiceId}] missing`)

    // Reject missing or relative path.
    assert.equal(typeof entry.review_path, 'string', `audit[${voiceId}].review_path missing`)
    assert.ok(entry.review_path.length > 0, `audit[${voiceId}].review_path empty`)
    assert.ok(
      isAbsolute(entry.review_path),
      `audit[${voiceId}].review_path must be absolute, got ${entry.review_path}`,
    )
    assert.ok(entry.review_path.startsWith(result.review_root), 'review_path under review_root')
    assert.ok(!seenPaths.has(entry.review_path), `duplicate review_path for ${voiceId}`)
    seenPaths.add(entry.review_path)

    assert.equal(typeof entry.review_bytes, 'number', `audit[${voiceId}].review_bytes missing`)
    assert.equal(entry.review_bytes, TARGET_BYTES, `audit[${voiceId}].review_bytes mismatch`)

    // Full body must not ride the transport object.
    const embedded = JSON.stringify(entry)
    assert.ok(
      !embedded.includes(SOURCE_BODY.slice(0, 80)),
      `audit[${voiceId}] must not embed the full review body`,
    )

    const dest = readFileSync(entry.review_path)
    assert.equal(dest.length, entry.review_bytes, `file size != review_bytes for ${voiceId}`)
    assert.equal(Buffer.compare(SOURCE_BUF, dest), 0, `byte mismatch for ${voiceId}`)

    // Existing public fields remain.
    assert.equal(typeof entry.verdict, 'string')
    assert.equal(typeof entry.detail, 'string')
    assert.ok(Array.isArray(entry.attempts), 'attempts ledger required')
    assert.ok(entry.attempts.length >= 1, 'at least one attempt')
  }
}

// --- BLOCKER A3: every attempt body is persisted (retry does not erase attempt 1) ---
{
  const ERR_BODY = 'GROK-WRAPPER-ERROR: exit=1\nrelay stderr blob for attempt-1 diagnostics'
  const OK_BODY = 'recovered critique body\nVERDICT: PASS'
  let hits = 0
  const { result } = await runWorkflow(
    {
      tasks: [{
        id: 'a3-retry-persist',
        prompt: 'retry must keep attempt 1',
        lane: 'codex-high',
        effort: 'high',
        complexity: 4,
        stakes: 'low',
      }],
      ...onlyGrok,
    },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        hits++
        if (hits === 1) return ERR_BODY
        return OK_BODY
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'pass')
  assert.equal(entry.retries, 1)
  assert.ok(Array.isArray(entry.attempts))
  assert.equal(entry.attempts.length, 2, 'primary + retry each recorded')

  const a0 = entry.attempts[0]
  const a1 = entry.attempts[1]
  assert.equal(a0.kind, 'primary')
  assert.equal(a0.status, 'transport_error')
  assert.ok(typeof a0.review_path === 'string' && isAbsolute(a0.review_path))
  assert.ok(existsSync(a0.review_path), 'attempt 1 body must be on disk')
  assert.equal(readFileSync(a0.review_path, 'utf8'), ERR_BODY)
  assert.equal(a0.review_bytes, Buffer.byteLength(ERR_BODY, 'utf8'))

  assert.equal(a1.kind, 'retry')
  assert.equal(a1.status, 'pass')
  assert.ok(existsSync(a1.review_path), 'attempt 2 body must be on disk')
  assert.equal(readFileSync(a1.review_path, 'utf8'), OK_BODY)
  // Compatibility primary path is attempt 1 (always persisted first).
  assert.equal(entry.review_path, a0.review_path)
  assert.notEqual(a0.review_path, a1.review_path)
}

// --- WARNING: object envelope body is critique text, not JSON-escaped envelope ---
{
  const CRITIQUE = 'object-envelope critique body with multi-byte é\nVERDICT: PASS'
  const { result } = await runWorkflow(
    {
      tasks: [{
        id: 'a1-envelope-body',
        prompt: 'envelope body fidelity',
        lane: 'codex-high',
        effort: 'high',
        complexity: 4,
        stakes: 'low',
      }],
      ...onlyGrok,
    },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        return { text: CRITIQUE, sessionId: 'sess-body-1', meta: { unused: true } }
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'pass')
  const onDisk = readFileSync(entry.review_path, 'utf8')
  assert.equal(onDisk, CRITIQUE, 'persisted body must be critique text, not JSON envelope')
  assert.ok(!onDisk.includes('"sessionId"'), 'must not JSON-escape the envelope')
  assert.equal(entry.review_bytes, Buffer.byteLength(CRITIQUE, 'utf8'))
}

// --- WARNING: body serialization failure never approves ---
{
  const { result } = await runWorkflow(
    {
      tasks: [{
        id: 'a1-body-serfail',
        prompt: 'circular structured body',
        lane: 'codex-high',
        effort: 'high',
        complexity: 4,
        stakes: 'low',
      }],
      ...onlyGrok,
    },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        const so = { verdict: 'PASS', summary: 'looks fine' }
        so.self = so // circular → JSON.stringify fails
        return { structuredOutput: so }
      }
      return 'WORK OUTPUT'
    },
  )
  const item = result.results[0]
  const [, entry] = voiceEntry(item)
  assert.equal(entry.status, 'transport_error', 'serialization failure is transport_error')
  assert.notEqual(entry.status, 'pass')
  assert.equal(item.approved, false, 'must never approve when body extraction fails')
  assert.ok(entry.attempts.length >= 1)
  assert.ok(
    entry.attempts.some(a => a.body_error || a.status === 'transport_error'),
    'ledger must record the extraction/transport fault',
  )
}

// --- WARNING: worker envelope is unwrapped before auditPrompt (not [object Object]) ---
{
  const MARKER = 'UNIQUE_WORKER_PAYLOAD_42_for_envelope_unwrap'
  const { result, calls } = await runWorkflow(
    {
      tasks: [{
        id: 'a1-worker-envelope',
        prompt: 'worker envelope unwrap',
        lane: 'codex-high',
        effort: 'high',
        complexity: 4,
        stakes: 'low',
      }],
      ...onlyGrok,
    },
    (prompt, opts) => {
      if (/worker/.test(opts.agentType || '')) {
        return { text: MARKER, sessionId: 'worker-sess' }
      }
      if (/auditor/.test(opts.agentType || '')) {
        assert.ok(prompt.includes(MARKER), 'audit prompt must include worker text body')
        assert.ok(!prompt.includes('[object Object]'), 'must not coerce envelope to [object Object]')
        return 'ok\nVERDICT: PASS'
      }
      return 'x'
    },
  )
  assert.equal(result.results[0].approved, true)
  assert.equal(result.results[0].output, MARKER)
  assert.ok(calls.some(c => /auditor/.test(c.opts.agentType || '')))
}

// --- WARNING: worker envelope-form wrapper error is a worker failure ---
{
  const { result, calls } = await runWorkflow(
    {
      tasks: [{
        id: 'a1-worker-wrap-env',
        prompt: 'worker envelope wrapper',
        lane: 'codex-high',
        effort: 'high',
        complexity: 4,
        stakes: 'low',
      }],
      ...onlyGrok,
    },
    (prompt, opts) => {
      if (/worker/.test(opts.agentType || '')) {
        return { text: 'CODEX-WRAPPER-ERROR: exit=1\nstderr' }
      }
      return 'x\nVERDICT: PASS'
    },
  )
  assert.equal(result.results[0].approved, false)
  assert.ok(result.results[0].error)
  assert.equal(calls.filter(c => /auditor/.test(c.opts.agentType || '')).length, 0)
}

console.log('PASS audit-file-return')
