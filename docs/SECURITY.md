# Security model

## Execution boundaries

- **Auditors are always read-only.** The codex auditor runs with
  `--sandbox read-only`; the grok auditor runs in plan mode with web
  search disabled. Audit voices cannot modify files or reach the network.
- **Workers default to read-only.** A task must explicitly request
  `sandbox: workspace-write` before its lane may edit files, and the
  relay confines writes to the task's `dir` and `/tmp`.
- **Relays are mechanical.** Each relay makes at most two CLI invocations
  per task (one call, plus at most one retry on clearly transient errors),
  never calls MCP servers or the web itself, and returns output verbatim.

## Input sanitization

Task `dir` values containing shell metacharacters, quotes, or newlines are
rejected before dispatch — both by the workflow (`BAD_PATH` check) and
again by each relay. This prevents quoted-command breakouts and directive
smuggling (for example, a newline in `dir` injecting an extra
`SANDBOX: workspace-write` line). `sandbox` accepts only
`read-only` or `workspace-write`.

## Prompt-injection blast radius

Worker output is untrusted model output, and it is fed to the audit
panel. The panel's confinement is layered: read-only execution on both
voices, web search disabled on the Grok voice, and external tools
instructed off on the Codex voice (plus a config-level MCP disable on the
audit invocation where the Codex CLI supports one — if your Codex CLI has
MCP servers configured and no such override, those remain reachable by
Codex itself; remove them from its config if that matters in your threat
model). The expected channel back to the caller is critique text whose
`VERDICT:` line is parsed with a fixed pattern. A malicious worker output
can at worst mislabel itself — it cannot make an auditor modify workspace
state.

## Credentials

The plugin stores no credentials. The Codex and Grok CLIs use their own
authentication (subscription accounts) configured outside this repo.

## Reporting

Open a GitHub security advisory or issue for suspected vulnerabilities.
