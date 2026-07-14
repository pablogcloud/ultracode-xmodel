#!/usr/bin/env bash
# Manual install: copies the relay agents and the skill (with its workflow
# script) into a Claude Code config directory. Plugin installs do not need
# this script.
#   ./install.sh            → installs into ~/.claude
#   ./install.sh --project  → installs into ./.claude of the current repo
set -eu
src=$(cd "$(dirname "$0")" && pwd)
dest="$HOME/.claude"
[ "${1:-}" = "--project" ] && dest="$PWD/.claude"

mkdir -p "$dest/agents" "$dest/skills/ultracode-xmodel"
cp "$src"/agents/*.md "$dest/agents/"
cp "$src"/skills/ultracode-xmodel/SKILL.md "$dest/skills/ultracode-xmodel/"

# Manually installed agents are not namespaced; clear the plugin prefix.
sed "s/agentPrefix: 'ultracode-xmodel:', \/\/ AGENT-PREFIX/agentPrefix: '', \/\/ AGENT-PREFIX/" \
  "$src/skills/ultracode-xmodel/ultracode-xmodel.js" \
  > "$dest/skills/ultracode-xmodel/ultracode-xmodel.js"

grep -q "agentPrefix: ''" "$dest/skills/ultracode-xmodel/ultracode-xmodel.js" || {
  echo "error: agentPrefix rewrite failed — CONFIG anchor line changed?" >&2; exit 1; }

echo "Installed to $dest:"
echo "  agents/codex-worker.md agents/grok-worker.md agents/codex-auditor.md agents/grok-auditor.md"
echo "  skills/ultracode-xmodel/ (SKILL.md + workflow)"
echo
echo "New agents may take a moment to register; restart the Claude Code session if they are not found."
echo "Run bin/xmodel-doctor to verify the external CLIs."
