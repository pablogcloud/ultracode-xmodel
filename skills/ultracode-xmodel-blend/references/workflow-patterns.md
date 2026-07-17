# Blended Workflow patterns

Use the canonical `codexNode` helper from `../SKILL.md` in each pattern. Adapt
the task, dimensions, and schemas; preserve the error discipline and bounded
control flow.

## 1. Claude find, Codex verify

Claude searches broadly. Codex independently attempts to refute each proposed
finding. Only schema-valid, non-refuted findings survive.

```js
const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['id', 'title', 'detail', 'file'],
    properties: {
      id: { type: 'string' }, title: { type: 'string' },
      detail: { type: 'string' }, file: { type: 'string' },
    },
  } } },
}
const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['refuted', 'reasoning'],
  properties: {
    refuted: { type: 'boolean' }, reasoning: { type: 'string' },
  },
}

const reviews = await parallel(DIMENSIONS.map(d => () =>
  agent(d.prompt, { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS })))
const proposed = reviews.filter(Boolean).flatMap(r => r.findings || [])
const checked = await parallel(proposed.map(f => () =>
  codexNode(
    `Independently verify this finding from the repository. Default to refuted=true when evidence is insufficient.\n${JSON.stringify(f)}`,
    { schema: VERDICT, cwd: TARGET_DIR, phase: 'Verify', label: `verify:${f.id}` },
  ).then(verdict => ({ ...f, verdict }))))
const completed = checked.filter(Boolean)
const verifierErrors = completed.filter(x => x.verdict?._codex_error)
const confirmed = completed.filter(x => x.verdict && !x.verdict._codex_error && !x.verdict.refuted)
return { proposed: proposed.length, confirmed, verifierErrors }
```

## 2. Mixed judge panel

Do not let a model be the only judge of its own output. Exclude infrastructure
errors from scoring, and fail the gate if the required independent juror is
missing.

```js
const SCORE = {
  type: 'object', additionalProperties: false,
  required: ['score', 'reasoning'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 10 },
    reasoning: { type: 'string' },
  },
}
const judged = await parallel(candidates.map((candidate, index) => () =>
  parallel([
    () => agent(`Score this candidate against the rubric:\n${JSON.stringify(candidate)}`,
      { label: `judge:claude:${index}`, phase: 'Judge', schema: SCORE }),
    () => codexNode(`Independently score this candidate against the rubric:\n${JSON.stringify(candidate)}`,
      { schema: SCORE, cwd: TARGET_DIR, phase: 'Judge', label: `judge:codex:${index}` }),
  ]).then(([claudeScore, codexScore]) => {
    if (!codexScore || codexScore._codex_error) {
      return { candidate, eligible: false, error: 'independent juror unavailable' }
    }
    const scores = [claudeScore, codexScore].filter(Boolean)
    const average = scores.reduce((sum, x) => sum + x.score, 0) / scores.length
    return { candidate, eligible: true, average, scores }
  })))
const eligible = judged.filter(Boolean).filter(x => x.eligible).sort((a, b) => b.average - a.average)
return { winner: eligible[0] || null, judged }
```

## 3. One risky-conclusion cross-check

```js
const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['refuted', 'reasoning'],
  properties: {
    refuted: { type: 'boolean' }, reasoning: { type: 'string' },
  },
}
const conclusion = await agent('Analyze the evidence and state one headline conclusion.')
const verdict = await codexNode(
  `Try to refute this conclusion using independent repository evidence. Default to refuted=true if evidence is insufficient.\n\n${conclusion}`,
  { schema: VERDICT, cwd: TARGET_DIR, phase: 'Cross-check', label: 'cross-check' },
)
return {
  conclusion,
  verdict,
  trustworthy: Boolean(verdict && !verdict._codex_error && !verdict.refuted),
}
```

## 4. Bounded loop-until-dry

```js
const MAX_ROUNDS = 4
const seen = new Set()
const confirmed = []
let roundsUsed = 0
let dry = false
for (let round = 0; round < MAX_ROUNDS; round++) {
  roundsUsed = round + 1
  phase(`Round ${roundsUsed}`)
  const review = await agent(
    `Find new issues. Do not repeat these stable ids: ${[...seen].join(', ') || '(none)'}`,
    { schema: FINDINGS, label: `find:${round}` },
  )
  const fresh = (review?.findings || []).filter(f => !seen.has(f.id))
  if (!fresh.length) { dry = true; break }
  fresh.forEach(f => seen.add(f.id))
  const checked = await parallel(fresh.map(f => () =>
    codexNode(`Independently verify:\n${JSON.stringify(f)}`,
      { schema: VERDICT, cwd: TARGET_DIR, label: `verify:${f.id}` })
      .then(verdict => ({ ...f, verdict }))))
  confirmed.push(...checked.filter(Boolean).filter(x =>
    x.verdict && !x.verdict._codex_error && !x.verdict.refuted))
}
return { confirmed, roundsUsed, exhausted: dry }
```

## Batch variant

When findings are small and homogeneous, define a strict `{ results: [...] }`
schema and send all items in one `codexNode` call. Verify that every requested id
appears exactly once before joining results back to inputs; missing, duplicate,
or extra ids make the batch inconclusive.
