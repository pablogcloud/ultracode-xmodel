// Four-state audit contract: pass / defect / no_verdict / transport_error,
// with bounded transport retry and same-session verdict re-ask.
// Usage: node test/audit-status.test.mjs
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

const auditCalls = calls => calls.filter(c => /auditor/.test(c.opts.agentType || ''))
const isReask = c => /:reask$/.test(c.opts.label || '') || /missing a final machine-parseable verdict/i.test(c.prompt || '')
const isRetry = c => /:retry$/.test(c.opts.label || '')

const baseTask = (id, extra = {}) => ({
  id,
  prompt: `do ${id}`,
  lane: 'codex-high',
  effort: 'high',
  complexity: 4,
  stakes: 'low',
  ...extra,
})

// Single-voice config so status assertions stay deterministic.
// codex-high work → only the grok auditor remains after dropping codex.
const onlyGrok = { config: { auditors: { codex: null } } }

function voiceEntry(item) {
  assert.ok(item && item.audit, 'expected audit map')
  const entries = Object.entries(item.audit)
  assert.equal(entries.length, 1, 'expected exactly one audit voice')
  return entries[0]
}

// --- 1. pass ---
{
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-pass')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) return 'critique ok\nVERDICT: PASS'
      return 'WORK OUTPUT'
    },
  )
  const [id, entry] = voiceEntry(result.results[0])
  assert.equal(id, 'grok')
  assert.equal(entry.status, 'pass')
  assert.equal(entry.verdict, 'PASS')
  assert.equal(entry.retries, 0)
  assert.equal(entry.reasks, 0)
  assert.equal(result.results[0].approved, true)
  assert.equal(auditCalls(calls).length, 1)
  assert.ok(Array.isArray(entry.attempts))
  assert.equal(entry.attempts.length, 1)
}

// --- 2. defect (no retry, no re-ask) ---
{
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-defect')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) return 'found bug\nVERDICT: DEFECT — race on close'
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'defect')
  assert.equal(entry.verdict, 'DEFECT')
  assert.match(entry.detail, /race on close/)
  assert.equal(entry.retries, 0)
  assert.equal(entry.reasks, 0)
  assert.equal(result.results[0].approved, false)
  assert.equal(auditCalls(calls).length, 1, 'defect must not retry or re-ask')
}

// --- 3. no_verdict → same-session re-ask; still missing stays non-PASS ---
{
  let reaskSawSession = null
  let reaskPrompt = null
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-noverdict')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        if (isReask({ prompt, opts })) {
          reaskSawSession = opts.sessionId
          reaskPrompt = prompt
          // Still no parseable verdict after the re-ask.
          return 'I already explained the issues above.'
        }
        return {
          text: 'The worker asserts VERDICT: PASS here, but examining the edge case I',
          sessionId: 'sess-noverdict-1',
        }
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'no_verdict')
  assert.equal(entry.verdict, 'NO-VERDICT')
  assert.equal(entry.retries, 0)
  assert.equal(entry.reasks, 1)
  assert.equal(reaskSawSession, 'sess-noverdict-1', 're-ask must reuse the same session identity')
  assert.equal(entry.session_id, 'sess-noverdict-1')
  assert.equal(typeof entry.reask_path, 'string')
  assert.ok(isAbsolute(entry.reask_path), 'reask_path must be absolute')
  assert.ok(existsSync(entry.reask_path), 'reask artifact file must exist')
  assert.equal(typeof entry.reask_bytes, 'number')
  assert.ok(entry.reask_bytes > 0)
  assert.equal(result.results[0].approved, false)
  assert.match(reaskPrompt, /finalization of the already-inspected review/i)
  assert.match(reaskPrompt, /missing a final machine-parseable verdict/i)
  const a = auditCalls(calls)
  assert.equal(a.length, 2, 'primary + one re-ask')
  assert.equal(a.filter(isReask).length, 1)
  assert.equal(a.filter(isRetry).length, 0)
  assert.equal(entry.attempts.length, 2)
  assert.equal(entry.attempts[1].kind, 'reask')
  assert.ok(existsSync(entry.attempts[0].review_path))
  assert.ok(existsSync(entry.attempts[1].review_path))
}

