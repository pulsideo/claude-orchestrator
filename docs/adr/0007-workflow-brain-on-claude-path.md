# Per-issue brain as a Claude dynamic workflow (Claude path only)

The per-issue "brain" — triage → fix → validate/review → rework — was a
hand-rolled loop in `dispatcher.js` with a fixed iteration cap and a
**string-regex** review verdict that *failed open* (a silent reviewer counted
as no blocking findings). On the Claude path it can instead run as a saved
**dynamic workflow** (`.claude/workflows/fix-issue.js`): one headless `claude`
invocation that does triage, the fix, and a **convergence loop** with
**adversarial review** (independent correctness/security/edge-case lenses, each
returning a structured verdict; a fix is confirmed only when none find a
blocking defect — fails *closed*).

## Boundary: harness vs. brain

The orchestrator stays the durable harness and is unchanged: scheduling,
discovery, issue fetch/sort, worktree lifecycle, PR creation (ADR 0003), the
**authoritative** `validateBranch`, CI gate, merge/handoff, cost ledger. Only
the inner brain is swapped. The workflow's `confirmed` is **advisory** — the
harness re-runs `validateBranch` after the workflow returns and never trusts the
self-report; if gates fail or the workflow could not confirm, the PR is left for
a human.

## Provider-conditional

A Claude dynamic workflow can only spawn Claude sub-agents, so the workflow brain
runs only when the **fix provider is Claude** (`adapter.supportsWorkflow`) and
`USE_WORKFLOW=true`. Codex/Kimi keep the hand-rolled pipeline. This preserves the
cross-vendor moat (e.g. Codex reviewing a Claude fix) — see ADR 0006.

## Invocation contract (verified, CLI v2.1.154)

`runFixWorkflow` (`src/workflow.js`) is the single swappable seam — moving to the
Agent SDK later changes only this module. It invokes the workflow **by absolute
`scriptPath`**, not the `/fix-issue` slash command, because `claude` runs with
cwd set to the *target* worktree where the command isn't discoverable — and a
global install to `~/.claude/workflows` is (correctly) blocked as agent-config
self-modification, while copying into the target repo would pollute the PR diff.
Args (incl. rendered prompts) are passed as one argv element via `execFile` (no
shell); results are read from the schema-validated `structured_output` field
with the real `total_cost_usd`. `--max-budget-usd` caps spend per issue.

## Cost control

Budget is reserved per issue *before* it starts (`logger.reserveBudget`) and
refunded after, so concurrent issues can't each see spend below the ceiling and
collectively overspend; the reserved slice becomes the workflow's hard
`--max-budget-usd`. An optional `PER_ISSUE_TOKEN_BUDGET` backstops the loop
inside the workflow.

## Consequences

- Default is **off** (`USE_WORKFLOW=false`); roll out behind a contract probe,
  an A/B run, a cost-ceiling test, and an auto-merge-disabled canary.
- Cost on the Claude path becomes the real per-issue `total_cost_usd` (one
  number) instead of the token×price estimate that returned $0 for unknown models.
- The hand-rolled path remains fully supported as the fallback and the only path
  for non-Claude providers.
