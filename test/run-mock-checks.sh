#!/usr/bin/env bash
# Verifies the mock CLIs enforce the exact invocation shapes the relay
# agents use, so local mock-PATH pipeline runs exercise the real contract.
# Model IDs here are deliberately arbitrary: the mocks echo whatever they
# receive, so these checks never encode production model names.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
cm="any-codex-model"
gm="any-grok-model"

# codex worker shape (model echoed dynamically)
printf 'do the thing' | ./mock-cli/codex exec --sandbox read-only --skip-git-repo-check \
  -C "$tmp" -m "$cm" -c model_reasoning_effort=high -o "$tmp/last.md" - >/dev/null
grep -q "MOCK WORK OUTPUT ($cm)" "$tmp/last.md" || { echo "FAIL codex worker shape"; fail=1; }

# codex auditor shape (PASS and DEFECT)
printf -- '--- MATERIAL UNDER AUDIT ---\nfine work' | ./mock-cli/codex exec --sandbox read-only \
  --skip-git-repo-check -C "$tmp" -m "$cm" -c model_reasoning_effort=high -o "$tmp/a.md" - >/dev/null
grep -q 'VERDICT: PASS' "$tmp/a.md" || { echo "FAIL codex audit PASS"; fail=1; }
printf -- '--- MATERIAL UNDER AUDIT ---\nINJECT_DEFECT' | ./mock-cli/codex exec --sandbox read-only \
  --skip-git-repo-check -C "$tmp" -m "$cm" -c model_reasoning_effort=high -o "$tmp/b.md" - >/dev/null
grep -q 'VERDICT: DEFECT' "$tmp/b.md" || { echo "FAIL codex audit DEFECT"; fail=1; }

# grok worker shape
printf 'do the thing' > "$tmp/p.txt"
out=$(./mock-cli/grok -m "$gm" --reasoning-effort high --permission-mode acceptEdits \
  --no-subagents --prompt-file "$tmp/p.txt")
printf '%s' "$out" | grep -q "MOCK WORK OUTPUT ($gm)" || { echo "FAIL grok worker shape"; fail=1; }

# grok auditor shape
printf -- '--- MATERIAL UNDER AUDIT ---\nfine work' > "$tmp/q.txt"
out=$(./mock-cli/grok -m "$gm" --reasoning-effort high --permission-mode plan \
  --no-subagents --disable-web-search --prompt-file "$tmp/q.txt")
printf '%s' "$out" | grep -q 'VERDICT: PASS' || { echo "FAIL grok audit shape"; fail=1; }

# negative: a missing required flag must fail
if printf 'x' | ./mock-cli/codex exec --skip-git-repo-check -C "$tmp" -m "$cm" \
  -c model_reasoning_effort=high -o "$tmp/neg.md" - >/dev/null 2>&1; then
  echo "FAIL codex mock accepted a call missing --sandbox"; fail=1
fi
printf 'x' > "$tmp/neg.txt"
if ./mock-cli/grok -m "$gm" --reasoning-effort high --no-subagents \
  --prompt-file "$tmp/neg.txt" >/dev/null 2>&1; then
  echo "FAIL grok mock accepted a call missing --permission-mode"; fail=1
fi

# forced failure injection must propagate the exit code
if MOCK_CLI_EXIT=3 ./mock-cli/grok -m "$gm" --reasoning-effort high --permission-mode plan \
  --no-subagents --prompt-file "$tmp/neg.txt" >/dev/null 2>&1; then
  echo "FAIL grok mock ignored MOCK_CLI_EXIT"; fail=1
fi

[ "$fail" -eq 0 ] && echo "run-mock-checks.sh: all mock interface checks passed"
exit "$fail"
