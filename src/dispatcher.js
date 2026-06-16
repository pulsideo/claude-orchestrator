import { execSync } from 'child_process';
import { validateBranch, getSeverity, getPrForBranch, createPr, mergePr, flagForHumanReview, deleteRemoteBranch, waitForChecks } from './github.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { runTriageAgent, runFixAgent, runReworkAgent, runReviewAgent } from './agent.js';
import { resolveRole } from './providers.js';
import { runFixWorkflow } from './workflow.js';
import { reviewWithGreptile, getDiff } from './greptile.js';
import { logResult, getRunCost, startRun, reserveBudget, releaseBudget, recordRunCost } from './logger.js';

const {
  GITHUB_OWNER,
  GITHUB_REPO,
} = process.env;

// Map a failing validation stage to the terminal status reported for the issue.
const VALIDATION_STATUS = {
  // The fix produced no diff at all — a hard fail, nothing to review (A3).
  'no-changes': 'no-changes',
  'tests-missing': 'tests-missing',
  tests: 'fix-tests-failed',
  // Stages we couldn't validate are a human handoff, not a hard fail — routed
  // via the needs-human-review path, but mapped here too as a safety net.
  'tests-unvalidated': 'needs-human-review',
  'no-code-change': 'needs-human-review',
  lint: 'lint-failed',
  ci: 'ci-failed',
  error: 'validation-error',
};

// Human-readable handoff reason for a stage we couldn't validate (A3/A4).
const UNVALIDATED_REASON = {
  'tests-unvalidated': 'tests could not be validated (no runner, or they crash on a clean main)',
  'no-code-change': 'the fix changed no production code, so it could not be validated automatically',
};

/**
 * What to do when a fix changes no production code (A3). 'rework' nudges the
 * agent to make a real change for up to MAX_ITERATIONS before handing off;
 * 'human-review' (default) hands off immediately. Either way an unfixed
 * no-code-change ends in needs-human-review — this only chooses whether to try.
 * Applies to the hand-rolled loop only; the workflow brain has no rework loop.
 */
export function noCodeChangeAction(env = process.env) {
  return env.NO_CODE_CHANGE_ACTION === 'rework' ? 'rework' : 'human-review';
}

/**
 * Whether auto-merge is enabled, read LIVE from env. The interactive menu mutates
 * process.env.AUTO_MERGE after this module is imported, so a value captured at
 * import time goes stale and contradicts the printed config. Read it at the point
 * of use instead.
 */
export function autoMergeEnabled(env = process.env) {
  return env.AUTO_MERGE === 'true';
}

/** Terminal status for a failed validation stage. */
export function statusForStage(stage) {
  return VALIDATION_STATUS[stage] || 'fix-tests-failed';
}

/**
 * Decide the next action in the fix→review loop from the current iteration's
 * facts (ADR 0002). 'confirmed' = gates passed and no blocking findings.
 */
export function loopDecision({ validationPassed, blocking, iteration, maxIterations }) {
  if (!validationPassed) {
    return iteration < maxIterations ? 'rework-validation' : 'fail-validation';
  }
  if (!blocking) return 'confirmed';
  return iteration < maxIterations ? 'rework-review' : 'unconfirmed-blocking';
}

/**
 * Decide the terminal status for a processed issue from observed facts.
 * A fix that passes tests but has NO pull request is reported as 'no-pr',
 * never 'success' (CRITIQUE #2) — so the run summary can't claim a fix landed
 * when nothing was opened.
 */
export function resolveStatus({ merged, needsHumanReview, overBudget, ciFailed, prExists }) {
  if (merged) return 'merged';
  // over-budget is a human handoff too, but a distinct, more specific cause (C2).
  if (overBudget) return 'over-budget';
  if (needsHumanReview) return 'needs-human-review';
  if (ciFailed) return 'ci-failed';
  if (!prExists) return 'no-pr';
  return 'success';
}

/**
 * Acquire a review for the current branch: Greptile if configured, else the
 * reviewer provider. Returns `ran` so the caller can fail CLOSED (A2): a review
 * that errored (ran:false) must NOT be treated as "no blocking findings" — the
 * old code did, so a crashed reviewer silently confirmed the fix. ENABLE_REVIEW
 * =false is a deliberate skip (ran:true), not a failure.
 */
