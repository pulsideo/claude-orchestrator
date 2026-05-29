import 'dotenv/config';
import { fetchIssues } from './github.js';
import { runQueue, resolvePerIssueBudget, checkBudgetConfig } from './dispatcher.js';
import { cleanupAllWorktrees, resolveRepoNodeBin } from './worktree.js';
import { delimiter } from 'path';
import { runDiscovery } from './discovery.js';
import { shouldShowMenu, runMenu } from './menu.js';
import { workflowOverrideWarning, costModeLabel } from './providers.js';

const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  REPO_LOCAL_PATH,
  DRY_RUN,
} = process.env;

async function main() {
  console.log(`\nClaude Issue Orchestrator`);
  console.log(`========================`);

  // Validate required env vars before anything else.
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !REPO_LOCAL_PATH) {
    console.error('Missing required environment variables. Copy .env.example to .env and fill in your values.');
    process.exit(1);
  }

  // Interactive settings menu (auto-skipped when headless or --no-menu).
  if (shouldShowMenu({ argv: process.argv.slice(2), env: process.env, isTTY: !!(process.stdin.isTTY && process.stdout.isTTY) })) {
    await runMenu(process.env);
  }

  // Read effective settings AFTER the menu may have changed them.
  const concurrency = parseInt(process.env.MAX_CONCURRENCY || '3', 10);
  const costCeiling = parseFloat(process.env.COST_CEILING_USD || '50');

  console.log(`\nRepo: ${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`Providers: default=${process.env.DEFAULT_PROVIDER || 'claude'}, fix=${process.env.FIX_PROVIDER || process.env.DEFAULT_PROVIDER || 'claude'}, review=${process.env.REVIEW_PROVIDER || process.env.DEFAULT_PROVIDER || 'claude'}`);
  console.log(`Concurrency: ${concurrency} | Cost ceiling: $${costCeiling} | Max iterations: ${process.env.MAX_ITERATIONS || '3'} | Auto-merge: ${process.env.AUTO_MERGE || 'false'}`);
  console.log(`Ceiling measures ${costModeLabel(process.env)}.`);
  console.log(`Discovery: ${process.env.DISCOVERY === 'true' ? `on (${process.env.DISCOVERY_SCOPE || 'whole repo'})` : 'off'}`);
  console.log(`Dry run: ${!!DRY_RUN}\n`);

  // Config sanity check: an issue reserves a full per-issue budget before
  // starting, so a budget bigger than the ceiling means nothing runs. Fail fast
  // before discovery spends anything.
  const perIssueBudget = resolvePerIssueBudget(costCeiling, concurrency, process.env);
  const budgetCheck = checkBudgetConfig({ costCeiling, perIssueBudget, concurrency });
  if (budgetCheck.level === 'error') {
    console.error(`[CONFIG] ${budgetCheck.message}`);
    process.exit(1);
  }
  if (budgetCheck.level === 'warn') {
    console.warn(`[CONFIG] ${budgetCheck.message}\n`);
  }

  // Surface a footgun: a non-Claude reviewer/default provider is ignored when
  // the Claude workflow brain runs (its sub-agents are always Claude).
  const wfWarning = workflowOverrideWarning(process.env);
  if (wfWarning) console.warn(`[WORKFLOW] ${wfWarning}\n`);

  // Run worktree tooling (install, vitest, lint) under the Node version the
  // target repo pins. execSync bypasses mise's shell hook, so without this a
  // repo pinning a different Node major fails every fix at 'worktree-failed'
  // (ERR_PNPM_UNSUPPORTED_ENGINE). Resolve once from the trusted main checkout
  // and prepend to PATH so all child processes inherit it.
  const repoNodeBin = resolveRepoNodeBin(REPO_LOCAL_PATH);
  if (repoNodeBin) {
    process.env.PATH = `${repoNodeBin}${delimiter}${process.env.PATH}`;
    console.log(`[INIT] Using repo-pinned Node toolchain: ${repoNodeBin}`);
  }

  // Clean up any leftover worktrees from previous runs
  console.log(`[INIT] Cleaning stale worktrees...`);
  cleanupAllWorktrees(REPO_LOCAL_PATH);

  // Optional discovery phase: scan the target repo and file new issues, which
  // the queue below then processes in the same run (ADR 0001).
  if (process.env.DISCOVERY === 'true' && !DRY_RUN) {
    try {
      const { filed } = await runDiscovery(GITHUB_OWNER, GITHUB_REPO, REPO_LOCAL_PATH);
      console.log(`[DISCOVERY] Filed ${filed.length} new issue(s).`);
    } catch (err) {
      console.warn(`[DISCOVERY] Discovery failed: ${err.error || err.message}. Continuing with existing issues.`);
    }
  }

  const issues = await fetchIssues(GITHUB_OWNER, GITHUB_REPO);
  console.log(`Found ${issues.length} issues to process:\n`);
  issues.forEach((issue, i) => {
    const labels = issue.labels.map(l => typeof l === 'string' ? l : l.name).join(', ');
    console.log(`  ${i + 1}. #${issue.number} [${labels}] ${issue.title}`);
  });

  if (issues.length === 0) {
    console.log('\nNo matching issues found. Exiting.');
    console.log('Make sure your issues have severity labels: critical, high, medium, low, or bug.');
    return;
  }

  console.log(`\nStarting processing...\n`);

  const results = await runQueue(
    issues,
    REPO_LOCAL_PATH,
    concurrency,
    costCeiling,
    !!DRY_RUN,
  );

  // Final cleanup
  console.log(`\n[CLEANUP] Final worktree cleanup...`);
  cleanupAllWorktrees(REPO_LOCAL_PATH);

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RUN COMPLETE`);
  console.log(`${'='.repeat(50)}`);
  const merged = results.filter(r => r.status === 'merged').length;
  const success = results.filter(r => r.status === 'success').length;
  const needsReview = results.filter(r => r.status === 'needs-human-review').length;
  const noPr = results.filter(r => r.status === 'no-pr').length;
  const fixTestsFailed = results.filter(r => r.status === 'fix-tests-failed').length;
  const testsMissing = results.filter(r => r.status === 'tests-missing').length;
  const lintFailed = results.filter(r => r.status === 'lint-failed').length;
  const ciFailed = results.filter(r => r.status === 'ci-failed').length;
  const knownStatuses = ['merged', 'success', 'no-pr', 'needs-human-review', 'fix-tests-failed', 'tests-missing', 'lint-failed', 'ci-failed', 'dry-run'];
  const errored = results.filter(r => !knownStatuses.includes(r.status)).length;
  const dryRunCount = results.filter(r => r.status === 'dry-run').length;

  if (dryRunCount > 0) {
    console.log(`Dry run: ${dryRunCount} issues would be processed`);
  } else {
    console.log(`Merged: ${merged}`);
    console.log(`Success (PR open, pending human review): ${success}`);
    if (needsReview > 0) {
      console.log(`Needs human review (refinement reverted): ${needsReview}`);
    }
    if (noPr > 0) {
      console.log(`No PR opened (fix pushed but no PR found): ${noPr}`);
    }
    if (testsMissing > 0) {
      console.log(`Fix added no tests (rejected): ${testsMissing}`);
    }
    if (lintFailed > 0) {
      console.log(`Lint failed: ${lintFailed}`);
    }
    if (ciFailed > 0) {
      console.log(`CI failed: ${ciFailed}`);
    }
    console.log(`Fix tests failed: ${fixTestsFailed}`);
    console.log(`Errored: ${errored}`);
    console.log(`Total processed: ${results.length}`);
  }

  console.log(`\nSee run-log.json for detailed results.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  try {
    cleanupAllWorktrees(process.env.REPO_LOCAL_PATH);
  } catch {}
  process.exit(1);
});
