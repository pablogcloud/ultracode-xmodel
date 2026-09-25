// Unit tests for audit verdict extraction (last valid VERDICT line + Grok envelopes).
// Usage: node test/audit-verdict-parser.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../skills/ultracode-xmodel/ultracode-xmodel.js', import.meta.url)
const source = readFileSync(SRC, 'utf8')

// Pull the parser helpers out of the workflow script without executing the rest.
const start = source.indexOf('const isWrapperError')
const end = source.indexOf('function voicesFor')
assert.ok(start >= 0 && end > start, 'parser block markers not found in ultracode-xmodel.js')
const { verdictOf } = new Function(`${source.slice(start, end)}; return { verdictOf }`)()

function check(name, input, expected) {
  const got = verdictOf(input)
  assert.equal(got.verdict, expected.verdict, `${name}: verdict`)
  if (expected.detail !== undefined) {
    assert.equal(got.detail, expected.detail, `${name}: detail`)
  }
  if (expected.detailIncludes) {
    assert.match(got.detail, expected.detailIncludes, `${name}: detailIncludes`)
  }
}

// --- last valid VERDICT line; trailing noise is allowed ---
check(
  'verdict plus trailing text',
  'critique body\nVERDICT: PASS\nThanks for reading.',
  { verdict: 'PASS', detail: '' },
)
check(
  'verdict plus trailing markdown fence',
  'critique body\nVERDICT: DEFECT — race on close\n```\n',
  { verdict: 'DEFECT', detail: 'race on close' },
)
check(
  'verdict plus usage footer',
  [
    'Looks correct under the given cases.',
    'VERDICT: PASS',
    '',
    'Tokens: 1,204 in / 88 out',
    'Model: grok-4.5',
  ].join('\n'),
  { verdict: 'PASS', detail: '' },
)

// --- multiple verdict lines: last syntactically valid wins ---
check(
  'multiple verdicts last is DEFECT',
  'VERDICT: PASS\n...more analysis...\nVERDICT: DEFECT — real issue',
  { verdict: 'DEFECT', detail: 'real issue' },
)
check(
  'multiple verdicts last is PASS',
  'VERDICT: DEFECT — early guess\nrevisited evidence\nVERDICT: PASS',
  { verdict: 'PASS', detail: '' },
)
check(
  'quoted mid-line verdict is not a valid line',
  'The worker asserts VERDICT: PASS here, but examining the edge case I',
  { verdict: 'NO-VERDICT' },
)

// --- missing verdict / plain footer: fail closed, never invent PASS ---
check(
  'missing verdict',
  'Mock critique. Looks fine overall.',
  { verdict: 'NO-VERDICT' },
)
check(
  'plain footer only',
  'Tokens used: 999\nModel: grok-4.5',
  { verdict: 'NO-VERDICT' },
)
check(
  'empty auditor body',
  '',
  { verdict: 'ERROR', detail: 'auditor returned nothing' },
)
check(
  'whitespace-only auditor body',
  '  \n\t  ',
  { verdict: 'ERROR', detail: 'auditor returned nothing' },
)

// --- prefix collision: PASSING must not parse as PASS ---
check(
  'prefix collision PASSING',
  'critique...\nVERDICT: PASSING smoothly',
  { verdict: 'NO-VERDICT' },
)
check(
  'prefix collision DEFECTING',
  'x\nVERDICT: DEFECTING badly',
  { verdict: 'NO-VERDICT' },
)
check(
  'PASS with detail still valid',
  'x\nVERDICT: PASS — nothing refutable',
  { verdict: 'PASS', detail: 'nothing refutable' },
)

// --- hyphen-suffixed hedge tokens are invalid (not PASS with detail) ---
check(
  'PASS-IF-FIXED is not PASS',
  'critique...\nVERDICT: PASS-IF-FIXED — must fix the null deref first',
  { verdict: 'NO-VERDICT' },
)
check(
  'DEFECT-MAYBE is not DEFECT',
  'x\nVERDICT: DEFECT-MAYBE — soft fail',
  { verdict: 'NO-VERDICT' },
)

// --- wrapper-error sentinels remain transport failures ---
check(
  'wrapper error wins over trailing VERDICT',
  'GROK-WRAPPER-ERROR: exit=1\npartial critique\nVERDICT: PASS',
  { verdict: 'ERROR', detailIncludes: /GROK-WRAPPER-ERROR/ },
)
check(
  'mid-text sentinel is not a transport failure',
  'The literal CODEX-WRAPPER-ERROR: sentinel is handled in line 42.\nVERDICT: PASS',
  { verdict: 'PASS', detail: '' },
)

