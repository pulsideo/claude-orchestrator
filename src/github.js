import { Octokit } from '@octokit/rest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { detectPackageManager } from './worktree.js';

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
  // Unreachable today (the last attempt always throws), but guards against
  // future changes to the retry guard silently returning undefined.
  throw new Error(`${label} exhausted ${MAX_RETRIES} retries`);
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export function severityScore(issue) {
  const labelNames = issue.labels.map(l =>
    typeof l === 'string' ? l : l.name
  );
  for (let i = 0; i < SEVERITY_ORDER.length; i++) {
    if (labelNames.includes(SEVERITY_ORDER[i])) return i;
  }
  return 99;
}

export async function fetchIssues(owner, repo) {
  // paginate so repos with >100 open issues don't silently drop the overflow.
  const issues = await withRetry(
    () => octokit.paginate(octokit.issues.listForRepo, { owner, repo, state: 'open', per_page: 100 }),
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

/** Create a GitHub issue (used by the discovery agent to file found bugs). */
export async function createIssue(owner, repo, { title, body, labels = [] }) {
  const { data } = await withRetry(
    () => octokit.issues.create({ owner, repo, title, body, labels }),
    `createIssue(${title})`,
  );
  return data;
}

/** Titles of all open issues (not PRs), for discovery dedup. */
export async function fetchOpenIssueTitles(owner, repo) {
  const issues = await withRetry(
    () => octokit.paginate(octokit.issues.listForRepo, { owner, repo, state: 'open', per_page: 100 }),
    'fetchOpenIssueTitles',
  );
  return issues.filter(i => !i.pull_request).map(i => i.title);
}

export function getSeverity(issue) {
  const labelNames = issue.labels.map(l => typeof l === 'string' ? l : l.name);
  for (const s of SEVERITY_ORDER) {
    if (labelNames.includes(s)) return s;
  }
  return 'medium';
}

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|cjs|mjs)$/;
const TEST_FILE_RE = /(\.(test|spec)\.(ts|tsx|js|jsx|cjs|mjs)$|(^|\/)(__tests__|tests?)\/)/;

/** True if a path looks like a test file (by suffix or test directory). */
export function isTestFile(path) {
  return TEST_FILE_RE.test(path);
}

/** Split changed paths into production code vs test files. */
export function classifyChangedFiles(files) {
  const code = [];
  const tests = [];
  for (const f of files) {
    if (!CODE_FILE_RE.test(f)) continue;
    (isTestFile(f) ? tests : code).push(f);
  }
  return { code, tests };
}

/** Whether the "fix must include tests" gate is enabled (default: yes). */
export function requireTests(env = process.env) {
  return env.REQUIRE_TESTS !== 'false';
}

/** Resolve the lint command: LINT_COMMAND overrides; else the repo's `lint` script; else none. */
export function detectLintCommand(worktreeDir, env = process.env) {
  if (env.LINT_COMMAND) return env.LINT_COMMAND;
  try {
    const pkg = JSON.parse(readFileSync(join(worktreeDir, 'package.json'), 'utf-8'));
    if (pkg.scripts?.lint) {
      return `${detectPackageManager(worktreeDir, env)} run lint`;
    }
  } catch {
    // no package.json / unreadable — no lint gate
  }
  return null;
}

function collectChangedFiles(worktreeDir) {
  const ranges = [
    'git diff --name-only origin/main...HEAD',
    'git diff --name-only --cached',
    'git diff --name-only',
  ];
  const out = ranges
    .map(cmd => execSync(cmd, { cwd: worktreeDir, encoding: 'utf-8' }).trim())
    .join('\n');
  return [...new Set(out.split('\n').filter(Boolean))];
}

/** True if `output` is a parseable vitest JSON report (tests actually ran). */
export function isVitestReport(output) {
  try {
    return Array.isArray(JSON.parse(output).testResults);
  } catch {
    return false;
  }
}

/**
 * Run vitest once and classify the outcome:
 *   ran=true  → it produced a JSON report (tests executed; `failures` lists them)
 *   ran=false → it crashed before running them (module resolution / config
 *               error). `detail` carries the combined stdout+stderr.
 * Distinguishing a crash from "no failures" matters: parseFailedTests returns []
 * for both, so a crash that printed non-JSON would otherwise look like a pass.
 */
function runVitest(worktreeDir, vitestCmd) {
  let output;
  let threw = false;
  let detail = '';
  try {
    output = execSync(vitestCmd, { cwd: worktreeDir, stdio: 'pipe', timeout: 120_000 }).toString();
  } catch (err) {
    threw = true;
    output = err.stdout?.toString() || '';
    detail = [output, err.stderr?.toString()].filter(Boolean).join('\n').trim().slice(0, 2000) || err.message;
  }
  if (isVitestReport(output)) return { ran: true, failures: parseFailedTests(output) };
  if (!threw) return { ran: true, failures: [] }; // exited 0 without a report (defensive)
  return { ran: false, failures: [], detail };
}

function runRelatedTests(worktreeDir, codeFiles) {
  const quotedFiles = codeFiles.map(f => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
  const vitestCmd = `npx vitest related ${quotedFiles} --reporter=json`;

  const fix = runVitest(worktreeDir, vitestCmd);
  if (fix.ran && fix.failures.length === 0) return { passed: true };

  // Re-run on origin/main so we only block on regressions the fix introduced —
  // not pre-existing failures, nor environmental crashes (e.g. an unbuilt
  // workspace package) that also happen on a clean main.
  const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: worktreeDir, encoding: 'utf-8' }).trim();
  let base;
  try {
    execSync('git checkout origin/main --quiet', { cwd: worktreeDir, stdio: 'pipe' });
    base = runVitest(worktreeDir, vitestCmd);
  } finally {
    execSync(`git checkout ${currentBranch} --quiet`, { cwd: worktreeDir, stdio: 'pipe' });
  }

  if (!fix.ran) {
    // Vitest couldn't run the related tests on the branch at all.
    if (!base.ran) {
      // Same on a clean main → environmental/pre-existing, not the fix. Don't
      // blame the fix, but make it loud: the test gate did not validate it.
      console.warn(`[VALIDATE] vitest could not run the related tests on either the fix branch or origin/main — environmental, skipping the test gate.\n${fix.detail}`);
      return { passed: true };
    }
    // Tests run on main but crash on the branch → the fix broke the run itself.
    return { passed: false, error: `The fix prevents vitest from running the related tests:\n${fix.detail}` };
  }

  // Both produced reports — block only on tests the fix newly broke.
  const baseFailureSet = new Set(base.ran ? base.failures : []);
  const newFailures = fix.failures.filter(t => !baseFailureSet.has(t));
  if (newFailures.length === 0) return { passed: true };
  return { passed: false, error: `New test failures: ${newFailures.join(', ')}` };
}

