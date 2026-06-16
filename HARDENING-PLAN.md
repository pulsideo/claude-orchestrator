# HARDENING-PLAN.md — Claude Issue Orchestrator

Option 1: keep the Claude Code brain, harden the orchestration/gating layer.
Targets the five gaps from `CRITIQUE1.md`'s successor review plus hygiene items.

## Guiding invariant

> A fix reaches `success`/`merged` **only** if: production code changed **and**
> tests actually executed and passed **and** a review actually ran with no
> blocking findings. Any "couldn't validate" state routes to
> `needs-human-review`, never to success. Every gate fails **closed**.

## PR A — "Confirmed means something" (highest priority)

- **A1. Runner-agnostic test gate that fails closed** — `src/github.js`
  Detect the runner (vitest / jest → related-tests; else the repo's `test`
  script) instead of hardcoding `npx vitest related`. When tests can't run on
  *either* the fix branch or `origin/main`, stop returning `{passed:true}` —
  route to human review (`unvalidated`). Keep the origin/main diff so
  pre-existing failures aren't blamed on the fix.
- **A2. Review fails closed on the hand-rolled path** — `src/dispatcher.js`,
  `src/agent.js`. A reviewer *exception* must not become `blocking:false`; a
  review that didn't run cannot yield `confirmed`.
- **A3. Empty / test-only diffs are not vacuously confirmed** — `src/github.js`.
  Empty diff ⇒ `no-changes` (hard fail); no-production-code diff ⇒ human review.
  `NO_CODE_CHANGE_ACTION` lets the operator choose immediate handoff
  (`human-review`, default) or a rework nudge first (`rework`).
- **A4. Accurate human-handoff reason** — `src/github.js`, `src/dispatcher.js`.
  Stop posting the hardcoded "refinement broke tests" message for every handoff.

## PR B — Isolation & secret safety

- **B1. Serialize shared-repo git plumbing** — `src/worktree.js`. An in-process
  per-repo async mutex around `fetch`/`prune`/`branch -D`/`worktree add`; the
  agent run stays parallel.
- **B2. Stop leaking secrets** — `src/worktree.js`. Allowlist env files
  (default `.env.test` only; drop `.env.production`); add copied files to the
  worktree's `.git/info/exclude` so they can't be committed.

## PR C — Cost integrity

- **C1. Count discovery spend against the ceiling** — `src/discovery.js`,
  `src/index.js`, `src/logger.js`.
- **C2. Real per-issue spend cap on the hand-rolled path** — `src/dispatcher.js`.
  Accumulate cost and break the loop at `budgetUsd` (`over-budget`).

## PR D — Hygiene

- `flagForHumanReview` retry de-dup; optional re-review after rebase; document
  the tests-present gate's presence≠relevance limit; reconcile README/CONTEXT.

## Sequencing

PR A first (defines the new statuses the others route into), then B and C
(independent), then D. Add an up-front regression test asserting the invariant.