async function acquireReview(issue, worktreeDir) {
  try {
    if (process.env.GREPTILE_API_KEY) {
      const comments = await reviewWithGreptile(worktreeDir);
      return { blocking: comments.length > 0, comments, cost: 0, ran: true };
    }
    if (process.env.ENABLE_REVIEW === 'false') {
      return { blocking: false, comments: [], cost: 0, ran: true };
    }
    const review = await runReviewAgent(issue, getDiff(worktreeDir), worktreeDir);
    console.log(`[REVIEW] ${review.provider}/${review.model}: ${review.blocking ? 'changes requested' : 'no blocking findings'} ($${review.cost.toFixed(4)})`);
    return { blocking: review.blocking, comments: review.comments, cost: review.cost, ran: true };
  } catch (err) {
    console.warn(`[REVIEW] Review failed: ${err.error || err.message}. Cannot confirm without a review — handing to human.`);
    return { blocking: false, comments: [], cost: 0, ran: false };
  }
}

function formatReviewComments(comments) {
  return comments.map(c => (
    c.type === 'inline'
      ? `- \`${c.path}\`${c.line ? ` line ${c.line}` : ''}: ${c.body}`
      : `- ${c.body}`
  )).join('\n');
}

function pushBranch(worktree) {
  try {
    execSync(`git push origin ${worktree.branch} --force-with-lease`, { cwd: worktree.dir, stdio: 'pipe' });
  } catch (err) {
    console.warn(`[PUSH] ${worktree.branch}: ${err.message}`);
  }
}

/** Whether the workflow brain should run for this severity (Claude fix provider + opted in). */
export function useWorkflowBrain(severity, env = process.env) {
  if (env.USE_WORKFLOW !== 'true') return false;
  return !!resolveRole('fix', severity, env).adapter.supportsWorkflow;
}

/**
 * Orchestrator owns PR creation (ADR 0003): ensure the branch is pushed and a
 * PR exists. Idempotent — createPr returns the existing PR if one is open.
 */
async function pushAndCreatePr(worktree, issue) {
  if (!GITHUB_OWNER || !GITHUB_REPO) return;
  try {
    execSync(`git push origin ${worktree.branch}`, { cwd: worktree.dir, stdio: 'pipe' });
  } catch (err) {
    console.warn(`[PR] Push failed for ${worktree.branch}: ${err.message}`);
  }
  try {
    const pr = await createPr(
      GITHUB_OWNER, GITHUB_REPO, worktree.branch,
      `fix: resolve issue #${issue.number} - ${issue.title}`,
      `Closes #${issue.number}`,
    );
    console.log(`[PR] PR #${pr.number} ready: ${pr.html_url}`);
  } catch (err) {
    console.warn(`[PR] Could not create PR for ${worktree.branch}: ${err.message}`);
  }
}

