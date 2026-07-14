export const meta = {
  name: 'ultracode-xmodel',
  description: 'Run self-contained tasks on external frontier models with complexity-based effort routing and a cross-model adversarial audit panel',
  whenToUse: 'Execute a list of self-contained tasks on external CLIs (Codex, Grok). Unlabeled tasks are triaged for complexity and stakes, then routed to a lane, worker effort, and audit depth. args: { tasks: [{ id, prompt, lane?, effort?, stakes?: "low"|"high", complexity?: 1-5, dir?, sandbox? }], audit?: boolean (default true), config?: partial CONFIG override }',
  phases: [
    { title: 'Triage', detail: 'one batch call scores unlabeled tasks for complexity and stakes' },
    { title: 'Work', detail: 'each task runs on its assigned lane at its assigned effort' },
    { title: 'Audit', detail: 'adversarial refute panel sized to complexity and stakes' },
  ],
}

// ================================ CONFIG ================================
// Edit this block to match your installation, or override any subset
// per-run via args.config (deep-merged over this block).
const CONFIG = {
  agentPrefix: 'ultracode-xmodel:', // AGENT-PREFIX
  lanes: {
    'codex-high':   { agent: 'codex-worker', family: 'codex', directives: { MODEL: 'gpt-5.6-terra', EFFORT: 'high' } },
    'codex-medium': { agent: 'codex-worker', family: 'codex', directives: { MODEL: 'gpt-5.6-terra', EFFORT: 'medium' } },
    'grok':         { agent: 'grok-worker',  family: 'grok',  directives: { MODEL: 'grok-4.5', EFFORT: 'high' },
                      // The grok CLI expresses write access via permission mode, not a
                      // sandbox flag; map the task's sandbox field accordingly.
                      sandbox: { 'read-only': { MODE: 'plan' }, 'workspace-write': { MODE: 'acceptEdits' } } },
  },
  // Which lane each routing role points at.
  roles: { cheapest: 'codex-medium', default: 'codex-high', strongest: 'codex-high' },
  auditors: {
    grok:  { agent: 'grok-auditor',  family: 'grok',  directives: {} },
    codex: { agent: 'codex-auditor', family: 'codex', directives: {} },
  },
}

// Routing bands: complexity 1-2 & low stakes → low; complexity 3 & low
// stakes → mid; complexity 4-5 OR high stakes → high.
const BANDS = {
  low:  { role: 'cheapest',  effort: 'medium', audit: 'none' },
  mid:  { role: 'default',   effort: 'high',   audit: 'single' },
  high: { role: 'strongest', effort: 'high',   audit: 'panel' },
}

const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'complexity', 'stakes', 'rationale'],
        properties: {
          id: { type: 'string' },
          complexity: { type: 'integer', minimum: 1, maximum: 5 },
          stakes: { enum: ['low', 'high'] },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

function deepMerge(base, over) {
  if (over === undefined) return base
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over
  if (base === null || typeof base !== 'object' || Array.isArray(base)) base = {}
  const out = { ...base }
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k])
  return out
}

// ------------------------------ input ----------------------------------
let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) {
    return { error: 'args arrived as an unparseable string: ' + input.slice(0, 200) }
  }
}
const tasks = (input && input.tasks) || []
if (!tasks.length) {
  return { error: 'args.tasks is empty — pass { tasks: [{ id, prompt, ... }] }' }
}
const doAudit = !input || input.audit !== false
const cfg = deepMerge(CONFIG, input && input.config)
// Dropping an auditor or lane via config (e.g. { auditors: { grok: null } })
// leaves a null entry; remove them, then heal any role that pointed at a
// removed lane so a degraded install still routes to what exists.
for (const k of Object.keys(cfg.auditors)) if (!cfg.auditors[k]) delete cfg.auditors[k]
for (const k of Object.keys(cfg.lanes)) if (!cfg.lanes[k]) delete cfg.lanes[k]
const laneNames = Object.keys(cfg.lanes)
if (!laneNames.length) return { error: 'no lanes configured' }
for (const role of Object.keys(cfg.roles)) {
  if (!cfg.lanes[cfg.roles[role]]) {
    log(`role "${role}" pointed at unavailable lane "${cfg.roles[role]}" — remapped to "${laneNames[0]}"`)
    cfg.roles[role] = laneNames[0]
  }
}

