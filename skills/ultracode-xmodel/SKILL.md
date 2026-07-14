---
name: ultracode-xmodel
description: Execute a list of self-contained tasks on external frontier models (Codex CLI, Grok CLI) with complexity-based effort routing and a cross-model adversarial audit panel. Use when the user asks to run tasks on external models, cross-model workers, or an adversarial cross-model review of generated work. The calling session spends tokens only on thin relays and one triage call; all heavy reasoning happens in the external models.
---

# ultracode-xmodel

Run each task in `args.tasks` on an external model lane, then subject each
result to an adversarial refute panel drawn from a different model family.

## Invocation

Invoke the Workflow tool with the script that ships alongside this skill:

    Workflow({
      scriptPath: "<this skill's base directory>/ultracode-xmodel.js",
      args: { tasks: [...], audit: true }
    })

The skill's base directory is printed when this skill loads; always pass the
absolute path.

## Task fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique task identifier |
| `prompt` | yes | Fully self-contained task text — the external CLI cannot see this session |
| `lane` | no | Force a lane: `codex-high`, `codex-medium`, `grok` (or any lane in CONFIG) |
| `effort` | no | Force worker reasoning effort |
| `complexity` | no | 1–5; supplied values skip triage scoring for this field |
| `stakes` | no | `low` or `high`; `high` always gets the full two-voice panel |
| `dir` | no | Working directory for the CLI run (plain path, no shell metacharacters) |
| `sandbox` | no | `read-only` (default) or `workspace-write` |

Tasks missing routing fields are scored by one batch triage call and routed
by the mapping table (see README "Effort routing"). Explicit fields are
never overridden.

## Options

- `audit: false` — skip all auditing (results return `approved: null`).
- `config: {...}` — deep-merged over the script's CONFIG block. Examples:
  `{ config: { agentPrefix: '' } }` for manually installed agents;
  `{ config: { auditors: { grok: null } } }` to drop an audit voice;
  `{ config: { lanes: { 'codex-high': { directives: { MODEL: 'a-newer-model' } } } } }`
  after a model refresh.

## Reading results

Each result carries `id`, `lane`, `effort`, `band`, `output`, `audit`
(verdict per voice), and `approved`:

- `approved: true` — every audit voice returned `VERDICT: PASS`.
- `approved: false` — a voice found a defect, returned no verdict, or the
  worker lane failed (`error` is set).
- `approved: null` — auditing was skipped (low band or `audit: false`).

Treat `approved: false` items as rework: fix the task prompt or split the
task, then re-run just those items.

## Prerequisites

Codex CLI and/or Grok CLI installed and authenticated. Run `xmodel-doctor`
(ships with the plugin) to verify. With a single CLI family installed, run
`xmodel-doctor --config` and pass its output as the `config` option so
lanes and audit voices match what is actually available; the panel then
runs with one voice and the run log says so.