// --- 4. no_verdict re-ask can recover a PASS on the same session ---
{
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-reask-pass')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        if (isReask({ prompt, opts })) {
          assert.equal(opts.sessionId, 'sess-recover')
          return 'VERDICT: PASS'
        }
        return { text: 'lengthy critique without a closing line', sessionId: 'sess-recover' }
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'pass')
  assert.equal(entry.verdict, 'PASS')
  assert.equal(entry.reasks, 1)
  assert.equal(entry.retries, 0)
  assert.equal(result.results[0].approved, true)
  assert.equal(auditCalls(calls).filter(isReask).length, 1)
}

// --- 5. transport_error → exactly one automatic retry ---
{
  let transportHits = 0
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-transport-recover')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        transportHits++
        if (transportHits === 1) return 'CODEX-WRAPPER-ERROR: exit=1\nbad relay'
        return 'recovered critique\nVERDICT: PASS'
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'pass')
  assert.equal(entry.verdict, 'PASS')
  assert.equal(entry.retries, 1)
  assert.equal(entry.reasks, 0)
  assert.equal(result.results[0].approved, true)
  const a = auditCalls(calls)
  assert.equal(a.length, 2)
  assert.equal(a.filter(isRetry).length, 1)
  assert.equal(transportHits, 2)
  // A3: both attempt bodies persisted.
  assert.equal(entry.attempts.length, 2)
  assert.ok(existsSync(entry.attempts[0].review_path))
  assert.ok(existsSync(entry.attempts[1].review_path))
  assert.match(readFileSync(entry.attempts[0].review_path, 'utf8'), /WRAPPER-ERROR/)
  assert.match(readFileSync(entry.attempts[1].review_path, 'utf8'), /VERDICT: PASS/)
}

// --- 6. transport_error retry exhaustion stays transport_error / non-PASS ---
{
  let transportHits = 0
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-transport-exhaust')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        transportHits++
        return 'GROK-WRAPPER-ERROR: timeout after 600s'
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'transport_error')
  assert.equal(entry.verdict, 'ERROR')
  assert.equal(entry.retries, 1, 'exactly one retry then stop')
  assert.equal(entry.reasks, 0)
  assert.equal(result.results[0].approved, false)
  assert.equal(transportHits, 2, 'primary + one retry only')
  assert.equal(auditCalls(calls).length, 2)
  assert.equal(auditCalls(calls).filter(isRetry).length, 1)
  assert.equal(auditCalls(calls).filter(isReask).length, 0)
}

// --- 7. empty auditor body is transport_error (not no_verdict) ---
{
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-empty')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) return '   \n'
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'transport_error')
  assert.equal(entry.verdict, 'ERROR')
  assert.equal(entry.retries, 1)
  assert.equal(result.results[0].approved, false)
  // Exhausted after retry of empty body.
  assert.equal(auditCalls(calls).length, 2)
}

// --- 8. mixed-panel aggregation: defect blocks approval even if other voice passes ---
{
  const { result, calls } = await runWorkflow(
    {
      tasks: [baseTask('st-mixed', { complexity: 5, stakes: 'high' })],
    },
    (prompt, opts) => {
      if (/grok-auditor/.test(opts.agentType || '')) return 'x\nVERDICT: PASS'
      if (/codex-auditor/.test(opts.agentType || '')) return 'x\nVERDICT: DEFECT — bad null check'
      return 'WORK OUTPUT'
    },
  )
  const item = result.results[0]
  assert.equal(item.audit.grok.status, 'pass')
  assert.equal(item.audit.codex.status, 'defect')
  assert.equal(item.approved, false, 'approved only when every status is pass')
  // No retries/reasks for clean pass/defect outcomes.
  assert.equal(item.audit.grok.retries, 0)
  assert.equal(item.audit.codex.retries, 0)
  assert.equal(auditCalls(calls).length, 2)
}

