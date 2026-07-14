# Contributing

Thanks for your interest in improving ultracode-xmodel.

## Development setup

1. Fork and clone the repo.
2. Run the test suite: `node test/harness.mjs` and `bash test/check.sh`.
3. For pipeline changes, run a quota-free end-to-end pass with the mock CLIs
   (see `test/SMOKE.md`).

## Guidelines

- Keep relay agents thin: one CLI invocation per task, verbatim output, no
  reasoning in the relay.
- Model IDs belong in the workflow `CONFIG` block and agent directive
  defaults only.
- Shell scripts must pass `shellcheck` and run on macOS's default bash 3.2.
- Adding a lane: add one relay agent in `agents/` following the existing
  pattern and one entry to `CONFIG.lanes`. See "Adding a lane" in the README.
- CI statically lints the relay agents for required safety properties but
  cannot execute them (they are LLM-run prose). After changing any relay,
  run the mock pipeline in test/SMOKE.md to verify execution.

## Pull requests

- One logical change per PR, with tests updated in the same PR.
- CI (harness + static checks) must be green.
