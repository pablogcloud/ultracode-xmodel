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
if (!Array.isArray(tasks) || !tasks.length) {
  return { error: 'args.tasks must be a non-empty array — pass { tasks: [{ id, prompt, ... }] }' }
}
const doAudit = !input || input.audit !== false
const cfg = deepMerge(CONFIG, input && input.config)
// A config override may null out a whole container; fail cleanly, not with
// a TypeError deep in routing.
for (const key of ['lanes', 'roles', 'auditors']) {
  if (!cfg[key] || typeof cfg[key] !== 'object' || Array.isArray(cfg[key])) {
    return { error: `config.${key} must be an object` }
  }
}
// Directive KEYS and VALUES are both emitted as `KEY: value` lines and
// interpolated UNQUOTED into the relay's CLI command. Constrain both: a key
// must be an uppercase identifier (so it cannot smuggle a newline or an
// extra directive), and a value must be a single shell-safe token — no
// spaces (which would become extra CLI arguments), no metacharacters, no
// newlines. Config is caller-supplied, so this runs over the merged config.
// (Task `dir` is the one value that may contain spaces; the relay
// single-quotes it and it is validated separately by BAD_PATH.)
const SAFE_KEY = /^[A-Z][A-Z0-9_]*$/
const SAFE_TOKEN = /^[A-Za-z0-9._/-]+$/
// Effort is injection-checked, not allow-listed (a lowercase word carries no
// spaces, metacharacters, or leading dash); the CLI judges which words it
// accepts, so tool/version-specific values like codex `ultra` or grok
// `none`/`minimal` are not rejected here.
const EFFORT_RE = /^[a-z]+$/
// Metacharacter-safety is not enough for the capability-bearing directives:
// a value like `danger-full-access` or `bypassPermissions` is shell-safe but
// disables the sandbox/approval boundary. Constrain those to their intended
// sets; other directives (e.g. MODEL, an open-ended id) only need to be a
// safe token.
// SANDBOX and MODE are privilege-bearing (a wrong value escalates capability),
// so they are strictly allow-listed. EFFORT is not (see EFFORT_RE above), so it
// is only injection-checked. Other directives (e.g. MODEL, an open-ended id)
// need only be a safe token.
const DIRECTIVE_ENUMS = {
  SANDBOX: ['read-only', 'workspace-write'],
  MODE: ['plan', 'acceptEdits', 'default'],
}
function checkDirectives(dirs, where) {
  for (const k of Object.keys(dirs)) {
    if (dirs[k] == null) continue
    if (!SAFE_KEY.test(k)) return `${where}: directive name "${k}" must be an uppercase identifier`
    const v = String(dirs[k])
    if (DIRECTIVE_ENUMS[k]) {
      if (!DIRECTIVE_ENUMS[k].includes(v)) return `${where}: directive ${k} must be one of ${DIRECTIVE_ENUMS[k].join('|')}`
    } else if (k === 'EFFORT') {
      if (!EFFORT_RE.test(v)) return `${where}: directive EFFORT must be a lowercase word`
    } else if (!SAFE_TOKEN.test(v)) {
      return `${where}: directive ${k} value has unsafe characters (spaces/metacharacters)`
    }
  }
  return null
}
for (const group of ['lanes', 'auditors']) {
  for (const name of Object.keys(cfg[group])) {
    const entry = cfg[group][name]
    if (!entry) continue
    let e = checkDirectives(entry.directives || {}, `config.${group}.${name}.directives`)
    if (e) return { error: e }
    if (entry.sandbox) {
      for (const sb of Object.keys(entry.sandbox)) {
        e = checkDirectives(entry.sandbox[sb] || {}, `config.${group}.${name}.sandbox.${sb}`)
        if (e) return { error: e }
      }
    }
  }
}
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
// EFFORT_RE is declared above (with the directive validators) and reused here
// for per-task effort.
// Caller errors are rejected, never guessed around: routing state is keyed
// by id (duplicates would silently corrupt it), and an invalid explicit
// complexity/stakes would otherwise band LOW — a silent downgrade.
const idCount = {}
for (const t of tasks) {
  const k = typeof t.id === 'string' && t.id ? t.id : ''
  idCount[k] = (idCount[k] || 0) + 1
}
function rejectionOf(t) {
  if (!(typeof t.id === 'string' && t.id) || idCount[t.id] > 1) return 'rejected: id must be a unique non-empty string'
  if (!(typeof t.prompt === 'string' && t.prompt.trim())) return 'rejected: prompt must be a non-empty string'
  if (t.complexity != null && !(Number.isInteger(t.complexity) && t.complexity >= 1 && t.complexity <= 5)) return 'rejected: invalid explicit complexity (integer 1-5)'
  if (t.stakes != null && t.stakes !== 'low' && t.stakes !== 'high') return 'rejected: invalid explicit stakes ("low"|"high")'
  if (t.effort != null && !EFFORT_RE.test(t.effort)) return 'rejected: invalid explicit effort (must be a lowercase word)'
  if ((t.dir && BAD_PATH.test(String(t.dir))) || (t.sandbox && !SANDBOXES.includes(t.sandbox))) return 'rejected: dir contains shell/quote/newline characters, or sandbox is not read-only|workspace-write'
  if (t.lane && !cfg.lanes[t.lane]) return `rejected: unknown lane "${t.lane}"`
  return null
}
const rejected = []
const runnable = []
for (const t of tasks) {
  const reason = rejectionOf(t)
  if (reason) rejected.push({ id: t.id, error: reason })
  else runnable.push(t)
}
if (rejected.length) log(`${rejected.length} task(s) rejected before dispatch (invalid ids/fields, unsafe values, or unknown lane)`)

