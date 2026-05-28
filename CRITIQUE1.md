# CRITIQUE1.md — Claude Issue Orchestrator

Code review of the orchestrator as of commit `9d9398d` (branch `main`).
Findings are ordered by severity. File references are clickable as `path:line`.

---

## 🔴 Critical

### 1. The cost ceiling is completely non-functional (two compounding bugs)

The headline safety feature — `COST_CEILING_USD` — never fires, due to two
independent bugs that happen to cancel each other out:

1. **Wrong JSON field.** `src/agent.js:74` reads `result.cost_usd`, but Claude
   Code's `--output-format json` emits `total_cost_usd`. Every agent therefore
   records `cost: 0`.
2. **Log is never scoped to the run.** `src/logger.js` persists `run-log.json`
   and never calls the exported `resetLog()`. `getTotalCost()` sums **all
   historical runs**, so the ceiling is computed against lifetime spend rather
   than the current run.

**Net effect:** because cost is always `0` (bug 1), the ceiling never triggers
at all. If bug 1 were fixed, bug 2 would then make the ceiling fire prematurely
based on stale historical totals. The feature does not work in either state.

- Fix `src/agent.js:74` to read `total_cost_usd` (keep a fallback to `cost_usd`
  for older CLI versions).
- Call `resetLog()` at the start of a run, or track per-run cost in memory
  instead of reading the persisted lifetime total.

> **Verify before fixing:** confirm the field name against the locally installed
> Claude Code version (`claude -p 'hi' --output-format json` and inspect the
> JSON keys). Recent versions use `total_cost_usd`.

---

## 🟠 High

### 2. `status: 'success'` is reported even when no PR exists / nothing merged

`src/dispatcher.js:131-132` — the orchestrator never creates the PR itself; it
relies on the fix agent running `gh pr create` (per the prompt templates). If
the agent skips that step (subprocess auth hiccup, or it simply doesn't follow
the instruction), `getPrForBranch` returns `null`, the code does `if (!pr)
break;`, and the issue is still logged as `status: 'success'`.

**Net effect:** silent false success — the run summary claims a fix landed when
no PR was opened and nothing was merged.

- Distinguish "PR created & merged" from "no PR found"; surface the latter as a
  distinct status (e.g. `no-pr` / `needs-human-review`) rather than `success`.

### 3. Worktree setup is hardcoded and can pollute the PR diff

`src/worktree.js:40-53` hardcodes, for **every** target repo:

```js
execSync(`pnpm install`, …);
execSync(`pnpm add -D vitest @vitejs/plugin-react @testing-library/jest-dom \
  @testing-library/react @testing-library/user-event jsdom`, …);
```

Problems:
- Assumes the target repo uses **pnpm + React + vitest**. A repo using npm/yarn,
  or a non-React/non-vitest stack, will break or get irrelevant deps.
- `pnpm add -D` **mutates `package.json` and the lockfile inside the worktree**.
  The fix agent's prompt says to "stage and commit all changes," so these
  unrelated dependency edits can be swept into the fix commit and land in the PR.

- Make the package manager and any extra test deps configurable (env or
  auto-detected from the lockfile), and avoid mutating tracked files during
  setup.

---

## 🟡 Medium

### 4. Dead code in Greptile integration
`src/greptile.js:26` — `const repoId = \`github:main:${GITHUB_OWNER}/${GITHUB_REPO}\`;`
is computed and never used. Remove it.

### 5. `fetchIssues` does not paginate
`src/github.js:47` calls `octokit.issues.listForRepo({ …, per_page: 100 })` with
no pagination. Repos with more than 100 open issues silently drop the overflow.
Use `octokit.paginate` (and note that the GitHub issues endpoint also returns
PRs, which the code already filters via `issue.pull_request`).

### 6. "Close the branch" is never implemented
Your stated goal includes closing branches after merge, but `mergePr`
(`src/github.js:209`) squash-merges and never deletes the remote branch. Local
`fix/issue-N` branches also linger (`removeWorktree` only removes the worktree,
not the branch). Add `delete_branch` after a successful merge, or call
`octokit.git.deleteRef`.

### 7. README is contradictory and out of date
- `README.md` "How It Works" step 7 says *"Pushes the branch (you create the
  PRs, or extend the prompts to do it)"* — but the prompt templates already run
  `gh pr create` and the dispatcher **auto-merges**. The documented behavior
  contradicts the implemented behavior.
- The Environment Variables table omits `AUTO_MERGE` and `GREPTILE_API_KEY`
  (the latter is in `.env.example` but undocumented in the table).
- The "Architecture" section omits `greptile.js`, the refinement step, and the
  auto-merge flow.

---

## 🟢 Minor / hygiene

- **No tests, lint, or CI** for the orchestrator itself, and no `engines` field
  in `package.json` (README requires Node 18+).
- `src/greptile.js:81` — `getDiff` concatenates the committed and staged diffs
  (`committed + staged`) without a separating newline, which can produce a
  malformed diff when both are non-empty.
- `src/github.js` retry helper `withRetry` can fall through and return
  `undefined` if all attempts are exhausted without throwing (the loop ends
  after `MAX_RETRIES` without a final throw on the last transient failure path).

---

## Suggested PR sequence (the find → fix → review → merge loop)

1. **PR 1 (critical):** Fix cost tracking — `total_cost_usd` + per-run cost
   scoping so `COST_CEILING_USD` actually works.
2. **PR 2 (high):** Don't report `success` when no PR/merge happened; surface a
   distinct status.
3. **PR 3 (high):** De-hardcode worktree setup (package manager + test deps
   configurable; stop mutating tracked files).
4. **PR 4 (medium):** Delete branch after merge; paginate `fetchIssues`; remove
   dead `repoId`.
5. **PR 5 (docs):** Reconcile README with actual behavior; document `AUTO_MERGE`
   and `GREPTILE_API_KEY`; refresh the Architecture section.
