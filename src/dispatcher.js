import { execSync } from 'child_process';
import { validateBranch, getSeverity, getPrForBranch, mergePr, flagForHumanReview, deleteRemoteBranch, waitForChecks } from './github.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { runTriageAgent, runFixAgent, runRefinementAgent } from './agent.js';
import { reviewWithGreptile } from './greptile.js';
import { logResult, getRunCost, startRun } from './logger.js';

const {
  GITHUB_OWNER,
  GITHUB_REPO,
  AUTO_MERGE = 'false',
} = process.env;

// Map a failing validation stage to the terminal status reported for the issue.
const VALIDATION_STATUS = {
  'tests-missing': 'tests-missing',
  tests: 'fix-tests-failed',
  lint: 'lint-failed',
  ci: 'ci-failed',
  error: 'validation-error',
};

/** Terminal status for a failed validation stage. */
export function statusForStage(stage) {
  return VALIDATION_STATUS[stage] || 'fix-tests-failed';
}

/**
 * Decide the terminal status for a processed issue from observed facts.
 * A fix that passes tests but has NO pull request is reported as 'no-pr',
 * never 'success' (CRITIQUE #2) — so the run summary can't claim a fix landed
 * when nothing was opened.
 */
export function resolveStatus({ merged, refinementReverted, ciFailed, prExists }) {
  if (merged) return 'merged';
  if (refinementReverted) return 'needs-human-review';
  if (ciFailed) return 'ci-failed';
  if (!prExists) return 'no-pr';
  return 'success';
}

