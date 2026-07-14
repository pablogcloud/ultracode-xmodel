# ultracode-xmodel — public repo design

Date: 2026-07-14
Status: approved pending Pablo's spec review
Origin: private setup shipped 2026-07-11 (workflow `~/.claude/workflows/ultracode-xmodel.js` + 4 relay agents in `~/.claude/agents/`), E2E-verified same day.

## 1. Goal

Publish the cross-model ultracode system as a public GitHub repo (`pablogcloud/ultracode-xmodel`, MIT) so any Claude Code user with the Codex and/or Grok CLIs can run it, and add the missing **effort-management layer** that assigns lane, worker effort, and audit depth from task complexity instead of requiring the caller to hand-pick lanes.

What the system is: Claude Code stays orchestrator-only; self-contained tasks execute on external models (Codex `gpt-5.6-terra`, Grok 4.5) through thin haiku relay agents that shell out to subscription-authenticated CLIs; each result faces a two-voice cross-model adversarial refute panel (Grok 4.5 + Codex `gpt-5.6-sol`); `approved = both PASS`.

## 2. Distribution — plugin-first, scriptPath invocation

Facts (verified against docs 2026-07-14):

- Plugins CANNOT ship workflows; workflows load only from `~/.claude/workflows/` or project `.claude/workflows/` (https://code.claude.com/docs/en/workflows.md).
- Plugins CAN ship `agents/`, `skills/`, `bin/`, hooks, `.mcp.json`, `settings.json` (https://code.claude.com/docs/en/plugins.md#plugin-structure-overview).
- The Workflow tool accepts `scriptPath` pointing at any on-disk file, and a skill is told its own base directory at invocation time.

Decision: ship the workflow `.js` **inside the plugin's skill directory**. SKILL.md instructs the orchestrator to invoke `Workflow({ scriptPath: "<skill base dir>/ultracode-xmodel.js", args })`. Install is one command pair:

```
/plugin marketplace add pablogcloud/ultracode-xmodel
/plugin install ultracode-xmodel
```

Benefits: no separate workflow install step; scriptPath invocation always reads the current file, sidestepping the stale named-workflow-registry snapshot trap. `install.sh` remains for non-plugin users: it copies the agents into `~/.claude/agents/` and the skill directory (SKILL.md + co-located workflow script, with `agentPrefix` rewritten to `''`) into `~/.claude/skills/` — the workflow is always invoked via scriptPath from the skill directory, so nothing is placed in `~/.claude/workflows/`.

Agent namespacing: plugin-shipped agents resolve as `ultracode-xmodel:codex-worker` (same pattern as `codex:codex-rescue`); manual installs resolve as `codex-worker`. The script carries one `AGENT_PREFIX` constant (default `'ultracode-xmodel:'`, set to `''` for manual installs). The smoke test verifies the plugin-namespaced form.

## 3. Repo layout

```
ultracode-xmodel/
├── .claude-plugin/
│   ├── plugin.json              # plugin manifest
│   └── marketplace.json         # single-entry marketplace, source "./"
├── agents/
│   ├── codex-worker.md          # genericized: MODEL:/EFFORT:/SANDBOX:/DIR: directives
│   ├── codex-auditor.md         # gains MODEL: directive (default gpt-5.6-sol)
│   ├── grok-worker.md
│   └── grok-auditor.md          # gains MODEL: directive (default grok-4.5)
├── skills/ultracode-xmodel/
│   ├── SKILL.md                 # when to use, args contract, scriptPath invocation, examples
│   └── ultracode-xmodel.js      # the workflow (triage + work + audit phases)
├── bin/
│   └── xmodel-doctor            # CLI presence, auth freshness, model availability checks
├── install.sh                   # non-plugin path: copy into ~/.claude/
├── test/
│   ├── mock-cli/                # stub `codex` and `grok` executables, canned outputs
│   ├── run-mock-e2e.sh          # full pipeline against mocks (CI-safe)
│   └── SMOKE.md                 # real-CLI smoke recipe (1 codex + 1 grok task, audit on)
├── docs/
│   ├── TROUBLESHOOTING.md
│   ├── SECURITY.md
│   └── assets/                  # generated banner + diagrams' exported fallbacks
├── .github/workflows/ci.yml
├── README.md
├── CONTRIBUTING.md
└── LICENSE                      # MIT
```

## 4. Effort-management layer (new feature)

### Task schema (additive, backward compatible)

```
{ id, prompt, lane?, effort?, stakes?: "low"|"high", complexity?: 1..5, dir?, sandbox? }
```

Explicit values are never overridden; triage fills only the missing fields. A task with ALL routing fields present (`lane`, `effort`, and either an explicit audit depth via `stakes`/`complexity` or global `audit:false`) is excluded from the triage batch entirely (today's behavior). Partial labels — e.g. `lane` without `effort` — keep the given values and triage supplies the rest.

### Triage phase

One batch `agent()` call before Work — a plain Claude subagent (`model: haiku`, `schema`-validated; NOT a relay, since relays are verbatim-only and must never get `schema:`). Input: id + prompt of every task missing labels. Output per task: `{ id, complexity: 1-5, stakes: "low"|"high", rationale }`. One call regardless of N.

Rationale for haiku over local-tier: portability — public users have no LiteLLM front door. (Pablo's local install may later override triage routing; out of scope for v1.)

### Mapping table (config block in the script)

| Triage result | Lane | Worker effort | Audit |
|---|---|---|---|
| complexity 1–2 AND low stakes | cheapest lane | medium | skipped (logged) |
| complexity 3, low stakes | default lane | high | single voice |
| complexity 4–5 OR high stakes | strongest lane | high | two-voice panel, both-PASS |

Invariants:
- High stakes floors audit at two voices regardless of complexity.
- Triage failure (null/invalid) → all affected tasks default to strongest lane + full panel. Fail-safe escalates, never degrades.
- The routing table is `log()`ed before dispatch — no silent routing.
- `audit: false` in args still disables auditing globally (today's contract).
- Single-voice audit picks the auditor whose base model did NOT produce the work (cross-model invariant preserved).

## 5. Config-driven lanes

Workflow scripts have no filesystem access, so config is a clearly-marked `CONFIG` block at the top of the `.js` (lanes: agentType, directives, model ids; `cheapest`/`default`/`strongest` role pointers; `AGENT_PREFIX`), overridable per-run via `args.config` (deep-merged, same shape). SKILL.md documents both surfaces.

Relay genericization: model pins move out of agent prose into directives with defaults (`codex-auditor` and `grok-auditor` gain `MODEL:`). Model churn becomes a config edit.

Graceful degradation: `xmodel-doctor` reports which CLIs are installed/authed. With one CLI missing, worker lanes for it are unavailable and the audit panel drops to a single voice; the workflow logs explicitly that cross-model refutation is degraded when worker and auditor share a base model. Adding a third lane (e.g. Gemini CLI) is documented as: one new relay agent .md following the pattern + one CONFIG entry. No adapter abstraction in v1 (YAGNI — the lane spec is the seam).

## 6. Security

Carried forward and documented in SECURITY.md:
- `BAD_PATH` rejection of `dir` values containing shell metacharacters/newlines (blocks directive smuggling, e.g. a newline injecting `SANDBOX: workspace-write`).
- Sandbox allowlist (`read-only` | `workspace-write`); auditors always read-only, workers write-enabled only per-task.
- Relays: one CLI invocation per task, no MCP/web calls of their own, quoting rules, refuse-on-metacharacters.
- Prompt-injection blast radius: worker output feeds auditors, but auditors cannot write or reach the web.
- No secrets in the repo; CLIs authenticate via their own subscriptions.

## 7. README + diagrams + visual assets

README sections: what/why (cross-model adversarial execution, orchestrator spends ~0 Claude tokens on reasoning), how it works, quickstart, args contract with examples, effort-layer explanation (the mapping table), configuration, degraded modes, FAQ, troubleshooting pointer.

Attribution (top of README, directly after title + description, mirroring github.com/coreyhaines31/marketingskills): a "Built by FORMM Labs" paragraph with a link to formm.mx — FORMM Labs presented as the research division of FORMM Creative Group, constantly building AI tools to implement across all operational aspects and ultimately to transform the construction and development industry. Manifest author and license holder carry the FORMM identity (author: FORMM Labs; MIT holder: FORMM Creative Group).

Voice (applies to ALL shipped files — README, SKILL.md, docs/, code comments): professional public open-source tone, written like a polished GitHub project. State how the system works and how to use it; never narrate platform gaps, workarounds, internal history, or what the repo does not contain (e.g. no "plugins can't ship workflows, so..." explanations — the install and invocation instructions simply ARE the way it works). Rationale and meta-notes live only in this spec, not in shipped files.

Mermaid diagrams (render natively on GitHub; exported PNG fallbacks in docs/assets/):
1. **Architecture**: orchestrator → workflow script → relay agents (haiku) → external CLIs → audit panel → approved/rejected.
2. **Effort flow**: tasks → batch triage → mapping table → lane/effort/audit-depth assignment.
3. **Task lifecycle sequence**: one task from dispatch through worker output, dual audit, verdict parse, approval.

Visual assets via the image-gen skill (Codex `gpt-image-2`, subscription quota): one hero banner for the README top, optionally one social-preview image. Process constraint: image-gen shows the constructed prompt for confirmation BEFORE generating — those confirmations happen at implementation time. Style: professional, dark, no fake UI screenshots, no vendor logos (trademark hygiene: refer to "Codex CLI"/"Grok CLI" in text; do not use OpenAI/xAI logos in generated art).

## 8. Testing and CI

- **Mock mode**: `test/mock-cli/` provides stub `codex`/`grok` executables (canned last-message files, VERDICT lines, controllable exit codes). `run-mock-e2e.sh` prepends them to PATH and drives the full pipeline — triage mapping, dispatch, verdict parsing, degradation paths — without subscriptions. CI runs this.
- **Static checks in CI**: `node --check` on the workflow script, meta-literal lint, agent frontmatter lint, `shellcheck` on installer/doctor/mock scripts.
- **Real smoke (manual, documented in SMOKE.md)**: one codex-lane + one grok-lane trivial task, audit on, expect both approved. Run on this Mac before tagging releases.

## 9. v1 acceptance gate (machine-checkable)

1. Mock-mode e2e green in CI on a clean runner.
2. `xmodel-doctor` passes on formm-mac; real smoke run ends with both items approved.
3. Fresh-install test: plugin install into a clean `.claude` sandbox; skill invokes workflow via scriptPath; agents resolve with the plugin namespace.
4. README quickstart followed verbatim by a critic agent surfaces no missing steps.
5. Cross-model gate: Codex reviews the full repo (script, agents, installer, README) before the repo goes public; findings resolved or consciously waived.

## 10. Troubleshooting content (paid-for traps, genericized)

- Agent registry may not see newly installed agent .md files immediately (hot-load delay; restart session if "Agent type not found").
- Workflow `args` can arrive as a JSON-encoded string — the script keeps the JSON.parse fallback.
- Named-workflow registry serves stale snapshots after edits — invoke via scriptPath (the shipped default).
- Grok OIDC token expires ~daily — auth-flavored GROK-WRAPPER-ERROR means re-login interactively.
- Never pass `schema:` to relay agentTypes (verbatim contract); parse VERDICT lines in the script.
- Codex high-effort audits can stall on large material — split the material, don't raise effort.
- Model names drift — check `~/.codex/models_cache.json` / `grok models`; update CONFIG, not code.

## 11. Out of scope for v1

- Generic CLI adapter interface (documented lane-addition recipe instead).
- Local-tier (LiteLLM) triage routing.
- Upstream feature request for workflows-in-plugins (file it, don't wait on it).
- Windows support beyond "PRs welcome" (relays assume POSIX shell quoting).

## 12. Migration of Pablo's own setup

The repo becomes canonical for the 4 agents + workflow (currently Mac-local only, unmanaged by agent-config sync). Local machines consume it via the plugin (or install.sh); `~/agent-config` gets a pointer note; FORMM01 propagation happens through the repo instead of the pending agent-config PR. The existing `~/.claude/agents/*.md` and `~/.claude/workflows/ultracode-xmodel.js` are retired after the plugin install is verified locally, to avoid two competing copies.
