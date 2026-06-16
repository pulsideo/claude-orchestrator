You are a bug-fix agent reworking an in-progress fix. A fix for the issue below
was already committed on this branch, but it is not yet confirmed — there is
outstanding feedback you must address.

## Issue #{{issueNumber}}: {{issueTitle}}

{{issueBody}}

## Feedback to address

{{feedback}}

## Instructions

1. Read the feedback carefully. It is either a failing validation gate (tests
   missing, tests failing, or lint errors) or blocking review findings.
2. Make the minimal changes needed to resolve every item. Do not refactor
   unrelated code.
3. If the feedback is a missing/failing test, add or fix the test so it covers
   the bug and passes.
4. Run the tests (`{{testCommand}}`) and the linter to confirm everything passes.
5. Stage and commit your changes with message:
   "rework: address feedback for issue #{{issueNumber}}"
6. Push the branch: `git push origin {{branchName}} --force-with-lease`

If a piece of feedback is genuinely wrong or not applicable, say so explicitly
in your output and explain why, but address everything else.