// ------------------------------ triage ---------------------------------
phase('Triage')
// Score only tasks whose banding actually needs it: something is missing
// AND the result would be used (with auditing off, a task that already has
// lane + effort routes entirely on explicit values).
const toScore = runnable.filter(t =>
  (t.complexity == null || t.stakes == null) && !(t.lane && t.effort && !doAudit))
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

// Word-boundary rejects letter *and* hyphen continuations so PASSING and
// PASS-IF-FIXED are not accepted as PASS.
const VERDICT_LINE = /^\s*VERDICT:\s*(PASS|DEFECT|NO-VERDICT)(?![A-Za-z-])\s*(?:[—-]\s*)?(.*)$/i
const VERDICT_TOKEN = /^(PASS|DEFECT|NO-VERDICT)(?![A-Za-z-])(?:\s*[—-]\s*(.*))?$/i

// Last syntactically valid VERDICT line wins. Trailing fences, usage footers,
// and ordinary text after that line are ignored; a quoted mid-body line can
// still win if the critic never issues its own later verdict.
function parseVerdictLines(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { verdict: 'NO-VERDICT', detail: typeof text === 'string' ? text.slice(-400) : '' }
  }
  let last = null
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(VERDICT_LINE)
    if (m) last = m
  }
  if (!last) return { verdict: 'NO-VERDICT', detail: text.slice(-400) }
  return { verdict: last[1].toUpperCase(), detail: (last[2] || '').trim() }
}

function stableJson(value) {
  try { return { ok: true, text: JSON.stringify(value) } }
  catch (e) { return { ok: false, error: (e && e.message) || 'JSON serialization failed' } }
}