/** Squash-merge the branch's PR, rebasing+revalidating on conflict. Returns whether it merged. */
async function attemptMerge(worktree) {
  const MAX_MERGE_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_MERGE_RETRIES; attempt++) {
    try {
      const pr = await getPrForBranch(GITHUB_OWNER, GITHUB_REPO, worktree.branch);
      if (!pr) return false;
      console.log(`[MERGE] Merging PR #${pr.number} into main...`);
      await mergePr(GITHUB_OWNER, GITHUB_REPO, pr.number);
      console.log(`[MERGE] PR #${pr.number} merged successfully.`);
      try {
        await deleteRemoteBranch(GITHUB_OWNER, GITHUB_REPO, worktree.branch);
        console.log(`[MERGE] Deleted remote branch ${worktree.branch}.`);
      } catch (err) {
        console.warn(`[MERGE] Could not delete remote branch ${worktree.branch}: ${err.message}`);
      }
      return true;
    } catch (err) {
      const isStaleBase = err.message?.includes('Base branch was modified');
      const isNotMergeable = err.message?.includes('not mergeable') || err.message?.includes('Pull Request is not mergeable');
      if ((isStaleBase || isNotMergeable) && attempt < MAX_MERGE_RETRIES) {
        console.log(`[MERGE] ${isStaleBase ? 'Base branch changed' : 'PR not mergeable (likely conflict)'}. Rebasing and retrying (${attempt}/${MAX_MERGE_RETRIES})...`);
        try {
          execSync('git fetch origin main', { cwd: worktree.dir, stdio: 'pipe' });
          execSync('git rebase origin/main', { cwd: worktree.dir, stdio: 'pipe' });
          execSync(`git push origin ${worktree.branch} --force-with-lease`, { cwd: worktree.dir, stdio: 'pipe' });
          // We re-validate (tests/lint) after the rebase but deliberately do NOT
          // re-run review (D2): a rebase that merely catches up to main rarely
          // changes the fix's own diff, and re-review on every merge attempt is
          // costly. The tests/lint re-run still catches functional regressions
          // the rebase introduced. If a rebase resolves real conflicts in the
          // fix itself, prefer AUTO_MERGE=false so a human reviews the result.
          const postRebase = await validateBranch(worktree.dir);
          if (!postRebase.passed) {
            console.warn(`[MERGE] Validation failed after rebase: ${postRebase.error}`);
            return false;
          }
        } catch (rebaseErr) {
          console.warn(`[MERGE] Rebase failed: ${rebaseErr.message}. Aborting merge.`);
          try { execSync('git rebase --abort', { cwd: worktree.dir, stdio: 'pipe' }); } catch { /* nothing to abort */ }
          return false;
        }
      } else {
        console.warn(`[MERGE] Failed to merge: ${err.message}`);
        return false;
      }
    }
  }
  return false;
}

