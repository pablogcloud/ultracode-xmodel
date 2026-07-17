---
name: ultracode-xmodel-blend
description: Author and run a native Claude Code Workflow that mixes Claude nodes with short, read-only, schema-backed Codex verifier or juror nodes. Use whenever the user asks for a custom workflow that blends Claude and Codex, cross-model verification inside ultracode, Codex as a juror or second opinion, Claude discovery followed by Codex refutation, or a mixed-model loop-until-dry audit. Use ultracode-xmodel instead for batches whose primary work should run entirely on external Codex or Grok lanes.
---

# ultracode-xmodel-blend

Build a task-specific Workflow in which Claude keeps orchestration, discovery,
and synthesis while selected Codex nodes independently verify or judge results.
This mode complements `ultracode-xmodel`; it does not replace its external-task
routing and full Codex/Grok audit panel.

## Choose the right mode

Use this blended mode when Claude should retain the main workflow context and a
different model family materially improves a short verification or judgment.

Use `ultracode-xmodel` when the input is a batch of self-contained tasks whose
heavy work should run on external CLIs, especially when complexity routing and
the two-family audit panel are desired.

Skip cross-model nodes when there is no independently checkable artifact, the
node would only repeat Claude's reasoning from the same evidence, or the job is
a long implementation. A Codex node holds a Workflow concurrency slot for the
entire CLI call, so keep these nodes short and read-only.

## Required preflight

Before trusting a blended run, execute `bin/xmodel-doctor`. The structured relay
requires a usable Codex CLI. If authentication is uncertain, run one cheap
schema-backed Codex smoke before the Workflow; do not interpret an auth or
infrastructure error as a failed verdict.

## Canonical Codex node

Define this helper once near the top of the generated Workflow. One schema is
the source of truth for both Codex `--output-schema` and Workflow revalidation.
The packaged `codex-structured` relay performs the filesystem and CLI work; the
Workflow never interpolates task or schema content into a shell command.

```js
async function codexNode(taskText, {
  schema,
  model,
  cwd,
  effort = 'medium',
  phase,
  label = 'codex',
  agentPrefix = 'ultracode-xmodel:',
} = {}) {
  if (typeof taskText !== 'string' || !taskText.trim()) {
    return { _codex_error: true, error: 'taskText must be a non-empty string' }
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { _codex_error: true, error: 'schema must be an object' }
  }
  const directives = [
    model ? `MODEL: ${model}` : null,
    `EFFORT: ${effort}`,
    cwd ? `DIR: ${cwd}` : null,
    `SCHEMA_JSON: ${JSON.stringify(schema)}`,
    '---TASK---',
    taskText,
  ].filter(x => x != null).join('\n')
  try {
    const result = await agent(directives, {
      agentType: `${agentPrefix}codex-structured`,
      effort: 'low',
      phase,
      label,
      schema,
    })
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { _codex_error: true, error: 'structured relay returned non-object data' }
    }
    return result
  } catch (error) {
    return {
      _codex_error: true,
      error: (error && error.message) || 'structured Codex node failed',
    }
  }
}
```

Treat `{ _codex_error: true }` as missing infrastructure data, never as a pass,
refutation, zero score, or trustworthy result. A required verifier error must
make the overall gate inconclusive or failed.

## Routing

| Node purpose | Preferred executor |
|---|---|
| Broad discovery, exploration, synthesis | Claude |
| Adversarially verify a concrete finding | Codex node |
| Judge or score candidates | Mixed Claude + Codex jury |
| One independent attempt in a diverse panel | Codex node |
| Long implementation or resumable objective | `ultracode-xmodel` or dedicated handoff |

## Patterns

Read `references/workflow-patterns.md` before authoring the Workflow. Select the
narrowest pattern that fits:

1. Claude find → Codex verify.
2. Mixed judge panel.
3. One risky-conclusion cross-check.
4. Bounded loop-until-dry with a Codex gate.

Batch small homogeneous verdicts into one Codex node when independence between
items is not required. Fan out only when each verifier genuinely benefits from
a separate context.

## Safety and completion

- The structured relay is intentionally read-only. Route write work through the
  existing `codex-worker` flow, where sandbox selection is explicit and audited.
- Give Codex the target directory with `cwd` and name files in the prompt instead
  of copying large file contents into Workflow context.
- Use strict schemas with `additionalProperties: false` and every property named
  in `required`; malformed schemas fail before producing a verdict.
- Cap every loop and fan-out. Never create an unbounded retry or verifier loop.
- Synthesis may report only verdicts that returned schema-valid data. Surface
  infrastructure errors and degraded panels explicitly.
