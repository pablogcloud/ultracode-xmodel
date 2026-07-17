#!/usr/bin/env bash
# Verify that the manual project install includes both skills and rewrites
# plugin-namespaced agent references for a non-plugin installation.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

(cd "$tmp" && "$root/install.sh" --project >/dev/null)

test -f "$tmp/.claude/agents/codex-structured.md"
test -f "$tmp/.claude/skills/ultracode-xmodel/ultracode-xmodel.js"
test -f "$tmp/.claude/skills/ultracode-xmodel-blend/SKILL.md"
test -f "$tmp/.claude/skills/ultracode-xmodel-blend/references/workflow-patterns.md"
grep -q "agentPrefix: ''" "$tmp/.claude/skills/ultracode-xmodel/ultracode-xmodel.js"
grep -q "agentPrefix = ''" "$tmp/.claude/skills/ultracode-xmodel-blend/SKILL.md"

echo "install-check.sh: manual install passed"
