# Self-seeding discovery → Issue → process pipeline

The orchestrator gains an optional discovery phase: a scanning agent reads the
target repo, dedups against already-open issues, files at most N new Issues per
run (agent-assigned severity), and those Issues then flow through the existing
issue-driven pipeline. We chose this over (a) staying purely issue-driven
(requires humans/another tool to file bugs first) and (b) discovering and fixing
in one step without filing an Issue. Routing every discovered bug through a real
GitHub Issue keeps one code path for processing, gives humans a durable record
and a chance to veto before fix cost is spent, and makes discovery toggleable.

## Consequences

- Discovery is off unless enabled in the Settings menu; scope is a free-text
  prompt (default: whole repo).
- Dedup and a per-run issue cap are required to avoid flooding the tracker on
  repeat runs.