function verdictFromStructured(so) {
  if (typeof so === 'string') return parseVerdictLines(so)
  if (!so || typeof so !== 'object' || Array.isArray(so)) {
    return { verdict: 'NO-VERDICT', detail: '' }
  }
  // Explicit schema verdict field has authority over any nested narrative.
  // Narrative scanning is a fallback only when the explicit field is absent.
  const hasExplicit = (typeof so.verdict === 'string' && so.verdict.trim())
    || (typeof so.VERDICT === 'string' && so.VERDICT.trim())
  if (hasExplicit) {
    const raw = (typeof so.verdict === 'string' && so.verdict.trim()) ? so.verdict : so.VERDICT
    const m = raw.trim().match(VERDICT_TOKEN)
    if (m) {
      const detail = (m[2] || '').trim() ||
        (typeof so.detail === 'string' ? so.detail.trim() : '') ||
        (typeof so.summary === 'string' ? so.summary.trim() : '')
      return { verdict: m[1].toUpperCase(), detail }
    }
    // Allow "VERDICT: PASS" stuffed into the field.
    const asLine = parseVerdictLines(raw)
    if (asLine.verdict !== 'NO-VERDICT') return asLine
    // Present-but-invalid explicit field fails closed; do not scan narrative.
    return {
      verdict: 'NO-VERDICT',
      detail: (typeof so.summary === 'string' ? so.summary : raw).slice(0, 400),
    }
  }
  for (const key of ['text', 'body', 'critique', 'content']) {
    if (typeof so[key] === 'string' && so[key].trim()) {
      const fromBody = parseVerdictLines(so[key])
      if (fromBody.verdict !== 'NO-VERDICT') return fromBody
    }
  }
  const ser = stableJson(so)
  return { verdict: 'NO-VERDICT', detail: ser.ok ? ser.text.slice(-400) : '' }
}

// Grok schema mode puts the payload in structuredOutput, not text. Prefer
// that field when the auditor return is a JSON envelope (string or object).
function unwrapAuditPayload(raw) {
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t.startsWith('{')) {
      try {
        const obj = JSON.parse(t)
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return unwrapAuditPayload(obj)
      } catch { /* plain text */ }
    }
    return { kind: 'text', value: raw }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Object.prototype.hasOwnProperty.call(raw, 'structuredOutput') && raw.structuredOutput != null) {
      return { kind: 'structured', value: raw.structuredOutput }
    }
    if (typeof raw.text === 'string') return { kind: 'text', value: raw.text }
  }
  return null
}

function wrapperErrorText(raw) {
  if (typeof raw === 'string' && isWrapperError(raw)) return raw
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.text === 'string' && isWrapperError(raw.text)) return raw.text
    if (typeof raw.structuredOutput === 'string' && isWrapperError(raw.structuredOutput)) {
      return raw.structuredOutput
    }
  }
  return null
}

function verdictOf(raw) {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) {
    return { verdict: 'ERROR', detail: 'auditor returned nothing' }
  }
  // Transport failures stay ERROR even if a VERDICT line appears later.
  // Envelope-form wrappers (text/structuredOutput beginning with the
  // sentinel) are transport faults, not missing-verdict cases.
  const wrap = wrapperErrorText(raw)
  if (wrap != null) return { verdict: 'ERROR', detail: wrap.slice(0, 300) }
  const unwrapped = unwrapAuditPayload(raw)
  if (!unwrapped) {
    return typeof raw === 'string'
      ? parseVerdictLines(raw)
      : { verdict: 'ERROR', detail: 'auditor returned nothing' }
  }
  if (unwrapped.kind === 'text' && isWrapperError(unwrapped.value)) {
    return { verdict: 'ERROR', detail: unwrapped.value.slice(0, 300) }
  }
  if (unwrapped.kind === 'structured') return verdictFromStructured(unwrapped.value)
  return parseVerdictLines(unwrapped.value)
}

// Authoritative four-state audit contract. `verdict` remains a compatibility
// projection (PASS/DEFECT/NO-VERDICT/ERROR); consumers that need to branch on
// remediation must read `status`, never the boolean `approved` alone.
const AUDIT_STATUS = {
  PASS: 'pass',
  DEFECT: 'defect',
  'NO-VERDICT': 'no_verdict',
  ERROR: 'transport_error',
}

function statusOf(parsed) {
  const v = parsed && parsed.verdict
  return AUDIT_STATUS[v] || 'transport_error'
}