export async function processIssue(issue, repoPath, dryRun = false) {
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
    return { issue: issue.number, status: 'worktree-failed', error: err.message };
  }

  try {
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

    // Phase 4: Validate (tests-present → tests-pass → lint gates)
    console.log(`[VALIDATE] Running validation gates...`);
    const validation = await validateBranch(worktree.dir);
    if (!validation.passed) {
      const failStatus = statusForStage(validation.stage);
      console.log(`[VALIDATE] ${failStatus} (stage: ${validation.stage})`);
      console.log(`[VALIDATE] Error: ${validation.error}`);
      const cost = (triageResult?.cost || 0) + (fixResult?.cost || 0);
      const totalCost = logResult(issue.number, {
        model: fixResult.model,
        cost,
        status: failStatus,
        duration: (triageResult?.duration || 0) + fixResult.duration,
        output: fixResult.output,
      });
      return { issue: issue.number, status: failStatus, cost, totalCost };
    }
    console.log(`[VALIDATE] passed`);

    // Phase 5: Greptile code review and refine
    let refineCost = 0;
    let refineDuration = 0;
    let refinementReverted = false;
    if (process.env.GREPTILE_API_KEY) {
      try {
        console.log(`[REVIEW] Requesting Greptile code review...`);
        const comments = await reviewWithGreptile(worktree.dir);

        if (comments.length > 0) {
          console.log(`[REVIEW] Got ${comments.length} Greptile comment(s). Running refinement agent...`);
          try {
            const refineResult = await runRefinementAgent(issue, comments, worktree.dir);
            refineCost = refineResult.cost;
            refineDuration = refineResult.duration;
            console.log(`[REFINE] Done (${(refineDuration / 1000).toFixed(1)}s, $${refineCost})`);

            // Re-validate after refinement
            console.log(`[VALIDATE] Re-running tests after refinement...`);
            const revalidation = await validateBranch(worktree.dir);
            if (!revalidation.passed) {
              console.log(`[VALIDATE] Refinement broke tests: ${revalidation.error}`);
              console.log(`[REFINE] Reverting refinement commit...`);
              execSync('git reset --hard HEAD~1', { cwd: worktree.dir, stdio: 'pipe' });
              execSync(`git push origin ${worktree.branch} --force-with-lease`, { cwd: worktree.dir, stdio: 'pipe' });
              refinementReverted = true;
            } else {
              console.log(`[VALIDATE] Still passing after refinement`);
            }
          } catch (err) {
            console.warn(`[REFINE] Refinement failed: ${err.error || err.message}. Continuing with original fix.`);
          }
        } else {
          console.log(`[REVIEW] Greptile returned no comments. Proceeding with original fix.`);
        }
      } catch (err) {
        console.warn(`[REVIEW] Greptile review failed: ${err.message}. Proceeding without review.`);
      }
    }

    // Phase 5.5: optional CI gate — wait for the PR's GitHub checks to go green
    // before treating the fix as confirmed (opt-in via WAIT_FOR_CI).
    let ciFailed = false;
    if (process.env.WAIT_FOR_CI === 'true' && !refinementReverted && GITHUB_OWNER && GITHUB_REPO) {
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
        console.warn(`[CI] Could not evaluate CI checks: ${err.message}. Proceeding without CI gate.`);
      }
    }

    // Phase 6: Auto-merge only when confirmed (tests+lint passed, refinement not
    // reverted, CI green), otherwise flag for human review.
    let merged = false;
    if (AUTO_MERGE === 'true' && !refinementReverted && !ciFailed && GITHUB_OWNER && GITHUB_REPO) {
      const MAX_MERGE_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_MERGE_RETRIES; attempt++) {
        try {
          const pr = await getPrForBranch(GITHUB_OWNER, GITHUB_REPO, worktree.branch);
          if (!pr) break;
          console.log(`[MERGE] Tests passing after review cycle. Merging PR #${pr.number} into main...`);
          await mergePr(GITHUB_OWNER, GITHUB_REPO, pr.number);
          console.log(`[MERGE] PR #${pr.number} merged successfully.`);
          merged = true;
          // Clean up the remote branch so fix/issue-N branches don't pile up.
          try {
            await deleteRemoteBranch(GITHUB_OWNER, GITHUB_REPO, worktree.branch);
            console.log(`[MERGE] Deleted remote branch ${worktree.branch}.`);
          } catch (err) {
            console.warn(`[MERGE] Could not delete remote branch ${worktree.branch}: ${err.message}`);
          }
          break;
        } catch (err) {
          const isStaleBase = err.message?.includes('Base branch was modified');
          const isNotMergeable = err.message?.includes('not mergeable') || err.message?.includes('Pull Request is not mergeable');
          if ((isStaleBase || isNotMergeable) && attempt < MAX_MERGE_RETRIES) {
            console.log(`[MERGE] ${isStaleBase ? 'Base branch changed' : 'PR not mergeable (likely conflict)'}. Rebasing and retrying (attempt ${attempt}/${MAX_MERGE_RETRIES})...`);
            try {
              execSync('git fetch origin main', { cwd: worktree.dir, stdio: 'pipe' });
              execSync('git rebase origin/main', { cwd: worktree.dir, stdio: 'pipe' });
              execSync(`git push origin ${worktree.branch} --force-with-lease`, { cwd: worktree.dir, stdio: 'pipe' });
              // Re-validate after rebase
              console.log(`[MERGE] Re-running tests after rebase...`);
              const postRebase = await validateBranch(worktree.dir);
              if (!postRebase.passed) {
                console.warn(`[MERGE] Tests failed after rebase: ${postRebase.error}`);
                break;
              }
            } catch (rebaseErr) {
              console.warn(`[MERGE] Rebase failed: ${rebaseErr.message}. Aborting merge.`);
              try { execSync('git rebase --abort', { cwd: worktree.dir, stdio: 'pipe' }); } catch {}
              break;
            }
          } else {
            console.warn(`[MERGE] Failed to merge: ${err.message}`);
            break;
          }
        }
      }
    } else if ((refinementReverted || ciFailed) && GITHUB_OWNER && GITHUB_REPO) {
      try {
        const pr = await getPrForBranch(GITHUB_OWNER, GITHUB_REPO, worktree.branch);
        if (pr) {
          const reason = refinementReverted ? 'Refinement was reverted' : 'CI checks did not pass';
          console.log(`[MERGE] ${reason}. Flagging PR #${pr.number} for human review.`);
          await flagForHumanReview(GITHUB_OWNER, GITHUB_REPO, pr.number);
        }
      } catch (err) {
        console.warn(`[MERGE] Failed to flag PR for review: ${err.message}`);
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

    const status = resolveStatus({ merged, refinementReverted, ciFailed, prExists });
    if (status === 'no-pr') {
      console.warn(`[PR] No pull request found for ${worktree.branch}. Fix is committed/pushed but no PR was opened — flagging as no-pr.`);
    }
    const cost = (triageResult?.cost || 0) + (fixResult?.cost || 0) + refineCost;
    const totalCost = logResult(issue.number, {
      model: fixResult.model,
      cost,
      status,
      duration: (triageResult?.duration || 0) + fixResult.duration + refineDuration,
      output: fixResult.output,
    });

    return { issue: issue.number, status, cost, totalCost };

  } finally {
    // Always clean up the worktree, even on crash
    console.log(`[CLEANUP] Removing worktree for issue #${issue.number}`);
    removeWorktree(repoPath, worktree.dir, worktree.branch);
  }
}

export async function runQueue(issues, repoPath, concurrency, costCeiling, dryRun) {
  const queue = [...issues];
  const results = [];
  let stopped = false;

  startRun();

  async function next() {
    while (queue.length > 0 && !stopped) {
      if (getRunCost() >= costCeiling) {
        console.log(`\n[COST CEILING] Reached $${costCeiling} limit. Stopping.`);
        stopped = true;
        return;
      }

      const issue = queue.shift();
      const result = await processIssue(issue, repoPath, dryRun);
      results.push(result);

      if (result.totalCost >= costCeiling) {
        stopped = true;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    () => next()
  );
  await Promise.all(workers);

  return results;
}