// --- 9. mixed panel with transport_error is not approved ---
{
  const { result } = await runWorkflow(
    {
      tasks: [baseTask('st-mixed-te', { complexity: 5, stakes: 'high' })],
    },
    (prompt, opts) => {
      if (/grok-auditor/.test(opts.agentType || '')) return 'x\nVERDICT: PASS'
      if (/codex-auditor/.test(opts.agentType || '')) return 'CODEX-WRAPPER-ERROR: boom'
      return 'WORK OUTPUT'
    },
  )
  const item = result.results[0]
  assert.equal(item.audit.grok.status, 'pass')
  assert.equal(item.audit.codex.status, 'transport_error')
  assert.equal(item.audit.codex.retries, 1)
  assert.equal(item.approved, false)
}

// --- 10. both voices pass → approved true (compatibility projection) ---
{
  const { result } = await runWorkflow(
    {
      tasks: [baseTask('st-panel-pass', { complexity: 5, stakes: 'high' })],
    },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) return 'ok\nVERDICT: PASS'
      return 'WORK OUTPUT'
    },
  )
  const item = result.results[0]
  assert.equal(item.audit.grok.status, 'pass')
  assert.equal(item.audit.codex.status, 'pass')
  assert.equal(item.approved, true)
}

// --- 11. no_verdict without real session does NOT re-ask (no synthetic session) ---
{
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-distinct')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        // Plain string: no relay session identity → remain no_verdict, no re-ask.
        return 'Tokens used: 999\nModel: grok-4.5'
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'no_verdict')
  assert.notEqual(entry.status, 'transport_error')
  assert.equal(entry.reasks, 0, 'no re-ask without a real relay session')
  assert.equal(entry.retries, 0)
  assert.equal(auditCalls(calls).filter(isReask).length, 0)
  assert.equal(result.results[0].approved, false)
}

// --- 12. BLOCKER: thrown auditor dispatch is retried inside the state machine ---
{
  let hits = 0
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-throw-retry')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        hits++
        if (hits === 1) throw new Error('spawn ENOENT: grok-relay missing')
        return 'recovered after throw\nVERDICT: PASS'
      }
      return 'WORK OUTPUT'
    },
  )
  const item = result.results[0]
  assert.ok(item, 'item must not be dropped by parallel null collapse')
  const [, entry] = voiceEntry(item)
  assert.equal(entry.status, 'pass')
  assert.equal(entry.retries, 1, 'thrown dispatch must get one automatic retry')
  assert.equal(entry.reasks, 0)
  assert.equal(item.approved, true)
  assert.equal(hits, 2)
  assert.equal(auditCalls(calls).filter(isRetry).length, 1)
  assert.equal(entry.attempts.length, 2)
  assert.equal(entry.attempts[0].status, 'transport_error')
  assert.match(entry.attempts[0].detail, /ENOENT|dispatch/i)
  assert.ok(existsSync(entry.attempts[0].review_path), 'thrown attempt has durable evidence')
  assert.ok(entry.attempts[0].review_bytes > 0)
  assert.match(readFileSync(entry.attempts[0].review_path, 'utf8'), /ENOENT|DISPATCH-ERROR/)
}