// ------------------------------ safety ---------------------------------
// Reject values that could break the relays' quoted shell commands or
// inject extra directive lines.
const BAD_PATH = /[\n\r;|&'"`$]/
const SANDBOXES = ['read-only', 'workspace-write']
const isUnsafe = t => (t.dir && BAD_PATH.test(String(t.dir))) || (t.sandbox && !SANDBOXES.includes(t.sandbox))
// An explicit lane that doesn't exist is a caller error: reject it rather
// than silently rerouting — explicit values are never overridden.
const unknownLane = t => t.lane && !cfg.lanes[t.lane]
const rejected = tasks
  .filter(isUnsafe)
  .map(t => ({ id: t.id, error: 'rejected: dir contains shell/quote/newline characters, or sandbox is not read-only|workspace-write' }))
  .concat(tasks
    .filter(t => !isUnsafe(t) && unknownLane(t))
    .map(t => ({ id: t.id, error: `rejected: unknown lane "${t.lane}"` })))
const runnable = tasks.filter(t => !isUnsafe(t) && !unknownLane(t))
if (rejected.length) log(`${rejected.length} task(s) rejected before dispatch (unsafe values or unknown lane)`)

// ------------------------------ triage ---------------------------------
phase('Triage')
const fullyLabeled = t =>
  t.lane && t.effort && (!doAudit || (t.complexity != null && t.stakes != null))
const toScore = runnable.filter(t => !fullyLabeled(t))
const scores = {}
if (toScore.length) {
  const triagePrompt = [
    'Score each task below for dispatch routing. For each task return complexity 1-5',
    '(1 = trivial mechanical change, 3 = standard single-component implementation,',
    '5 = multi-component design or intricate debugging) and stakes "high" or "low".',
    'stakes=high when a defect would damage working systems, security, money, or data',
    '(in-place modification of working code, auth, payments, schema migrations, concurrency);',
    'otherwise "low". Score every task, based only on its text.',
    '',
    JSON.stringify(toScore.map(t => ({ id: t.id, prompt: String(t.prompt).slice(0, 2000) }))),
  ].join('\n')
  let res = null
  try {
    res = await agent(triagePrompt, {
      label: 'triage', phase: 'Triage', model: 'haiku', effort: 'low', schema: TRIAGE_SCHEMA,
    })
  } catch (e) {
    log('triage call failed: ' + ((e && e.message) || 'unknown error'))
  }
  // Validate every entry — a malformed score must escalate, never mis-route.
  const validScore = s => s && typeof s.id === 'string'
    && Number.isInteger(s.complexity) && s.complexity >= 1 && s.complexity <= 5
    && (s.stakes === 'low' || s.stakes === 'high')
  if (res && Array.isArray(res.scores)) {
    for (const s of res.scores) {
      if (validScore(s)) scores[s.id] = s
      else log(`triage entry for "${s && s.id}" is malformed — that task escalates`)
    }
  }
  const missing = toScore.filter(t => !scores[t.id] && (t.complexity == null || t.stakes == null))
  if (missing.length) log(`triage incomplete for ${missing.length} task(s) — they escalate to the strongest lane + full panel`)
}

// ------------------------------ routing --------------------------------
function bandOf(complexity, stakes) {
  if (stakes === 'high' || complexity >= 4) return 'high'
  if (complexity === 3) return 'mid'
  return 'low'
}

function routeOf(t) {
  const s = scores[t.id] || {}
  const complexity = t.complexity != null ? t.complexity : s.complexity
  const stakes = t.stakes != null ? t.stakes : s.stakes
  let band, source
  if (complexity == null || stakes == null) {
    if (t.lane && t.effort && !doAudit) {
      // Fully explicit routing with auditing off: nothing was triaged and
      // nothing escalated — report it that way.
      band = null
      source = 'explicit'
    } else {
      band = 'high' // fail-safe: unresolved triage escalates, never degrades
      source = 'fail-safe'
    }
  } else {
    band = bandOf(complexity, stakes)
    source = scores[t.id] ? 'triage' : 'explicit'
  }
  const spec = band ? BANDS[band] : null
  const laneName = t.lane || cfg.roles[spec ? spec.role : 'strongest']
  const effort = t.effort != null ? t.effort : (spec ? spec.effort : 'high')
  const audit = !doAudit ? 'none' : spec.audit
  return { band, source, laneName, effort, audit, complexity, stakes }
}

const routes = {}
for (const t of runnable) {
  routes[t.id] = routeOf(t)
  const r = routes[t.id]
  log(`route ${t.id}: lane=${r.laneName} effort=${r.effort} audit=${r.audit} (band=${r.band}, source=${r.source})`)
}

// ------------------------------ prompts --------------------------------
function directiveBlock(map) {
  return Object.keys(map).filter(k => map[k] != null).map(k => `${k}: ${map[k]}`).join('\n')
}

function workerPrompt(t) {
  const r = routes[t.id]
  const lane = cfg.lanes[r.laneName]
  const d = { ...lane.directives, EFFORT: r.effort }
  if (t.dir) d.DIR = t.dir
  // Sandbox: lanes whose CLI has no sandbox flag declare a mapping (e.g.
  // grok's permission modes); it is always applied so the read-only default
  // is enforced, not assumed. Other lanes pass SANDBOX through only when
  // the task asked for it (their relay already defaults to read-only).
  const sb = t.sandbox || 'read-only'
  if (lane.sandbox) Object.assign(d, lane.sandbox[sb] || {})
  else if (t.sandbox) d.SANDBOX = t.sandbox
  return directiveBlock(d) + '\n\n' + t.prompt
}

function auditPrompt(t, auditor, output) {
  const d = { ...auditor.directives }
  if (t.dir) d.DIR = t.dir
  const head = directiveBlock(d)
  return [
    head || null,
    `Work item "${t.id}" (produced by external lane ${routes[t.id].laneName}). The original task was:`,
    t.prompt,
    '--- OUTPUT PRODUCED (refute this) ---',
    output,
  ].filter(Boolean).join('\n\n')
}

// The relays place their failure sentinel at the very start of the output;
// a mention of the sentinel elsewhere in ordinary text is not a failure.
const isWrapperError = s => typeof s === 'string' && /^\s*(CODEX|GROK)-WRAPPER-ERROR:/.test(s)

function verdictOf(text) {
  if (typeof text !== 'string' || !text.trim()) return { verdict: 'ERROR', detail: 'auditor returned nothing' }
  if (isWrapperError(text)) return { verdict: 'ERROR', detail: text.slice(0, 300) }
  const all = [...text.matchAll(/VERDICT:\s*(PASS|DEFECT|NO-VERDICT)(?![A-Za-z])\s*[—-]?\s*([^\n]*)/gi)]
  if (!all.length) return { verdict: 'NO-VERDICT', detail: text.slice(-400) }
  const m = all[all.length - 1]
  return { verdict: m[1].toUpperCase(), detail: (m[2] || '').trim() }
}

function voicesFor(t) {
  const r = routes[t.id]
  if (r.audit === 'none') return []
  const family = cfg.lanes[r.laneName].family
  const ids = Object.keys(cfg.auditors)
  if (!ids.length) { log(`audit skipped for ${t.id}: no auditors configured`); return [] }
  if (r.audit === 'single') {
    const cross = ids.filter(id => cfg.auditors[id].family !== family)
    if (cross.length) return [cross[0]]
    log(`audit degraded for ${t.id}: no cross-family auditor available; using a same-family voice`)
    return [ids[0]]
  }
  if (ids.length < 2) log(`audit degraded for ${t.id}: panel requested but only ${ids.length} auditor(s) configured`)
  return ids
}

// ------------------------------ execute --------------------------------
const results = await pipeline(
  runnable,
  (t) => agent(workerPrompt(t), {
    label: `work:${t.id}:${routes[t.id].laneName}`,
    phase: 'Work',
    agentType: cfg.agentPrefix + cfg.lanes[routes[t.id].laneName].agent,
    effort: 'low',
  }),
  async (output, t) => {
    const r = routes[t.id]
    const base = { id: t.id, lane: r.laneName, effort: r.effort, band: r.band, source: r.source }
    if (output == null) return { ...base, output: null, approved: false, error: 'worker returned null (skipped or died)' }
    if (isWrapperError(output)) {
      return { ...base, output, approved: false, error: 'worker lane failed — see output' }
    }
    const voices = voicesFor(t)
    if (!voices.length) {
      if (doAudit && r.audit === 'none') log(`audit skipped for ${t.id} (band=${r.band})`)
      return { ...base, output, approved: null }
    }
    const votes = await parallel(voices.map(id => () =>
      agent(auditPrompt(t, cfg.auditors[id], output), {
        label: `audit-${id}:${t.id}`, phase: 'Audit',
        agentType: cfg.agentPrefix + cfg.auditors[id].agent, effort: 'low',
      })
    ))
    const audit = {}
    voices.forEach((id, i) => { audit[id] = verdictOf(votes[i]) })
    const approved = voices.every(id => audit[id].verdict === 'PASS')
    return { ...base, output, audit, approved }
  },
)

const done = results.filter(Boolean)
if (doAudit) {
  const audited = done.filter(x => x.audit)
  log(`${audited.filter(x => x.approved).length}/${audited.length} audited item(s) approved; ${done.filter(x => x.approved === null).length} skipped audit`)
}
return { results: done, rejected }