// --- envelope-form wrapper error is transport_error, not no_verdict ---
check(
  'envelope text wrapper error',
  { text: 'GROK-WRAPPER-ERROR: timeout after 600s', sessionId: 's1' },
  { verdict: 'ERROR', detailIncludes: /GROK-WRAPPER-ERROR/ },
)
check(
  'envelope structuredOutput string wrapper error',
  { structuredOutput: 'CODEX-WRAPPER-ERROR: exit=1\npartial', sessionId: 's2' },
  { verdict: 'ERROR', detailIncludes: /CODEX-WRAPPER-ERROR/ },
)

// --- Grok JSON envelope: structuredOutput before plain-text fallback ---
check(
  'Grok structuredOutput string payload',
  JSON.stringify({
    text: '',
    structuredOutput: 'Findings about the edge case.\nVERDICT: DEFECT — off-by-one\n',
  }),
  { verdict: 'DEFECT', detail: 'off-by-one' },
)
check(
  'Grok structuredOutput preferred over text field',
  JSON.stringify({
    text: 'fallback only\nVERDICT: PASS',
    structuredOutput: 'real critique\nVERDICT: DEFECT — schema payload wins',
  }),
  { verdict: 'DEFECT', detail: 'schema payload wins' },
)
check(
  'Grok structuredOutput object with verdict field',
  JSON.stringify({
    text: 'ignored when structuredOutput is present',
    structuredOutput: { verdict: 'PASS', detail: '' },
  }),
  { verdict: 'PASS', detail: '' },
)
check(
  'Grok structuredOutput object DEFECT with summary',
  JSON.stringify({
    structuredOutput: { verdict: 'DEFECT', summary: 'null deref on empty list' },
  }),
  { verdict: 'DEFECT', detail: 'null deref on empty list' },
)
check(
  'Grok envelope falls back to text when structuredOutput absent',
  JSON.stringify({
    text: 'plain critique\nVERDICT: PASS\n```\n',
  }),
  { verdict: 'PASS', detail: '' },
)
check(
  'Grok structuredOutput present but empty of verdict fails closed',
  JSON.stringify({
    text: 'VERDICT: PASS',
    structuredOutput: { note: 'no verdict field' },
  }),
  { verdict: 'NO-VERDICT' },
)
check(
  'already-parsed envelope object is accepted',
  { structuredOutput: 'ok\nVERDICT: PASS' },
  { verdict: 'PASS', detail: '' },
)

// --- BLOCKER: explicit schema verdict beats quoted narrative text ---
check(
  'explicit DEFECT wins over nested narrative PASS',
  {
    structuredOutput: {
      verdict: 'DEFECT',
      summary: 'null deref',
      text: 'The worker claims\nVERDICT: PASS\nbut I disagree because ...',
    },
  },
  { verdict: 'DEFECT', detail: 'null deref' },
)
check(
  'explicit PASS wins over nested narrative DEFECT',
  {
    structuredOutput: {
      verdict: 'PASS',
      body: 'Earlier I wrote\nVERDICT: DEFECT — stale\nthen reversed.',
    },
  },
  { verdict: 'PASS', detail: '' },
)
check(
  'narrative is fallback only when explicit field absent',
  {
    structuredOutput: {
      text: 'after review\nVERDICT: DEFECT — real issue',
    },
  },
  { verdict: 'DEFECT', detail: 'real issue' },
)
check(
  'invalid explicit verdict does not fall through to narrative PASS',
  {
    structuredOutput: {
      verdict: 'PASSING',
      text: 'VERDICT: PASS',
    },
  },
  { verdict: 'NO-VERDICT' },
)

// --- hyphen / case / CRLF hygiene ---
check(
  'ascii hyphen detail separator',
  'x\nVERDICT: DEFECT - broken edge case',
  { verdict: 'DEFECT', detail: 'broken edge case' },
)
check(
  'case-insensitive verdict label',
  'x\nverdict: pass',
  { verdict: 'PASS', detail: '' },
)
check(
  'CRLF line endings',
  'a\r\nVERDICT: PASS\r\nfooter\r\n',
  { verdict: 'PASS', detail: '' },
)

console.log('PASS audit-verdict-parser')