// Relay-supplied session only. Never synthesize an identity that could
// authorize a context-free re-ask PASS.
function realSessionIdOf(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.sessionId === 'string' && raw.sessionId.trim()) return raw.sessionId.trim()
    if (typeof raw.session_id === 'string' && raw.session_id.trim()) return raw.session_id.trim()
  }
  return null
}

// Deterministic body extractor: preserve critique text / structured body
// rather than JSON-escaping a whole envelope. If no textual body exists,
// fall back to a stable JSON representation; serialization failure is
// reported so the caller never treats the attempt as PASS.
function extractAuditBody(raw) {
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t.startsWith('{')) {
      try {
        const obj = JSON.parse(t)
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return extractAuditBody(obj)
      } catch { /* plain text critique */ }
    }
    return { ok: true, body: raw }
  }
  if (raw == null) return { ok: true, body: '' }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Object.prototype.hasOwnProperty.call(raw, 'structuredOutput') && raw.structuredOutput != null) {
      const so = raw.structuredOutput
      if (typeof so === 'string') return { ok: true, body: so }
      if (so && typeof so === 'object' && !Array.isArray(so)) {
        for (const key of ['text', 'body', 'critique', 'content']) {
          if (typeof so[key] === 'string') return { ok: true, body: so[key] }
        }
        const ser = stableJson(so)
        if (!ser.ok) return { ok: false, error: ser.error, body: '' }
        return { ok: true, body: ser.text }
      }
      const ser = stableJson(so)
      if (!ser.ok) return { ok: false, error: ser.error, body: '' }
      return { ok: true, body: ser.text }
    }
    if (typeof raw.text === 'string') return { ok: true, body: raw.text }
    const ser = stableJson(raw)
    if (!ser.ok) return { ok: false, error: ser.error, body: '' }
    return { ok: true, body: ser.text }
  }
  try { return { ok: true, body: String(raw) } }
  catch (e) { return { ok: false, error: (e && e.message) || 'body extraction failed', body: '' } }
}

// Normalize worker envelopes before sentinel/empty checks and auditPrompt so
// object returns are never coerced to the literal "[object Object]".
function normalizeWorkerOutput(output) {
  if (output == null) return { kind: 'null', value: null }
  if (typeof output === 'string') {
    if (isWrapperError(output)) return { kind: 'wrapper_error', value: output }
    if (!output.trim()) return { kind: 'empty', value: output }
    return { kind: 'text', value: output }
  }
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    if (typeof output.text === 'string' && isWrapperError(output.text)) {
      return { kind: 'wrapper_error', value: output.text }
    }
    if (typeof output.structuredOutput === 'string' && isWrapperError(output.structuredOutput)) {
      return { kind: 'wrapper_error', value: output.structuredOutput }
    }
    let text = null
    if (Object.prototype.hasOwnProperty.call(output, 'structuredOutput') && output.structuredOutput != null) {
      const so = output.structuredOutput
      if (typeof so === 'string') text = so
      else if (so && typeof so === 'object' && !Array.isArray(so)) {
        for (const key of ['text', 'body', 'critique', 'content']) {
          if (typeof so[key] === 'string') { text = so[key]; break }
        }
        if (text == null) {
          const ser = stableJson(so)
          if (!ser.ok) return { kind: 'error', value: null, error: ser.error }
          text = ser.text
        }
      } else {
        const ser = stableJson(so)
        if (!ser.ok) return { kind: 'error', value: null, error: ser.error }
        text = ser.text
      }
    } else if (typeof output.text === 'string') {
      text = output.text
    } else {
      const ser = stableJson(output)
      if (!ser.ok) return { kind: 'error', value: null, error: ser.error }
      text = ser.text
    }
    if (text == null || !String(text).trim()) return { kind: 'empty', value: text == null ? '' : text }
    if (isWrapperError(text)) return { kind: 'wrapper_error', value: text }
    return { kind: 'text', value: text }
  }
  try {
    const s = String(output)
    if (!s.trim()) return { kind: 'empty', value: s }
    return { kind: 'text', value: s }
  } catch (e) {
    return { kind: 'error', value: null, error: (e && e.message) || 'worker output unusable' }
  }
}

