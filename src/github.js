import { Octokit } from '@octokit/rest';
import { execSync } from 'child_process';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

function isTransientError(err) {
  const msg = err.message || '';
  const status = err.status || 0;
  return status >= 500 ||
    msg.includes('socket disconnected') ||
    msg.includes('other side closed') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('network');
}

async function withRetry(fn, label = 'API call') {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isTransientError(err) && attempt < MAX_RETRIES) {
        console.warn(`[RETRY] ${label} failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}. Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function severityScore(issue) {
  const labelNames = issue.labels.map(l =>
    typeof l === 'string' ? l : l.name
  );
  for (let i = 0; i < SEVERITY_ORDER.length; i++) {
    if (labelNames.includes(SEVERITY_ORDER[i])) return i;
  }
  return 99;
}

export async function fetchIssues(owner, repo) {
  const { data: issues } = await withRetry(
    () => octokit.issues.listForRepo({ owner, repo, state: 'open', per_page: 100 }),
    'fetchIssues',
  );

  const bugs = issues.filter(issue => {
    if (issue.pull_request) return false;
    const labelNames = issue.labels.map(l => typeof l === 'string' ? l : l.name);
    return labelNames.some(l =>
      SEVERITY_ORDER.includes(l) || l === 'bug'
    );
  });

  return bugs.sort((a, b) => severityScore(a) - severityScore(b));
}

export function getSeverity(issue) {
  const labelNames = issue.labels.map(l => typeof l === 'string' ? l : l.name);
  for (const s of SEVERITY_ORDER) {
    if (labelNames.includes(s)) return s;
  }
  return 'medium';
}

export async function validateBranch(worktreeDir) {
  try {
    // Collect changed files: committed changes vs origin/main + any uncommitted changes
    const committed = execSync('git diff --name-only origin/main...HEAD', {
      cwd: worktreeDir, encoding: 'utf-8',
    }).trim();
    const staged = execSync('git diff --name-only --cached', {
      cwd: worktreeDir, encoding: 'utf-8',
    }).trim();
    const unstaged = execSync('git diff --name-only', {
      cwd: worktreeDir, encoding: 'utf-8',
    }).trim();

    const allChanged = [...new Set(
      [committed, staged, unstaged].join('\n').split('\n').filter(Boolean)
    )];

    const codeFiles = allChanged.filter(f => /\.(ts|tsx|js|jsx)$/.test(f));

    if (codeFiles.length === 0) {
      return { passed: true }; // no code changes to test
    }

    const quotedFiles = codeFiles.map(f => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
    const vitestCmd = `npx vitest related ${quotedFiles} --reporter=json`;

    // Run related tests on the fix branch
    let fixOutput;
    try {
      fixOutput = execSync(vitestCmd, {
        cwd: worktreeDir, stdio: 'pipe', timeout: 120_000,
      }).toString();
    } catch (err) {
      // vitest exits non-zero when tests fail — stdout still has JSON results
      fixOutput = err.stdout?.toString() || '';
      if (!fixOutput) {
        return { passed: false, error: err.stderr?.toString() || err.message };
      }
    }

    const fixFailures = parseFailedTests(fixOutput);
    if (fixFailures.length === 0) {
      return { passed: true };
    }

    // Tests failed — check which ones already fail on origin/main (pre-existing)
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreeDir, encoding: 'utf-8',
    }).trim();

    let baseFailures = [];
    try {
      execSync('git checkout origin/main --quiet', { cwd: worktreeDir, stdio: 'pipe' });
      let baseOutput;
      try {
        baseOutput = execSync(vitestCmd, {
          cwd: worktreeDir, stdio: 'pipe', timeout: 120_000,
        }).toString();
      } catch (err) {
        baseOutput = err.stdout?.toString() || '';
      }
      baseFailures = parseFailedTests(baseOutput);
    } finally {
      execSync(`git checkout ${currentBranch} --quiet`, { cwd: worktreeDir, stdio: 'pipe' });
    }

    // Only fail on NEW test failures introduced by the fix
    const baseFailureSet = new Set(baseFailures);
    const newFailures = fixFailures.filter(t => !baseFailureSet.has(t));

    if (newFailures.length === 0) {
      return { passed: true }; // only pre-existing failures
    }

    return {
      passed: false,
      error: `New test failures: ${newFailures.join(', ')}`,
    };
  } catch (err) {
    return { passed: false, error: err.stderr?.toString() || err.message };
  }
}

function parseFailedTests(jsonOutput) {
  try {
    const result = JSON.parse(jsonOutput);
    const failures = [];
    for (const file of result.testResults || []) {
      for (const test of file.assertionResults || []) {
        if (test.status === 'failed') {
          failures.push(test.fullName || test.title || 'unknown');
        }
      }
    }
    return failures;
  } catch {
    return [];
  }
}

/**
 * Find the PR number for a branch by querying GitHub.
 */
export async function getPrForBranch(owner, repo, branch) {
  const { data: prs } = await withRetry(
    () => octokit.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: 'open', per_page: 1 }),
    `getPrForBranch(${branch})`,
  );
  return prs[0] || null;
}

/**
 * Add a "needs-human-review" label and a comment explaining why.
 */
export async function flagForHumanReview(owner, repo, prNumber) {
  await withRetry(
    () => Promise.all([
      octokit.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: ['needs-human-review'],
      }),
      octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: '⚠️ **Auto-merge skipped.** The refinement agent\'s changes broke tests and were reverted. The original fix is intact and passing, but this PR needs a human review before merging.',
      }),
    ]),
    `flagForHumanReview(#${prNumber})`,
  );
}

/**
 * Merge a PR using the squash strategy.
 */
export async function mergePr(owner, repo, prNumber) {
  await withRetry(
    () => octokit.pulls.merge({ owner, repo, pull_number: prNumber, merge_method: 'squash' }),
    `mergePr(#${prNumber})`,
  );
}

