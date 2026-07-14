# Smoke tests

Both recipes pin `complexity` and `stakes` explicitly so routing — and
therefore the expected call pattern — is deterministic, independent of
triage judgment.

## Quota-free pipeline run (mock CLIs)

From a Claude Code session in this repo, prepend the mocks to PATH and run
one task per lane with auditing on:

1. `export PATH="$PWD/test/mock-cli:$PATH"` in the session's shell (or start
   Claude Code from a shell where this is set).
2. Invoke the Workflow tool with
   `scriptPath: skills/ultracode-xmodel/ultracode-xmodel.js` and:

   ```json
   { "tasks": [
       { "id": "smoke-codex", "prompt": "Summarize the numbers 1..5.", "lane": "codex-medium", "complexity": 3, "stakes": "low" },
       { "id": "smoke-grok",  "prompt": "Summarize the letters a..e.", "lane": "grok", "complexity": 2, "stakes": "high" }
   ] }
   ```

Expected, exactly: `smoke-codex` runs 1 worker + 1 audit voice (the grok
auditor — cross-family), `smoke-grok` runs 1 worker + the full 2-voice
panel (high stakes). Five relay calls total. Both outputs read
`MOCK WORK OUTPUT (...)`, every audit returns `VERDICT: PASS`, and both
items end `approved: true`.

## Real-CLI smoke (uses subscription quota)

Same invocation without the PATH override. Keep the prompts trivial.
Expected: the same 2-worker + 3-audit call pattern, real model output, a
VERDICT line from every voice, both items `approved: true` (or a DEFECT
verdict with a concrete reason), and no WRAPPER-ERROR strings anywhere.