const VERDICT_REASK_PROMPT = [
  'This is finalization of the already-inspected review — do not re-examine the material.',
  'Your previous audit reply is missing a final machine-parseable verdict line.',
  'Reply with exactly one line and nothing else:',
  'VERDICT: PASS',
  'or',
  'VERDICT: DEFECT — <one-line summary of the worst defect>',
].join('\n')

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
// Full audit bodies leave via run-scoped files, not the returned object —
// model relay transport is the failure boundary for large critiques.
// reviewRoot is caller-owned for the process lifetime: the workflow never
// deletes it. Consumers must copy artifacts they need beyond tmp retention.
const fs = await import('node:fs')
const path = await import('node:path')
const os = await import('node:os')
const crypto = await import('node:crypto')
const reviewRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xmodel-review-'))
const REVIEW_RETENTION = 'caller-owned-run-scoped; workflow does not delete; subject to OS tmp reapers'

function persistAuditReview(taskId, voiceId, bodyText) {
  const body = typeof bodyText === 'string' ? bodyText : ''
  const safeTask = String(taskId).replace(/[^A-Za-z0-9._-]+/g, '_')
  const safeVoice = String(voiceId).replace(/[^A-Za-z0-9._-]+/g, '_')
  const review_path = path.join(
    reviewRoot,
    `${safeTask}.${safeVoice}.${crypto.randomBytes(16).toString('hex')}.txt`,
  )
  fs.writeFileSync(review_path, body, 'utf8')
  // Byte length from the written file — JS string length is not UTF-8 bytes.
  const review_bytes = fs.statSync(review_path).size
  return { review_path, review_bytes }
}