export async function processIssue(issue, repoPath, dryRun = false, { budgetUsd } = {}) {
  const severity = getSeverity(issue);
  console.log(`\n[${'='.repeat(50)}]`);
  console.log(`[ISSUE #${issue.number}] ${issue.title}`);
  console.log(`[SEVERITY] ${severity}`);
  console.log(`[TIME] ${new Date().toISOString()}`);

  if (dryRun) {
    console.log(`[DRY RUN] Would process issue #${issue.number}`);
    return { issue: issue.number, status: 'dry-run' };
  }

  // Phase 1: Create isolated worktree
  let worktree;
  try {
    worktree = createWorktree(repoPath, issue.number);
    console.log(`[WORKTREE] ${worktree.dir}`);
    console.log(`[BRANCH] ${worktree.branch}`);
  } catch (err) {
    console.error(`[WORKTREE FAIL] ${err.message}`);
    // Log it so a worktree/install failure leaves a trace in run-log.json
    // instead of vanishing (the run otherwise looks like it never started).
    // createWorktree already tore down any partial worktree/branch.
    const totalCost = logResult(issue.number, {
      model: 'unknown', cost: 0, status: 'worktree-failed', duration: 0, output: err.message,
    });
    return { issue: issue.number, status: 'worktree-failed', error: err.message, totalCost };
  }

  try {
    // The "brain" produces a committed fix and tells us whether it's confirmed.
    // Two implementations share the same outputs: a Claude dynamic-workflow brain
    // (triage→fix→adversarial review→converge, all in one headless call) and the
    // hand-rolled triage→fix→loop (Codex/Kimi, or USE_WORKFLOW off).
    let confirmed = false;
    let blockingAtCap = false;
    let overBudget = false;
    let failStage = null;
    // Human-handoff reason, surfaced on the PR when we flag it (A4). Overridden
    // when the cause is something other than blocking review findings.
    let handoffReason = 'fix not confirmed (blocking review findings remain)';
    let brainModel = resolveRole('fix', severity).model;
    let brainOutput = '';
    let brainCost = 0;
    let brainDuration = 0;

    if (useWorkflowBrain(severity)) {
      // Workflow brain. `confirmed` is ADVISORY — we re-validate authoritatively.
      let wf;
      try {
        console.log(`[WORKFLOW] Running fix-issue workflow${budgetUsd ? ` (budget $${budgetUsd.toFixed(2)})` : ''}...`);
        wf = await runFixWorkflow(issue, worktree, { severity, budgetUsd });
        brainCost = wf.cost; brainDuration = wf.duration; brainModel = wf.model; brainOutput = wf.summary;
        console.log(`[WORKFLOW] ${wf.confirmed ? 'confirmed' : 'unconfirmed'} after ${wf.iterations} iteration(s) ($${wf.cost.toFixed(4)})`);
      } catch (err) {
        console.error(`[WORKFLOW FAIL] ${err.error || err.message}`);
        const totalCost = logResult(issue.number, {
          model: 'unknown', cost: 0, status: 'fix-failed', duration: err.duration, output: err.error,
        });
        return { issue: issue.number, status: 'fix-failed', totalCost };
      }

      await pushAndCreatePr(worktree, issue);

      // Authoritative gate — never trust the workflow's self-report.
      const validation = await validateBranch(worktree.dir);
      if (validation.unvalidated) {
        // Couldn't validate the fix → hand to a human, never confirm (A1/A3).
        console.log(`[VALIDATE] unvalidated at '${validation.stage}': ${validation.error}`);
        handoffReason = UNVALIDATED_REASON[validation.stage] || 'the fix could not be validated automatically';
        blockingAtCap = true;
      } else if (!validation.passed) {
        console.log(`[VALIDATE] authoritative gate failed at '${validation.stage}': ${validation.error}`);
        failStage = validation.stage;
      } else if (wf.apiError || !wf.confirmed) {
        // Fail closed: the workflow errored or couldn't clear its adversarial
        // review within the caps → hand to a human, never call it confirmed.
        console.log(`[WORKFLOW] gates pass but fix is not confirmed → flagging for human review.`);
        blockingAtCap = true;
      } else {
        confirmed = true;
      }
    } else {
      // ---- Hand-rolled pipeline (Codex/Kimi, or USE_WORKFLOW off) ----
      // Phase 2: Triage
      let triageResult;
      try {
        console.log(`[TRIAGE] Starting analysis...`);
        triageResult = await runTriageAgent(issue, worktree.dir);
        console.log(`[TRIAGE] Done (${(triageResult.duration / 1000).toFixed(1)}s, $${triageResult.cost})`);
      } catch (err) {
        console.error(`[TRIAGE FAIL] ${err.error}`);
        triageResult = null;
      }

      // Phase 3: Fix
      let fixResult;
      try {
        console.log(`[FIX] Starting fix agent...`);
        fixResult = await runFixAgent(issue, triageResult?.analysis, worktree.dir);
        console.log(`[FIX] Done (${(fixResult.duration / 1000).toFixed(1)}s, $${fixResult.cost}, model: ${fixResult.model})`);
      } catch (err) {
        console.error(`[FIX FAIL] ${err.error}`);
        const totalCost = logResult(issue.number, {
          model: err.model || 'unknown',
          cost: 0,
          status: 'fix-failed',
          duration: err.duration,
          output: err.error,
        });
        return { issue: issue.number, status: 'fix-failed', totalCost };
      }

      // Phase 3.5: orchestrator owns PR creation (ADR 0003).
      await pushAndCreatePr(worktree, issue);

      // Phases 4–5: iterative fix → validate → review loop (ADR 0002).
      const MAX_ITER = Math.max(1, parseInt(process.env.MAX_ITERATIONS || '3', 10) || 3);
      let reviewCost = 0;
      let reworkCost = 0;
      let reworkDuration = 0;

      for (let iteration = 1; iteration <= MAX_ITER; iteration++) {
        console.log(`[LOOP] Iteration ${iteration}/${MAX_ITER}`);

        // Real per-issue spend cap (C2). The workflow path gets --max-budget-usd;
        // the hand-rolled agents take no budget arg, so without this an issue can
        // run every iteration regardless of cost — the reservation only bounded
        // concurrency. Stop before starting more agent work once spend ≥ the cap;
        // hand the already-made fix to a human rather than overspending further.
        const spent = (triageResult?.cost || 0) + (fixResult?.cost || 0) + reviewCost + reworkCost;
        if (budgetUsd && spent >= budgetUsd) {
          console.warn(`[BUDGET] #${issue.number} spent $${spent.toFixed(2)} ≥ its $${budgetUsd.toFixed(2)} cap — stopping the loop and handing to human review.`);
          handoffReason = `the per-issue budget ($${budgetUsd.toFixed(2)}) was exhausted before the fix could be confirmed`;
          overBudget = true;
          blockingAtCap = true;
          break;
        }

        const validation = await validateBranch(worktree.dir);

        if (validation.unvalidated) {
          console.log(`[VALIDATE] unvalidated at '${validation.stage}': ${validation.error}`);
          handoffReason = UNVALIDATED_REASON[validation.stage] || 'the fix could not be validated automatically';
          // A no-code-change can optionally be reworked (NO_CODE_CHANGE_ACTION):
          // nudge the agent to make a real change while iterations remain, then
          // fall through to human review if it still produces no code. Every
          // other unvalidated stage is environmental — reworking can't close it.
          const reworkNoCode = validation.stage === 'no-code-change'
            && noCodeChangeAction() === 'rework'
            && iteration < MAX_ITER;
          if (!reworkNoCode) {
            blockingAtCap = true;
            break;
          }
          try {
            console.log(`[REWORK] Fix changed no production code — nudging the agent to make a real change.`);
            const r = await runReworkAgent(issue, 'You changed no production code — did you actually fix the issue? Implement the real code change that resolves it, and add or update a test that covers it.', worktree.dir);
            reworkCost += r.cost;
            reworkDuration += r.duration;
            pushBranch(worktree);
          } catch (err) {
            console.warn(`[REWORK] failed: ${err.error || err.message}`);
            blockingAtCap = true;
            break;
          }
          continue;
        }
        if (!validation.passed) {
          console.log(`[VALIDATE] failed at '${validation.stage}' gate: ${validation.error}`);
          if (loopDecision({ validationPassed: false, blocking: false, iteration, maxIterations: MAX_ITER }) === 'fail-validation') {
            failStage = validation.stage;
            break;
          }
          try {
            const r = await runReworkAgent(issue, `The fix did not pass the '${validation.stage}' gate:\n${validation.error}\n\nResolve this so the gate passes; keep the change minimal.`, worktree.dir);
            reworkCost += r.cost;
            reworkDuration += r.duration;
            pushBranch(worktree);
          } catch (err) {
            console.warn(`[REWORK] failed: ${err.error || err.message}`);
            failStage = validation.stage;
            break;
          }
          continue;
        }
        console.log(`[VALIDATE] gates passed`);

        const review = await acquireReview(issue, worktree.dir);
        reviewCost += review.cost;
        if (!review.ran) {
          // The reviewer errored — we cannot confirm without a review (A2).
          handoffReason = 'code review could not be completed';
          blockingAtCap = true;
          break;
        }
        const decision = loopDecision({ validationPassed: true, blocking: review.blocking, iteration, maxIterations: MAX_ITER });
        if (decision === 'confirmed') { confirmed = true; break; }
        if (decision === 'unconfirmed-blocking') { blockingAtCap = true; break; }

        console.log(`[REWORK] Addressing ${review.comments.length} review finding(s)...`);
        try {
          const r = await runReworkAgent(issue, formatReviewComments(review.comments), worktree.dir);
          reworkCost += r.cost;
          reworkDuration += r.duration;
          pushBranch(worktree);
        } catch (err) {
          console.warn(`[REWORK] failed: ${err.error || err.message}`);
          blockingAtCap = true;
          break;
        }
      }

      brainModel = fixResult.model;
      brainOutput = fixResult.output;
      brainCost = (triageResult?.cost || 0) + (fixResult?.cost || 0) + reviewCost + reworkCost;
      brainDuration = (triageResult?.duration || 0) + fixResult.duration + reworkDuration;
    }

    // Validation never passed within the cap → terminal validation status.
    if (failStage) {
      const failStatus = statusForStage(failStage);
      const totalCost = logResult(issue.number, {
        model: brainModel,
        cost: brainCost,
        status: failStatus,
        duration: brainDuration,
        output: brainOutput,
      });
      return { issue: issue.number, status: failStatus, cost: brainCost, totalCost };
    }

    // Phase 5.5: optional CI gate — only meaningful once the fix is locally
    // confirmed (gates passed + no blocking findings). Opt-in via WAIT_FOR_CI.
    let ciFailed = false;
    if (confirmed && process.env.WAIT_FOR_CI === 'true' && GITHUB_OWNER && GITHUB_REPO) {
      try {
        const pr = await getPrForBranch(GITHUB_OWNER, GITHUB_REPO, worktree.branch);
        if (pr) {
          console.log(`[CI] Waiting for CI checks on PR #${pr.number}...`);
          const ci = await waitForChecks(GITHUB_OWNER, GITHUB_REPO, pr.head.sha);
          if (!ci.passed) {
            console.warn(`[CI] ${ci.error}. Will not merge; flagging for human review.`);
            ciFailed = true;
          } else {
            console.log(`[CI] Checks green.`);
          }
        }
      } catch (err) {
        // Fail closed when we'd otherwise auto-merge: an unevaluable CI check
        // must not be treated as green. Without auto-merge the PR is left for a
        // human anyway, so proceeding is safe.
        if (autoMergeEnabled()) {
          console.warn(`[CI] Could not evaluate CI checks: ${err.message}. Auto-merge on → blocking merge, flagging for human review.`);
          ciFailed = true;
        } else {
          console.warn(`[CI] Could not evaluate CI checks: ${err.message}. Proceeding without CI gate (no auto-merge).`);
        }
      }
    }

    // Phase 6: auto-merge only when confirmed + CI ok + opted in; otherwise leave
    // the PR open, flagging for human review when the fix isn't confirmed.
    let merged = false;
    if (confirmed && !ciFailed && autoMergeEnabled() && GITHUB_OWNER && GITHUB_REPO) {
      merged = await attemptMerge(worktree);
    } else if ((blockingAtCap || ciFailed) && GITHUB_OWNER && GITHUB_REPO) {
      try {
        const pr = await getPrForBranch(GITHUB_OWNER, GITHUB_REPO, worktree.branch);
        if (pr) {
          const reason = ciFailed ? 'CI checks did not pass' : handoffReason;
          console.log(`[HANDOFF] ${reason}. Flagging PR #${pr.number} for human review.`);
          await flagForHumanReview(GITHUB_OWNER, GITHUB_REPO, pr.number, reason);
        }
      } catch (err) {
        console.warn(`[HANDOFF] Failed to flag PR for review: ${err.message}`);
      }
    }

    // Verify a PR actually exists before we can call this a success (CRITIQUE #2).
    let prExists = merged; // a merge implies a PR existed
    if (!prExists && GITHUB_OWNER && GITHUB_REPO) {
      try {
        const pr = await getPrForBranch(GITHUB_OWNER, GITHUB_REPO, worktree.branch);
        prExists = !!pr;
      } catch (err) {
        console.warn(`[PR] Could not verify PR for ${worktree.branch}: ${err.message}`);
        prExists = false;
      }
    }

    const status = resolveStatus({ merged, needsHumanReview: blockingAtCap, overBudget, ciFailed, prExists });
    if (status === 'no-pr') {
      console.warn(`[PR] No pull request found for ${worktree.branch}. Fix is committed/pushed but no PR was opened — flagging as no-pr.`);
    }
    const totalCost = logResult(issue.number, {
      model: brainModel,
      cost: brainCost,
      status,
      duration: brainDuration,
      output: brainOutput,
    });

    return { issue: issue.number, status, cost: brainCost, totalCost };

  } finally {
    // Always clean up the worktree, even on crash
    console.log(`[CLEANUP] Removing worktree for issue #${issue.number}`);
    removeWorktree(repoPath, worktree.dir, worktree.branch);
  }
}

