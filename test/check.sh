#!/usr/bin/env bash
# Static checks: agent frontmatter, JSON manifests, shell scripts, JS syntax.
set -u
fail=0
err() { echo "FAIL: $1"; fail=1; }

# --- JSON manifests ---
for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
  if command -v jq >/dev/null 2>&1; then
    jq . "$f" >/dev/null 2>&1 || err "$f is not valid JSON"
  else
    node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || err "$f is not valid JSON"
  fi
done

# --- Agent frontmatter ---
for f in agents/codex-worker.md agents/grok-worker.md agents/codex-auditor.md agents/grok-auditor.md; do
  [ -f "$f" ] || { err "$f missing"; continue; }
  head -1 "$f" | grep -q '^---$' || err "$f: no frontmatter"
  grep -q '^name: ' "$f" || err "$f: no name"
  grep -q '^model: haiku$' "$f" || err "$f: relay must pin model: haiku"
  grep -q '^tools: Write, Read, Bash$' "$f" || err "$f: relay tools must be Write, Read, Bash"
  grep -q 'VERBATIM' "$f" || err "$f: verbatim contract text missing"
done
for f in agents/codex-auditor.md agents/grok-auditor.md; do
  grep -q 'VERDICT: NO-VERDICT' "$f" || err "$f: NO-VERDICT fallback missing"
done

# --- Relay temp-file contract (private per-run dirs, cleanup, verbatim) ---
relay_check_common() {
  f="$1"
  grep -q 'mktemp -d' "$f" || err "$f: relay must create a private dir with mktemp -d"
  grep -q 'rm -rf' "$f" || err "$f: relay must clean up its private dir with rm -rf"
  grep -Eq 'metacharacters' "$f" || err "$f: relay must refuse DIR containing shell metacharacters"
  grep -Eq 'VERBATIM|byte-for-byte' "$f" || err "$f: relay must return output VERBATIM/byte-for-byte"
}
for f in agents/codex-worker.md agents/codex-auditor.md; do
  [ -f "$f" ] || continue
  relay_check_common "$f"
  grep -q -- '--sandbox' "$f" || err "$f: relay must pass --sandbox"
done
for f in agents/grok-worker.md agents/grok-auditor.md; do
  [ -f "$f" ] || continue
  relay_check_common "$f"
  grep -q -- '--permission-mode' "$f" || err "$f: relay must pass --permission-mode"
done
grep -q 'read-only' agents/codex-auditor.md || err "agents/codex-auditor.md: auditor must run sandbox read-only"
grep -q 'plan' agents/grok-auditor.md || err "agents/grok-auditor.md: auditor must run permission-mode plan"

# --- Workflow JS syntax + meta literal (present from Task 4 on) ---
if [ -f skills/ultracode-xmodel/ultracode-xmodel.js ]; then
  # Workflow scripts run inside an async wrapper with top-level `return`,
  # so they are not standalone modules — compile them the same way the
  # runtime (and test/harness.mjs) does instead of `node --check`.
  node -e '
    const fs = require("fs");
    const body = fs.readFileSync("skills/ultracode-xmodel/ultracode-xmodel.js", "utf8")
      .replace(/^export /m, "");
    try {
      new Function("args", "agent", "parallel", "pipeline", "phase", "log", "budget",
        "return (async () => { " + body + " })()");
    } catch (e) { console.error("workflow syntax error: " + e.message); process.exit(1); }
  ' || err "workflow syntax error"
  # Best-effort meta lint: the meta block must evaluate as a bare object
  # literal (free identifiers throw) and carry name + description strings.
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync("skills/ultracode-xmodel/ultracode-xmodel.js", "utf8");
    const m = src.match(/export const meta = (\{[\s\S]*?\n\})\n/);
    if (!m) { console.error("meta block not found"); process.exit(1); }
    let obj;
    try { obj = new Function("\"use strict\"; return (" + m[1] + ")")(); }
    catch (e) { console.error("meta is not a pure literal: " + e.message); process.exit(1); }
    for (const k of ["name", "description"]) {
      if (typeof obj[k] !== "string") { console.error("meta." + k + " missing"); process.exit(1); }
    }
  ' || err "workflow meta lint failed"
fi

# --- Shell scripts ---
if command -v shellcheck >/dev/null 2>&1; then
  for f in test/check.sh install.sh bin/xmodel-doctor test/mock-cli/codex test/mock-cli/grok test/run-mock-checks.sh; do
    [ -f "$f" ] && { shellcheck "$f" || err "shellcheck: $f"; }
  done
else
  echo "note: shellcheck not installed; skipping shell lint"
fi

[ "$fail" -eq 0 ] && echo "check.sh: all checks passed"
exit "$fail"
