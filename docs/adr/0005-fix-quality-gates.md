# Fix-quality gates: tests-present, lint, optional CI

Before a fix can be Confirmed, it must clear ordered Validation gates:
**tests-present** (a change that touches production code must add or modify a
test) → **tests-pass** (no new failures vs `origin/main`) → **lint** (no new
lint errors vs `origin/main`) → optional **CI** (wait for the PR's GitHub checks
when `WAIT_FOR_CI=true`). The first failing gate names the terminal status, so
"why didn't this land" is always explicit.

We chose gates that compare against the base branch (block only on *new*
failures) so the orchestrator never rejects a fix for pre-existing test/lint
debt in the target repo. The tests-present gate is on by default
(`REQUIRE_TESTS`) because an autonomous fix with no test is the highest-risk
output; it is overridable for repos/changes where a test genuinely doesn't apply.

## Consequences

- A fix against an already-written failing test (no new test file) is rejected
  by the tests-present gate unless `REQUIRE_TESTS=false`. Accepted trade-off:
  prefer false rejection (human looks) over landing an untested change.
- Lint and CI gates are skipped silently when the target repo has no `lint`
  script / no CI configured, so the gates are zero-config opt-in by capability.
- The CI gate has no offline test seam (live GitHub checks API); only its pure
  summarizer (`summarizeChecks`) is unit-tested.