/**
 * The per-issue budget: PER_ISSUE_BUDGET_USD if set, else the ceiling sliced
 * across the worker pool. Single source of truth for runQueue and the startup
 * config check.
 */
export function resolvePerIssueBudget(costCeiling, concurrency, env = process.env) {
  return parseFloat(env.PER_ISSUE_BUDGET_USD || '0') || (costCeiling / Math.max(1, concurrency));
}

/**
 * Sanity-check the budget config before a run. Because an issue now reserves a
 * FULL per-issue budget before starting, perIssueBudget > ceiling means nothing
 * can ever start (hard error); perIssueBudget * concurrency > ceiling means the
 * pool can't all run at once, so effective concurrency drops (warning). Pure.
 * Returns { level: 'ok'|'warn'|'error', message, effectiveConcurrency }.
 */
export function checkBudgetConfig({ costCeiling, perIssueBudget, concurrency }) {
  if (!(perIssueBudget > 0) || !(costCeiling > 0)) {
    return { level: 'error', message: `COST_CEILING_USD ($${costCeiling}) and the per-issue budget ($${perIssueBudget}) must both be positive.`, effectiveConcurrency: 0 };
  }
  if (perIssueBudget > costCeiling) {
    return {
      level: 'error',
      message: `Per-issue budget ($${perIssueBudget.toFixed(2)}) exceeds COST_CEILING_USD ($${costCeiling.toFixed(2)}) — no issue can start. Lower PER_ISSUE_BUDGET_USD or raise the ceiling.`,
      effectiveConcurrency: 0,
    };
  }
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, Math.floor(costCeiling / perIssueBudget)));
  if (perIssueBudget * concurrency > costCeiling) {
    return {
      level: 'warn',
      message: `Per-issue budget ($${perIssueBudget.toFixed(2)}) × concurrency (${concurrency}) = $${(perIssueBudget * concurrency).toFixed(2)} exceeds the $${costCeiling.toFixed(2)} ceiling — at most ${effectiveConcurrency} issue(s) will run at once before the ceiling blocks new starts.`,
      effectiveConcurrency,
    };
  }
  return { level: 'ok', message: '', effectiveConcurrency: concurrency };
}