function lintOnce(cmd, worktreeDir) {
  try {
    execSync(cmd, { cwd: worktreeDir, stdio: 'pipe', timeout: 120_000 });
    return { ok: true, out: '' };
  } catch (err) {
    return { ok: false, out: (err.stdout?.toString() || '') + (err.stderr?.toString() || '') };
  }
}

function runLintGate(worktreeDir, env) {
  const cmd = detectLintCommand(worktreeDir, env);
  if (!cmd) return { passed: true }; // no linter configured — nothing to gate on

  const branch = lintOnce(cmd, worktreeDir);
  if (branch.ok) return { passed: true };

  // Lint failed on the branch — only block if it was clean on origin/main, so
  // we don't fail the fix on pre-existing lint debt.
  const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: worktreeDir, encoding: 'utf-8' }).trim();
  let baseOk;
  try {
    execSync('git checkout origin/main --quiet', { cwd: worktreeDir, stdio: 'pipe' });
    baseOk = lintOnce(cmd, worktreeDir).ok;
  } finally {
    execSync(`git checkout ${currentBranch} --quiet`, { cwd: worktreeDir, stdio: 'pipe' });
  }
  if (!baseOk) return { passed: true }; // pre-existing lint failures — don't block
  return { passed: false, error: `New lint errors:\n${branch.out.slice(0, 2000)}` };
}

/**
 * Validate a fix branch through ordered gates. Returns the failing `stage` so
 * the caller can report a precise status:
 *   tests-missing → code changed but no test added/modified
 *   tests         → new test failures introduced by the fix
 *   lint          → new lint errors introduced by the fix
 */
