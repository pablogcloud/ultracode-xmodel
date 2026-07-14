import assert from 'node:assert/strict'

// Helpers -------------------------------------------------------------
const isTriage = o => o.opts.label === 'triage'
const workerCalls = calls => calls.filter(c => /worker/.test(c.opts.agentType || ''))
const auditCalls  = calls => calls.filter(c => /auditor/.test(c.opts.agentType || ''))

function responder({ triage, verdicts = {} } = {}) {
  return (prompt, opts) => {
    if (opts.label === 'triage') return triage
    if (/auditor/.test(opts.agentType || '')) {
      const v = verdicts[opts.agentType] || 'PASS'
      return `critique...\nVERDICT: ${v}`
    }
    return `WORK OUTPUT for ${opts.label}`
  }
}

const t = (id, extra = {}) => ({ id, prompt: `do ${id}`, ...extra })

export const scenarios = [

  { name: 'fully labeled task skips triage and keeps explicit lane/effort',
    async run(runWorkflow) {
      const { result, calls } = await runWorkflow(
        { tasks: [t('a', { lane: 'grok', effort: 'low', complexity: 1, stakes: 'low' })] },
        responder())
      assert.equal(calls.filter(isTriage).length, 0)
      const w = workerCalls(calls)[0]
      assert.match(w.opts.agentType, /grok-worker$/)
      assert.match(w.prompt, /EFFORT: low/)
      assert.match(w.prompt, /MODE: plan/) // grok lane enforces read-only by default
      assert.equal(result.results[0].approved, null) // complexity 1 + low stakes → audit skipped
    } },

  { name: 'partial labels: explicit lane kept, triage fills effort and audit depth',
    async run(runWorkflow) {
      const { calls } = await runWorkflow(
        { tasks: [t('b', { lane: 'codex-medium' })] },
        responder({ triage: { scores: [{ id: 'b', complexity: 3, stakes: 'low', rationale: 'std' }] } }))
      assert.equal(calls.filter(isTriage).length, 1)
      const w = workerCalls(calls)[0]
      assert.match(w.opts.agentType, /codex-worker$/)
      assert.match(w.prompt, /EFFORT: high/)          // band mid → effort high
      assert.equal(auditCalls(calls).length, 1)        // band mid → single voice
    } },

  { name: 'band low routes to cheapest lane at medium effort with audit skipped',
    async run(runWorkflow) {
      const { result, calls } = await runWorkflow(
        { tasks: [t('c')] },
        responder({ triage: { scores: [{ id: 'c', complexity: 2, stakes: 'low', rationale: 'trivial' }] } }))
      const w = workerCalls(calls)[0]
      assert.match(w.prompt, /EFFORT: medium/)
      assert.equal(auditCalls(calls).length, 0)
      assert.equal(result.results[0].approved, null)
      assert.equal(result.results[0].band, 'low')
    } },

  { name: 'high stakes floors panel to two voices even at complexity 1',
    async run(runWorkflow) {
      const { calls } = await runWorkflow(
        { tasks: [t('d')] },
        responder({ triage: { scores: [{ id: 'd', complexity: 1, stakes: 'high', rationale: 'prod edit' }] } }))
      assert.equal(auditCalls(calls).length, 2)
    } },

  { name: 'complexity 5 routes to strongest lane with two-voice panel; both PASS approves',
    async run(runWorkflow) {
      const { result, calls } = await runWorkflow(
        { tasks: [t('e')] },
        responder({ triage: { scores: [{ id: 'e', complexity: 5, stakes: 'low', rationale: 'hard' }] } }))
      assert.equal(auditCalls(calls).length, 2)
      assert.equal(result.results[0].approved, true)
    } },

  { name: 'any DEFECT verdict rejects the item',
    async run(runWorkflow) {
      const { result } = await runWorkflow(
        { tasks: [t('f', { complexity: 5, stakes: 'high', lane: 'codex-high', effort: 'high' })] },
        responder({ verdicts: { 'ultracode-xmodel:grok-auditor': 'DEFECT — broken edge case' } }))
      assert.equal(result.results[0].approved, false)
    } },

  { name: 'triage failure escalates unlabeled tasks to strongest lane + panel',
    async run(runWorkflow) {
      const { calls } = await runWorkflow(
        { tasks: [t('g')] },
        (prompt, opts) => {
          if (opts.label === 'triage') return null
          if (/auditor/.test(opts.agentType || '')) return 'x\nVERDICT: PASS'
          return 'WORK OUTPUT'
        })
      const w = workerCalls(calls)[0]
      assert.match(w.opts.agentType, /codex-worker$/)  // strongest role
      assert.match(w.prompt, /EFFORT: high/)
      assert.equal(auditCalls(calls).length, 2)
    } },

  { name: 'single-voice audit picks the cross-family auditor',
    async run(runWorkflow) {
      const { calls } = await runWorkflow(
        { tasks: [t('h', { lane: 'grok' })] },
        responder({ triage: { scores: [{ id: 'h', complexity: 3, stakes: 'low', rationale: 'std' }] } }))
      const a = auditCalls(calls)
      assert.equal(a.length, 1)
      assert.match(a[0].opts.agentType, /codex-auditor$/) // grok work → codex audits
    } },

  { name: 'degraded config with one auditor still audits and approves on PASS',
    async run(runWorkflow) {
      const { result, calls } = await runWorkflow(
        { tasks: [t('i', { complexity: 4, stakes: 'high' })],
          config: { auditors: { grok: null } } },
        responder())
      assert.equal(auditCalls(calls).length, 1)
      assert.equal(result.results[0].approved, true)
    } },

  { name: 'unsafe dir is rejected before dispatch',
    async run(runWorkflow) {
      const { result, calls } = await runWorkflow(
        { tasks: [t('j', { dir: "/tmp/x'; rm -rf /" })] },
        responder({ triage: { scores: [] } }))
      assert.equal(workerCalls(calls).length, 0)
      assert.equal(result.rejected.length, 1)
    } },

  { name: 'last VERDICT line wins when multiple are present',
    async run(runWorkflow) {
      const { result } = await runWorkflow(
        { tasks: [t('k', { complexity: 4, stakes: 'high', lane: 'codex-high', effort: 'high' })] },
        (prompt, opts) => {
          if (/auditor/.test(opts.agentType || ''))
            return 'VERDICT: PASS\n...more analysis...\nVERDICT: DEFECT — real issue'
          return 'WORK OUTPUT'
        })
      assert.equal(result.results[0].approved, false)
    } },

  { name: 'worker WRAPPER-ERROR marks item failed without auditing',
    async run(runWorkflow) {
      const { result, calls } = await runWorkflow(
        { tasks: [t('l', { complexity: 4, stakes: 'high' })] },
        (prompt, opts) => {
          if (opts.label === 'triage') return { scores: [] }
          if (/worker/.test(opts.agentType || '')) return 'CODEX-WRAPPER-ERROR: exit=1'
          return 'x\nVERDICT: PASS'
        })
      assert.equal(auditCalls(calls).length, 0)
      assert.equal(result.results[0].approved, false)
      assert.ok(result.results[0].error)
    } },

  { name: 'audit:false disables all auditing',
    async run(runWorkflow) {
      const { result, calls } = await runWorkflow(
        { tasks: [t('m', { lane: 'grok', effort: 'high' })], audit: false },
        responder())
      assert.equal(calls.filter(isTriage).length, 0) // lane+effort+audit:false = fully labeled
      assert.equal(auditCalls(calls).length, 0)
      assert.equal(result.results[0].approved, null)
      assert.equal(result.results[0].band, null)       // nothing was triaged...
      assert.equal(result.results[0].source, 'explicit') // ...and nothing escalated
    } },

  { name: 'args as JSON string still parses',
    async run(runWorkflow) {
      const { result } = await runWorkflow(
        JSON.stringify({ tasks: [t('n', { lane: 'grok', effort: 'high' })], audit: false }),
        responder())
      assert.equal(result.results[0].id, 'n')
    } },

  { name: 'grok lane maps workspace-write sandbox to acceptEdits mode',
    async run(runWorkflow) {
      const { calls } = await runWorkflow(
        { tasks: [t('o', { lane: 'grok', effort: 'high', complexity: 3, stakes: 'low', sandbox: 'workspace-write' })] },
        responder())
      const w = workerCalls(calls)[0]
      assert.match(w.prompt, /MODE: acceptEdits/)
      assert.doesNotMatch(w.prompt, /SANDBOX:/) // grok CLI has no sandbox flag
    } },

  { name: 'unknown explicit lane is rejected, never rerouted',
    async run(runWorkflow) {
      const { result, calls } = await runWorkflow(
        { tasks: [t('p', { lane: 'nope', effort: 'low', complexity: 1, stakes: 'low' })] },
        responder())
      assert.equal(workerCalls(calls).length, 0)
      assert.equal(result.results.length, 0)
      assert.equal(result.rejected.length, 1)
      assert.match(result.rejected[0].error, /unknown lane/)
    } },

  { name: 'malformed triage entry escalates that task',
    async run(runWorkflow) {
      const { calls } = await runWorkflow(
        { tasks: [t('x')] },
        responder({ triage: { scores: [{ id: 'x', complexity: 1, stakes: 'bogus', rationale: 'r' }] } }))
      const w = workerCalls(calls)[0]
      assert.match(w.opts.agentType, /codex-worker$/) // strongest role, not cheapest
      assert.match(w.prompt, /EFFORT: high/)
      assert.equal(auditCalls(calls).length, 2)
    } },

  { name: 'VERDICT: PASSING does not parse as PASS',
    async run(runWorkflow) {
      const { result } = await runWorkflow(
        { tasks: [t('q', { lane: 'codex-high', effort: 'high', complexity: 4, stakes: 'low' })] },
        responder({ verdicts: {
          'ultracode-xmodel:grok-auditor': 'PASSING smoothly',
          'ultracode-xmodel:codex-auditor': 'PASSING smoothly',
        } }))
      assert.equal(result.results[0].approved, false)
    } },

  { name: 'sentinel mentioned mid-text is not a relay failure',
    async run(runWorkflow) {
      const { result } = await runWorkflow(
        { tasks: [t('s', { lane: 'codex-high', effort: 'high', complexity: 4, stakes: 'low' })] },
        (prompt, opts) => {
          if (/worker/.test(opts.agentType || ''))
            return 'The literal CODEX-WRAPPER-ERROR: sentinel is handled in line 42.'
          return 'x\nVERDICT: PASS'
        })
      assert.equal(result.results[0].error, undefined)
      assert.equal(result.results[0].approved, true)
    } },

  { name: 'worker null result yields failed item with error set',
    async run(runWorkflow) {
      const { result } = await runWorkflow(
        { tasks: [t('u', { lane: 'codex-high', effort: 'high', complexity: 3, stakes: 'low' })] },
        (prompt, opts) => {
          if (/worker/.test(opts.agentType || '')) return null
          return 'x\nVERDICT: PASS'
        })
      assert.equal(result.results[0].approved, false)
      assert.match(result.results[0].error, /worker returned null/)
    } },

  { name: 'dropping lanes via config remaps roles to an available lane',
    async run(runWorkflow) {
      const { calls } = await runWorkflow(
        { tasks: [t('r')],
          config: { lanes: { 'codex-high': null, 'codex-medium': null } } },
        responder({ triage: { scores: [{ id: 'r', complexity: 3, stakes: 'low', rationale: 'std' }] } }))
      const w = workerCalls(calls)[0]
      assert.match(w.opts.agentType, /grok-worker$/) // roles healed to the only remaining lane
      const a = auditCalls(calls)
      assert.equal(a.length, 1)
      assert.match(a[0].opts.agentType, /codex-auditor$/) // cross-family voice still chosen
    } },
]