export async function runQueue(issues, repoPath, concurrency, costCeiling, dryRun, { priorCost = 0 } = {}) {
  const queue = [...issues];
  const results = [];
  let stopped = false;

  startRun();
  // Seed the run cost with spend that happened before the queue (discovery), so
  // the ceiling and per-issue reservations account for it (C1). startRun() reset
  // the in-memory total, so this must come after it.
  if (priorCost > 0) recordRunCost(priorCost);

  // Per-issue budget reservation prevents concurrent issues from each seeing
  // spend below the ceiling and collectively overspending. The reserved amount
  // becomes the workflow path's hard --max-budget-usd cap; for the hand-rolled
  // path it bounds how many issues run at once. Default slices the ceiling
  // across the worker pool; override with PER_ISSUE_BUDGET_USD.
  const effConcurrency = Math.max(1, Math.min(concurrency, queue.length));
  const perIssueBudget = resolvePerIssueBudget(costCeiling, effConcurrency);

  async function next() {
    while (queue.length > 0 && !stopped) {
      // Reserve a FULL per-issue budget before starting — never start an issue on
      // a crumb of leftover headroom. The workflow's --max-budget-usd is
      // best-effort (the CLI checks it between turns, not mid-turn), so a tiny
      // cap is effectively ignored and a crumb-start overshoots wildly. Reserving
      // the full budget makes the ceiling a meaningful token-cost governor.
      const budgetUsd = dryRun ? 0 : perIssueBudget;
      if (!dryRun && !reserveBudget(budgetUsd, costCeiling)) {
        console.log(`\n[COST CEILING] $${costCeiling} reached — not enough headroom for another issue ($${perIssueBudget.toFixed(2)}/issue). Not dispatching more; in-flight issues will finish.`);
        stopped = true;
        return;
      }

      const issue = queue.shift();
      try {
        const result = await processIssue(issue, repoPath, dryRun, { budgetUsd });
        results.push(result);
        // The CLI budget cap is best-effort; surface when an issue blew past it
        // so the ceiling's softness is visible rather than silent.
        if (!dryRun && (result.cost || 0) > budgetUsd * 1.1) {
          console.warn(`[BUDGET] #${issue.number} used $${(result.cost || 0).toFixed(2)} vs its $${budgetUsd.toFixed(2)} cap — --max-budget-usd is best-effort, so the ceiling is soft.`);
        }
        if (getRunCost() >= costCeiling) {
          stopped = true;
        }
      } finally {
        if (!dryRun) releaseBudget(budgetUsd);
      }
    }
  }

  const workers = Array.from(
    { length: effConcurrency },
    () => next()
  );
  await Promise.all(workers);

  return results;
}