// One voice owned by a single state machine: dispatch, normalize, immediate
// artifact persistence, status, and an append-only attempts evidence ledger.
// Thrown dispatches are caught here so parallel's null-on-rejection cannot
// erase retry semantics or error identity. Defects never retry. Transport
// retries once. no_verdict re-asks once, and only with a real relay session.
async function runAuditVoice(t, voiceId, output) {
  const agentType = cfg.agentPrefix + cfg.auditors[voiceId].agent
  const baseOpts = { phase: 'Audit', agentType, effort: 'low' }
  const attempts = []

  async function dispatch(prompt, label, sessionId) {
    try {
      const opts = { ...baseOpts, label }
      if (sessionId) opts.sessionId = sessionId
      const raw = await agent(prompt, opts)
      return { ok: true, raw, error: null }
    } catch (e) {
      return { ok: false, raw: null, error: (e && e.message) || 'auditor dispatch threw' }
    }
  }

  function recordAttempt(kind, label, dispatchResult) {
    let parsed
    let session_id = null
    let body = ''
    let bodyOk = true
    let bodyError = null

    if (!dispatchResult.ok) {
      parsed = { verdict: 'ERROR', detail: dispatchResult.error }
      body = `DISPATCH-ERROR: ${dispatchResult.error}`
    } else {
      parsed = verdictOf(dispatchResult.raw)
      session_id = realSessionIdOf(dispatchResult.raw)
      const extracted = extractAuditBody(dispatchResult.raw)
      if (!extracted.ok) {
        bodyOk = false
        bodyError = extracted.error || 'body extraction failed'
        body = ''
        // Never approve when body extraction failed — force transport_error.
        parsed = { verdict: 'ERROR', detail: bodyError }
      } else {
        body = extracted.body
      }
    }

    let review_path = null
    let review_bytes = 0
    let persistence_error = null
    try {
      const artifact = persistAuditReview(t.id, `${voiceId}.${kind}`, body)
      review_path = artifact.review_path
      review_bytes = artifact.review_bytes
    } catch (e) {
      persistence_error = (e && e.message) || 'artifact persistence failed'
      parsed = { verdict: 'ERROR', detail: persistence_error }
    }

    const status = statusOf(parsed)
    const attempt = {
      kind,
      label,
      status,
      verdict: parsed.verdict,
      detail: parsed.detail,
      session_id,
      review_path,
      review_bytes,
      ...(bodyOk ? {} : { body_error: bodyError }),
      ...(persistence_error ? { persistence_error } : {}),
    }
    attempts.push(attempt)
    return attempt
  }

  try {
    const primaryLabel = `audit-${voiceId}:${t.id}`
    let terminal = recordAttempt(
      'primary',
      primaryLabel,
      await dispatch(auditPrompt(t, cfg.auditors[voiceId], output), primaryLabel, null),
    )

    // Only transport faults retry — never a model-found defect. Persist
    // attempt 1 first (above); attempt 2 is a separate ledger entry.
    if (terminal.status === 'transport_error') {
      const retryLabel = `audit-${voiceId}:${t.id}:retry`
      terminal = recordAttempt(
        'retry',
        retryLabel,
        await dispatch(auditPrompt(t, cfg.auditors[voiceId], output), retryLabel, null),
      )
    }

    // Missing verdict: one finalization re-ask only when the relay supplied a
    // real non-empty session identity. Synthetic ids are not authorized.
    if (terminal.status === 'no_verdict' && terminal.session_id) {
      const reaskLabel = `audit-${voiceId}:${t.id}:reask`
      terminal = recordAttempt(
        'reask',
        reaskLabel,
        await dispatch(VERDICT_REASK_PROMPT, reaskLabel, terminal.session_id),
      )
      if (terminal.status !== 'pass' && terminal.status !== 'defect' && terminal.status !== 'transport_error') {
        // Still missing after the single re-ask — remain non-PASS.
        terminal = {
          ...terminal,
          status: 'no_verdict',
          verdict: 'NO-VERDICT',
          detail: terminal.detail || attempts[attempts.length - 1].detail,
        }
        attempts[attempts.length - 1] = {
          ...attempts[attempts.length - 1],
          status: 'no_verdict',
          verdict: 'NO-VERDICT',
        }
      }
    }

    const primary = attempts.find(a => a.kind === 'primary') || attempts[0]
    const reask = attempts.find(a => a.kind === 'reask')
    const retries = attempts.filter(a => a.kind === 'retry').length
    const reasks = attempts.filter(a => a.kind === 'reask').length
    // Terminal projection: last attempt wins; compatibility fields keep the
    // primary artifact path (always persisted) and optional reask artifact.
    return {
      status: terminal.status,
      verdict: terminal.verdict,
      detail: terminal.detail,
      review_path: primary.review_path,
      review_bytes: primary.review_bytes,
      ...(reask && reask.review_path
        ? { reask_path: reask.review_path, reask_bytes: reask.review_bytes }
        : {}),
      retries,
      reasks,
      session_id: terminal.session_id || primary.session_id || null,
      attempts,
    }
  } catch (e) {
    // Last-resort: never throw into parallel. Persist an explicit fault row.
    const detail = (e && e.message) || 'audit state machine failed'
    let artifact = { review_path: null, review_bytes: 0 }
    let persistence_error = null
    try {
      artifact = persistAuditReview(t.id, `${voiceId}.fault`, `DISPATCH-ERROR: ${detail}`)
    } catch (pe) {
      persistence_error = (pe && pe.message) || 'artifact persistence failed'
    }
    const attempt = {
      kind: 'primary',
      label: `audit-${voiceId}:${t.id}`,
      status: 'transport_error',
      verdict: 'ERROR',
      detail: persistence_error || detail,
      session_id: null,
      ...artifact,
      ...(persistence_error ? { persistence_error } : {}),
    }
    return {
      status: 'transport_error',
      verdict: 'ERROR',
      detail: attempt.detail,
      review_path: artifact.review_path,
      review_bytes: artifact.review_bytes,
      retries: 0,
      reasks: 0,
      session_id: null,
      attempts: [attempt],
    }
  }
}

