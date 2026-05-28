import 'dotenv/config';
import { fetchIssues } from './github.js';
import { runQueue } from './dispatcher.js';
import { cleanupAllWorktrees } from './worktree.js';

const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  REPO_LOCAL_PATH,
  MAX_CONCURRENCY = '3',
  COST_CEILING_USD = '50',
  DRY_RUN,
} = process.env;

async function main() {
  console.log(`\nClaude Issue Orchestrator`);
  console.log(`========================`);
  console.log(`Repo: ${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`Concurrency: ${MAX_CONCURRENCY}`);
  console.log(`Cost ceiling: $${COST_CEILING_USD}`);
  console.log(`Dry run: ${!!DRY_RUN}\n`);

  // Validate required env vars
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !REPO_LOCAL_PATH) {
    console.error('Missing required environment variables. Copy .env.example to .env and fill in your values.');
    process.exit(1);
  }

  // Clean up any leftover worktrees from previous runs
  console.log(`[INIT] Cleaning stale worktrees...`);
  cleanupAllWorktrees(REPO_LOCAL_PATH);

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
    parseInt(MAX_CONCURRENCY),
    parseFloat(COST_CEILING_USD),
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
