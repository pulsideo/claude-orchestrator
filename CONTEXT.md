# Claude Issue Orchestrator

An automation harness that finds defects in a **target repository**, drives a
fix through an isolated branch, and hands a reviewed-but-unmerged pull request
to a human. The orchestrator itself is a separate Node.js repo; it never runs
fixes against its own source.

## Language

**Target repo**:
The external repository whose defects are being found and fixed. Always a
separate local git clone (`REPO_LOCAL_PATH`), never the orchestrator repo.
_Avoid_: codebase, project, the repo

**Bug**:
A defect in the target repo. The unit of work the orchestrator acts on. A bug
is either discovered by the orchestrator or already filed by a human.
_Avoid_: error, defect, problem, ticket

**Discovery**:
The phase where a scanning agent reads the target repo and surfaces previously
unfiled bugs, then files each one as an Issue.
_Avoid_: scanning, detection, finding

**Issue**:
A GitHub issue representing one bug, carrying a severity label
(`critical`/`high`/`medium`/`low`/`bug`). The orchestrator processes Issues;
discovery produces them. Every bug becomes an Issue before it is processed.
_Avoid_: ticket, task, item

**Run**:
One end-to-end invocation of the orchestrator: discover (optional) → process a
prioritized queue of Issues → report. Cost is bounded per-run.
_Avoid_: job, session, batch

**Reviewer**:
Whatever inspects a fix's diff and returns Findings. Greptile when
`GREPTILE_API_KEY` is set, otherwise an in-worktree Claude review agent. The
Reviewer gates the fix→review loop.
_Avoid_: code review bot, linter

**Finding**:
A single observation from the Reviewer, classified `blocking` or
`non-blocking`. Only blocking Findings keep the loop running.
_Avoid_: comment, suggestion, issue (an Issue is the tracked bug, not a Finding)

**Fix→review loop**:
The iteration `fix → run tests → review` that repeats until the fix is
Confirmed or the iteration cap is hit.
_Avoid_: refinement, retry

**Confirmed**:
The state of a fix that has passed every enabled Validation gate AND has zero
blocking Findings. A Confirmed fix's PR is left open for a human (or auto-merged
only if the operator opted in). An unconfirmed fix at the cap leaves an open PR
labeled `needs-human-review`.
_Avoid_: done, verified, approved

**Validation gate**:
An ordered pass/fail check a fix must clear before it can be Confirmed:
tests-present (a code change must add/modify a test) → tests-pass → lint →
optional CI. The first failing gate names the issue's terminal status
(`tests-missing`, `fix-tests-failed`, `lint-failed`, `ci-failed`).
_Avoid_: check, validation step

**Settings menu**:
The interactive startup screen that configures one Run (auto-merge, iteration
cap, Claude auth, discovery on/off + scope prompt, concurrency, cost ceiling).
Pre-fills from `.env`; auto-skipped when no TTY is present.
_Avoid_: config screen, wizard
