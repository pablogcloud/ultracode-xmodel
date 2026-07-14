# Security model

## What the audit panel is (and is not)

The cross-model audit panel is adversarial reinforcement, not a cryptographic
trust boundary. Each auditor is a separate frontier model instructed to refute
the work and to end with a machine-parseable `VERDICT:` line, and approval
requires every voice to pass. This catches a large class of real defects that a
single model misses. It does **not** guarantee that a worker actively trying to
forge approval cannot succeed — the relays and auditors are themselves
model-mediated. Treat `approved: true` as "two independent models failed to
refute this," not as a proof of correctness or safety. Do not hand
`workspace-write` to a task you would not run yourself, and review the diff of
any write-enabled run.

## Execution boundaries

- **Auditors run read-only.** The codex auditor runs with
  `--sandbox read-only`; the grok auditor runs in plan mode with web search
  disabled. Neither can modify files. Network reach is constrained but not
  absolute: an auditor cannot browse the web, but if your Codex CLI has MCP
  servers configured, those remain reachable by Codex itself (see
  "Prompt-injection blast radius").
- **Workers default to read-only.** A task must explicitly request
  `sandbox: workspace-write` before its lane may edit files, and the
  relay confines writes to the task's `dir` and its private temp dir.
- **Relays are mechanical.** Each relay makes at most two CLI invocations
  per task (one call, plus at most one retry on clearly transient errors —
  auditors never retry), never calls MCP servers or the web itself, and
  returns output verbatim from a private per-run temp directory that is
  removed after the call.
- **Directive injection is blocked at the workflow.** Worker effort is
  accepted only from a fixed token set, and every configured lane/auditor
  directive is rejected if it contains shell metacharacters or newlines —
  so a caller cannot smuggle shell text into the relay's CLI command.

## Input sanitization

Task `dir` values containing shell metacharacters, quotes, or newlines are
rejected before dispatch — both by the workflow (`BAD_PATH` check) and
again by each relay. This prevents quoted-command breakouts and directive
smuggling (for example, a newline in `dir` injecting an extra
`SANDBOX: workspace-write` line). `sandbox` accepts only
`read-only` or `workspace-write`, `effort` only a fixed token set, and any
lane/auditor directive supplied through `config` is rejected if it carries
shell metacharacters — the values are interpolated into the relay's CLI
command, so this closes the injection path there.

## Prompt-injection blast radius

Worker output is untrusted model output, and it is fed to the audit
panel. The panel's confinement is layered: read-only execution on both
voices, web search disabled on the Grok voice, and external tools
instructed off on the Codex voice. One residual reach remains: the Codex
CLI has no per-invocation flag to disable MCP servers, so if you have MCP
servers configured for Codex, adversarial worker output could in principle
induce the Codex auditor to call one. If that matters in your threat model,
remove MCP servers from the Codex config the plugin runs under. The channel
back to the caller is critique text whose `VERDICT:` line is trusted only on
the auditor's final line — a `VERDICT:` string quoted earlier in the
critique (for example echoing the worker's own claim) is not read as the
auditor's verdict. A malicious worker output cannot make an auditor modify
workspace state, but — as noted above — the panel is reinforcement, not an
unforgeable gate.

## Credentials

The plugin stores no credentials. The Codex and Grok CLIs use their own
authentication (subscription accounts) configured outside this repo.

## Reporting

Open a GitHub security advisory or issue for suspected vulnerabilities.