const results = await pipeline(
  runnable,
  // A throw in worker dispatch would otherwise drop the item to null and it
  // would vanish from the report; capture it as a failed result instead.
  (t) => Promise.resolve()
    .then(() => agent(workerPrompt(t), {
      label: `work:${t.id}:${routes[t.id].laneName}`,
      phase: 'Work',
      agentType: cfg.agentPrefix + cfg.lanes[routes[t.id].laneName].agent,
      effort: 'low',
    }))
    .then(output => ({ output }), err => ({ threw: (err && err.message) || 'worker dispatch threw' })),
  async (res, t) => {
    const r = routes[t.id]
    const base = { id: t.id, lane: r.laneName, effort: r.effort, band: r.band, source: r.source }
    if (res && res.threw) return { ...base, output: null, approved: false, error: res.threw }
    const rawOutput = res ? res.output : null
    if (rawOutput == null) return { ...base, output: null, approved: false, error: 'worker returned null (skipped or died)' }
    const norm = normalizeWorkerOutput(rawOutput)
    if (norm.kind === 'wrapper_error') {
      return { ...base, output: norm.value, approved: false, error: 'worker lane failed — see output' }
    }
    if (norm.kind === 'empty') {
      return { ...base, output: norm.value, approved: false, error: 'worker returned empty output' }
    }
    if (norm.kind === 'error') {
      return { ...base, output: null, approved: false, error: norm.error || 'worker output unusable' }
    }
    const output = norm.value
    const voices = voicesFor(t)
    if (!voices.length) {
      if (r.audit === 'none') {
        if (doAudit) log(`audit skipped for ${t.id} (band=${r.band})`)
        return { ...base, output, approved: null }
      }
      // An audit was required (mid/high band) but no voice could run — that
      // is a failed safety gate, not an intentional skip. Never approve.
      log(`audit REQUIRED for ${t.id} (audit=${r.audit}) but no auditor available — marking not approved`)
      return { ...base, output, approved: false, error: `audit required (${r.audit}) but no auditor available` }
    }
    const votes = await parallel(voices.map(id => () => runAuditVoice(t, id, output)))
    const audit = {}
    for (let i = 0; i < voices.length; i++) {
      const id = voices[i]
      const entry = votes[i]
      if (entry && typeof entry === 'object') {
        audit[id] = entry
        continue
      }
      // Safety net: runAuditVoice is not supposed to throw/return null, but if
      // parallel still collapses a vote, emit an explicit transport_error row
      // rather than dropping the voice or the whole item.
      let artifact = { review_path: null, review_bytes: 0 }
      let persistence_error = null
      try {
        artifact = persistAuditReview(t.id, `${id}.fault`, 'DISPATCH-ERROR: auditor dispatch failed')
      } catch (e) {
        persistence_error = (e && e.message) || 'artifact persistence failed'
      }
      const attempt = {
        kind: 'primary',
        label: `audit-${id}:${t.id}`,
        status: 'transport_error',
        verdict: 'ERROR',
        detail: persistence_error || 'auditor dispatch failed',
        session_id: null,
        ...artifact,
        ...(persistence_error ? { persistence_error } : {}),
      }
      audit[id] = {
        status: 'transport_error',
        verdict: 'ERROR',
        detail: attempt.detail,
        review_path: artifact.review_path,
        review_bytes: artifact.review_bytes,
        retries: 0,
        reasks: 0,
        session_id: null,
        attempts: [attempt],
      }
    }
    // Compatibility projection only — authoritative state is per-voice status.
    const approved = voices.every(id => audit[id].status === 'pass')
    return { ...base, output, audit, approved }
  },
)

const done = results.filter(Boolean)
if (doAudit) {
  const audited = done.filter(x => x.audit)
  log(`${audited.filter(x => x.approved).length}/${audited.length} audited item(s) approved; ${done.filter(x => x.approved === null).length} skipped audit`)
}
return {
  results: done,
  rejected,
  review_root: reviewRoot,
  review_retention: REVIEW_RETENTION,
}
