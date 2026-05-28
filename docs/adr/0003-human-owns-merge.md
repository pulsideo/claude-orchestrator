# Human owns the merge; auto-merge is opt-in, default off

A Run ends by leaving an open, reviewed PR for a human — it does not merge by
default. The existing auto-merge path (squash + rebase-retry) is preserved but
gated behind an operator opt-in (Settings menu / `AUTO_MERGE`, default false).
The orchestrator, not the fix agent, creates the PR via the GitHub API so a PR
reliably exists for the loop and the handoff.

This reverses the prior default (auto-merge on), so it is recorded here: the
intent is that autonomous agents propose fixes but a human remains the gate for
landing code on `main`. Auto-merge stays available for operators who explicitly
trust the loop.

## Consequences

- `success` is no longer reported when no PR exists; outcomes distinguish
  `merged`, open-PR-pending-review, and `needs-human-review`.
- Removing the orchestrator-creates-PR step would reintroduce CRITIQUE #2
  (silent false success).
