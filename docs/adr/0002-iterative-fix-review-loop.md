# Iterative fix→review loop gated on blocking findings

Replace the single-pass "review once, refine once, revert if broken" flow with
an explicit loop: `fix → run tests → review`, repeated until the fix is
Confirmed (tests pass AND zero blocking Findings) or an iteration cap (default
3) is hit. The Reviewer classifies each Finding blocking vs non-blocking; only
blocking Findings keep the loop running, so the loop can't spin on cosmetic
nits. At the cap without confirmation, the PR is left open and labeled
`needs-human-review` rather than reverted.

We chose a capped blocking-gated loop over (a) today's single pass (a fix that
needs two rounds never gets them) and (b) looping until zero findings of any
kind (burns cost on style feedback and may never terminate).

## Consequences

- The Reviewer must return findings in a structured, classified form. The
  Claude review agent does this directly; Greptile output is post-classified.
- Cost ceiling and iteration cap together bound worst-case spend per Issue.