export async function validateBranch(worktreeDir, env = process.env) {
  try {
    const { code, tests } = classifyChangedFiles(collectChangedFiles(worktreeDir));

    if (code.length === 0) return { passed: true }; // no production code changed

    // Gate: a fix that changes code must add or modify tests.
    if (requireTests(env) && tests.length === 0) {
      return {
        passed: false,
        stage: 'tests-missing',
        error: `Fix changed code (${code.join(', ')}) but added/modified no tests. Set REQUIRE_TESTS=false to disable this gate.`,
      };
    }

    // Gate: related tests must pass (no new failures).
    const testResult = runRelatedTests(worktreeDir, code);
    if (!testResult.passed) return { passed: false, stage: 'tests', error: testResult.error };

    // Gate: linter must pass (no new errors).
    const lintResult = runLintGate(worktreeDir, env);
    if (!lintResult.passed) return { passed: false, stage: 'lint', error: lintResult.error };

    return { passed: true };
  } catch (err) {
    return { passed: false, stage: 'error', error: err.stderr?.toString() || err.message };
  }
}

export function parseFailedTests(jsonOutput) {
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
 * Create the PR for a branch, or return the existing one (idempotent). The
 * orchestrator owns PR creation so a PR reliably exists before the review loop
 * and the human handoff (ADR 0003) — the fix agent no longer runs `gh pr create`.
 */
export async function createPr(owner, repo, branch, title, body, base = 'main') {
  const existing = await getPrForBranch(owner, repo, branch);
  if (existing) return existing;
  const { data } = await withRetry(
    () => octokit.pulls.create({ owner, repo, title, body, head: branch, base }),
    `createPr(${branch})`,
  );
  return data;
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

/**
 * Delete a remote branch after its PR is merged so fix/issue-N branches don't
 * accumulate on the remote (CRITIQUE #6). Best-effort: a missing ref (e.g.
 * GitHub's auto-delete-head already removed it) is not an error.
 */
export async function deleteRemoteBranch(owner, repo, branch) {
  try {
    await withRetry(
      () => octokit.git.deleteRef({ owner, repo, ref: `heads/${branch}` }),
      `deleteRemoteBranch(${branch})`,
    );
  } catch (err) {
    if (err.status === 422 || err.status === 404) return; // already deleted
    throw err;
  }
}

/**
 * Summarize GitHub check-runs for a commit into a terminal decision.
 * Pure: takes the check-run array, returns counts + an overall state of
 * 'pending' | 'passed' | 'failed'. A run is failing if it completed with a
 * non-success/neutral/skipped conclusion.
 */
export function summarizeChecks(checkRuns = []) {
  const passingConclusions = new Set(['success', 'neutral', 'skipped']);
  let pending = 0, failed = 0, passed = 0;
  for (const run of checkRuns) {
    if (run.status !== 'completed') { pending++; continue; }
    if (passingConclusions.has(run.conclusion)) passed++;
    else failed++;
  }
  let state = 'passed';
  if (failed > 0) state = 'failed';
  else if (pending > 0) state = 'pending';
  return { total: checkRuns.length, pending, failed, passed, state };
}

/**
 * Wait for the PR head SHA's CI checks to finish. Opt-in (WAIT_FOR_CI=true).
 * Returns { passed, error }. Polls until all checks complete or the timeout is
 * hit; a timeout with checks still pending is treated as not-passed.
 * (No offline test seam — exercises the live GitHub checks API.)
 */
export async function waitForChecks(owner, repo, ref, {
  timeoutMs = Number(process.env.CI_TIMEOUT_MS) || 600_000,
  intervalMs = Number(process.env.CI_POLL_INTERVAL_MS) || 15_000,
  now = Date.now,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const { data } = await withRetry(
      () => octokit.checks.listForRef({ owner, repo, ref, per_page: 100 }),
      `waitForChecks(${ref})`,
    );
    const summary = summarizeChecks(data.check_runs);
    if (summary.total === 0) return { passed: true }; // no CI configured
    if (summary.state === 'failed') return { passed: false, error: `${summary.failed} CI check(s) failed` };
    if (summary.state === 'passed') return { passed: true };
    if (now() >= deadline) return { passed: false, error: `CI still pending after ${Math.round(timeoutMs / 1000)}s (${summary.pending} unfinished)` };
    await sleep(intervalMs);
  }
}

