# Troubleshooting

## "Agent type not found" when the workflow dispatches a task

Newly installed agents can take a moment to register. Restart the Claude
Code session and retry. For manual installs, confirm the agent files exist
in `~/.claude/agents/` and that the workflow's `agentPrefix` is `''`
(the installer sets this). For plugin installs, `agentPrefix` must be
`'ultracode-xmodel:'`.

## Every codex task returns CODEX-WRAPPER-ERROR

Run `codex login status`. Codex CLI auth is account-scoped; re-login fixes
expired sessions. Also check that the model in `CONFIG.lanes` exists in
`~/.codex/models_cache.json` — model lists change; update CONFIG rather
than the agents.

## Every grok task returns GROK-WRAPPER-ERROR with auth text

Grok CLI sessions expire periodically. Run `grok` interactively once to
re-authenticate, then re-run the workflow.

## An audit stalls or times out on large material

High-effort reviews of very large material can stall in verification
loops. Split the task into smaller units and re-run; do not raise the
auditor's effort. The partial critique returned with the timeout usually
already contains actionable findings.

## Results contain `VERDICT: NO-VERDICT`

The auditor's reply lacked a verdict line, so the relay appended
`NO-VERDICT` (which counts as not-approved). Usually the material was too
large or the critique was cut off — split the task and re-run.

## `args.tasks is empty` although tasks were passed

Pass `args` as a real JSON object, not a quoted string. The script
tolerates a JSON-encoded string, but a doubly-encoded or truncated string
fails to parse.

## Edits to the workflow script don't take effect

Invoke via `scriptPath` (as the skill instructs). Name-based workflow
invocation can serve a cached copy of the script until the next session.

## Never pass `schema:` to the relay agents

The relays return CLI output verbatim; a schema forces structured output
and breaks the verdict contract. Parse `VERDICT:` lines from the returned
text instead — the workflow already does this.