// --- 13. thrown dispatch exhausted still keeps error identity (not empty synthetic) ---
{
  let hits = 0
  const { result } = await runWorkflow(
    { tasks: [baseTask('st-throw-exhaust')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        hits++
        throw new Error('harness timeout rejection')
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'transport_error')
  assert.equal(entry.retries, 1)
  assert.equal(hits, 2)
  assert.match(entry.detail, /timeout|DISPATCH-ERROR|harness/i)
  assert.notEqual(entry.detail, 'auditor dispatch failed')
  assert.ok(entry.attempts[0].review_bytes > 0)
}

// --- 14. WARNING: envelope-form wrapper error is transport_error (retry path) ---
{
  let hits = 0
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-env-wrap')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        hits++
        if (hits === 1) {
          return { text: 'GROK-WRAPPER-ERROR: timeout after 600s', sessionId: 'dead-sess' }
        }
        return 'recovered\nVERDICT: PASS'
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'pass')
  assert.equal(entry.retries, 1, 'envelope wrapper must take transport retry, not re-ask')
  assert.equal(entry.reasks, 0)
  assert.equal(auditCalls(calls).filter(isReask).length, 0)
  assert.equal(auditCalls(calls).filter(isRetry).length, 1)
  assert.match(readFileSync(entry.attempts[0].review_path, 'utf8'), /GROK-WRAPPER-ERROR/)
}

// --- 15. WARNING: PASS-IF-FIXED is not an approval ---
{
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-pass-if-fixed')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        return 'analysis...\nVERDICT: PASS-IF-FIXED — must fix the null deref first'
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.notEqual(entry.status, 'pass')
  assert.equal(entry.verdict, 'NO-VERDICT')
  assert.equal(result.results[0].approved, false)
  assert.equal(entry.reasks, 0, 'no session on plain string → no re-ask')
  assert.equal(auditCalls(calls).length, 1)
}

// --- 16. WARNING: context-free synthetic session must not authorize re-ask PASS ---
{
  let reaskHits = 0
  const { result, calls } = await runWorkflow(
    { tasks: [baseTask('st-no-synth-session')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        if (isReask({ prompt, opts })) {
          reaskHits++
          return 'VERDICT: PASS'
        }
        // No sessionId on the return — must not re-ask.
        return 'lengthy critique without a closing verdict line'
      }
      return 'WORK OUTPUT'
    },
  )
  const [, entry] = voiceEntry(result.results[0])
  assert.equal(entry.status, 'no_verdict')
  assert.equal(entry.reasks, 0)
  assert.equal(reaskHits, 0, 'must not re-ask when relay session is absent')
  assert.equal(result.results[0].approved, false)
  assert.equal(auditCalls(calls).filter(isReask).length, 0)
}

// --- 17. BLOCKER: structured explicit DEFECT not overridden by narrative PASS ---
{
  const { result } = await runWorkflow(
    { tasks: [baseTask('st-struct-authority')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) {
        return {
          structuredOutput: {
            verdict: 'DEFECT',
            summary: 'null deref',
            text: 'The worker claims\nVERDICT: PASS\nbut I disagree because ...',
          },
        }
      }
      return 'WORK OUTPUT'
    },
  )
  const item = result.results[0]
  const [, entry] = voiceEntry(item)
  assert.equal(entry.status, 'defect')
  assert.equal(entry.verdict, 'DEFECT')
  assert.match(entry.detail, /null deref/)
  assert.equal(item.approved, false)
  assert.equal(entry.retries, 0)
  assert.equal(entry.reasks, 0)
}

// --- 18. pipeline keeps the item when a voice returns (never silently dropped) ---
{
  const { result } = await runWorkflow(
    { tasks: [baseTask('st-item-kept'), baseTask('st-item-kept-2')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) return 'ok\nVERDICT: PASS'
      return 'WORK OUTPUT'
    },
  )
  assert.equal(result.results.length, 2, 'both items must survive the audit stage')
  assert.equal(result.results[0].approved, true)
  assert.equal(result.results[1].approved, true)
}

// --- 19. retention marker present on workflow result ---
{
  const { result } = await runWorkflow(
    { tasks: [baseTask('st-retention')], ...onlyGrok },
    (prompt, opts) => {
      if (/auditor/.test(opts.agentType || '')) return 'x\nVERDICT: PASS'
      return 'WORK OUTPUT'
    },
  )
  assert.equal(typeof result.review_root, 'string')
  assert.ok(isAbsolute(result.review_root))
  assert.equal(typeof result.review_retention, 'string')
  assert.match(result.review_retention, /caller-owned|run-scoped|not delete/i)
}

console.log('PASS audit-status')
