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

const DEFAULT_CODE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs'];

/**
 * Which file extensions count as code (#6). Defaults to JS/TS — the stack the
 * test/lint gates natively understand — but a repo in another language can widen
 * this (e.g. CODE_FILE_EXTENSIONS="py" or "go,rs") so its fix isn't mislabeled
 * 'no-code-change'. Pair with TEST_COMMAND/LINT_COMMAND for the gates themselves.
 */
export function codeExtensions(env = process.env) {
  const raw = (env.CODE_FILE_EXTENSIONS || '').trim();
  if (!raw) return DEFAULT_CODE_EXTENSIONS;
  return raw.split(/[\s,]+/).map(e => e.replace(/^\./, '')).filter(Boolean);
}

/** Regex-escaped alternation of the configured code extensions. */
function extAlternation(env) {
  return codeExtensions(env).map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/** True if a path has a configured code extension. */
function isCodeFile(path, env = process.env) {
  return new RegExp(`\\.(${extAlternation(env)})$`).test(path);
}

/**
 * True if a path looks like a test file: a test directory (__tests__/, test/,
 * tests/), or a recognized naming convention on a configured code extension —
 * `.test.`/`.spec.` (JS/TS), `_test.` (Go), or a `test_` prefix (Python).
 */
export function isTestFile(path, env = process.env) {
  if (/(^|\/)(__tests__|tests?)\//.test(path)) return true;
  const exts = extAlternation(env);
  return new RegExp(`(\\.(test|spec)\\.(${exts})$)|(_test\\.(${exts})$)|((^|/)test_[^/]*\\.(${exts})$)`).test(path);
}

/** Split changed paths into production code vs test files. */
export function classifyChangedFiles(files, env = process.env) {
  const code = [];
  const tests = [];
  for (const f of files) {
    if (!isCodeFile(f, env)) continue;
    (isTestFile(f, env) ? tests : code).push(f);
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
 * Decide how to run tests for a checkout (A1). vitest and jest get related-test
 * selection (fast, scoped to the fix's files) and emit a parseable JSON report;
 * any other repo with a `test` script falls back to running the whole suite and
 * classifying by exit code (`parse:false`). `TEST_COMMAND` overrides everything.
 * Returns null when no runner can be determined — the caller fails CLOSED rather
 * than skipping the gate (the old code's silent pass was the bug). Pure.
 */
export function detectTestRunner(dir, env = process.env) {
  if (env.TEST_COMMAND) return { kind: 'custom', parse: false };
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')); }
  catch { return null; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vitest) return { kind: 'vitest', parse: true };
  if (deps.jest) return { kind: 'jest', parse: true };
  if (pkg.scripts?.test) return { kind: 'script', parse: false };
  return null;
}

/**
 * The human-runnable test command for a checkout, injected into the agent
 * prompts so they don't hardcode `npx vitest run` in a jest/script repo (#7).
 * Mirrors how the gate actually runs (detectTestRunner): TEST_COMMAND override,
 * else vitest/jest, else the repo's `<pm> test`. Guidance only — the gate, not
 * the prompt, is authoritative. Pure.
 */
export function displayTestCommand(dir, env = process.env) {
  if (env.TEST_COMMAND) return env.TEST_COMMAND;
  const runner = detectTestRunner(dir, env);
  switch (runner?.kind) {
    case 'vitest': return 'npx vitest run';
    case 'jest': return 'npx jest';
    default: return `${detectPackageManager(dir, env)} test`;
  }
}

/** Build the test command for a detected runner. `parse` flags JSON output. */
function planTests(runner, dir, codeFiles, env) {
  const quoted = codeFiles.map(f => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
  switch (runner.kind) {
    case 'vitest': return { parse: true, cmd: `npx vitest related ${quoted} --reporter=json` };
    case 'jest': return { parse: true, cmd: `npx jest --findRelatedTests ${quoted} --json` };
    case 'custom': return { parse: false, cmd: env.TEST_COMMAND };
    default: return { parse: false, cmd: `${detectPackageManager(dir, env)} test` };
  }
}

/**
 * Run one test command and classify the outcome as 'pass' | 'fail' | 'error':
 *   parse:true  (vitest/jest JSON) — a report with no failures → pass; a report
 *               with failures → fail (`failures` lists them); NO report → error
 *               (crashed before running: module resolution / config).
 *   parse:false (whole-suite script) — exit 0 → pass; non-zero → fail. A script
 *               can't distinguish a crash from a real failure, so there is no
 *               'error' outcome; the origin/main comparison handles attribution.
 * Distinguishing a crash from "no failures" matters: parseFailedTests returns []
 * for both, so a crash that printed non-JSON would otherwise look like a pass.
 */
function runTestSuite(worktreeDir, plan) {
  let output;
  let threw = false;
  let detail = '';
  try {
    output = execSync(plan.cmd, { cwd: worktreeDir, stdio: 'pipe', timeout: 120_000 }).toString();
  } catch (err) {
    threw = true;
    output = err.stdout?.toString() || '';
    detail = [output, err.stderr?.toString()].filter(Boolean).join('\n').trim().slice(0, 2000) || err.message;
  }
  if (plan.parse) {
    if (isVitestReport(output)) {
      const failures = parseFailedTests(output);
      return { outcome: failures.length ? 'fail' : 'pass', failures, detail };
    }
    if (!threw) return { outcome: 'pass', failures: [], detail }; // exited 0, no report (defensive)
    return { outcome: 'error', failures: [], detail };
  }
  return { outcome: threw ? 'fail' : 'pass', failures: [], detail };
}

/**
 * Run the fix's related tests and decide whether the fix breaks them, comparing
 * against origin/main so pre-existing failures aren't blamed on the fix (A1).
 * FAILS CLOSED: when tests can't be validated at all (no runner, or they crash
 * on both the branch and a clean main), returns `{ passed:false, unvalidated:true }`
 * so the caller hands the PR to a human instead of silently passing the gate.
 */
function runRelatedTests(worktreeDir, codeFiles, env = process.env) {
  const runner = detectTestRunner(worktreeDir, env);
  if (!runner) {
    return { passed: false, unvalidated: true, error: 'No test runner detected (no vitest/jest dep and no `test` script) — cannot validate the fix.' };
  }
  const plan = planTests(runner, worktreeDir, codeFiles, env);

  const fix = runTestSuite(worktreeDir, plan);
  if (fix.outcome === 'pass') return { passed: true };

  // Re-run on origin/main so we only block on regressions the fix introduced —
  // not pre-existing failures, nor environmental crashes (e.g. an unbuilt
  // workspace package) that also happen on a clean main.
  const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: worktreeDir, encoding: 'utf-8' }).trim();
  let base;
  try {
    execSync('git checkout origin/main --quiet', { cwd: worktreeDir, stdio: 'pipe' });
    base = runTestSuite(worktreeDir, plan);
  } finally {
    execSync(`git checkout ${currentBranch} --quiet`, { cwd: worktreeDir, stdio: 'pipe' });
  }

  if (fix.outcome === 'error') {
    // Tests couldn't run on the branch at all.
    if (base.outcome === 'error') {
      // Same on a clean main → environmental. We did NOT validate the fix, so
      // (unlike the old code) we do NOT pass the gate — hand it to a human.
      console.warn(`[VALIDATE] tests could not run on either the fix branch or origin/main — unable to validate; handing to human review.\n${fix.detail}`);
      return { passed: false, unvalidated: true, error: `Tests could not run on the fix branch or a clean origin/main:\n${fix.detail}` };
    }
    // Tests run on main but crash on the branch → the fix broke the run itself.
    return { passed: false, error: `The fix prevents the related tests from running:\n${fix.detail}` };
  }

  // Both ran. For JSON runners, block only on tests the fix newly broke.
  if (plan.parse) {
    const baseFailureSet = new Set(base.outcome === 'error' ? [] : base.failures);
    const newFailures = fix.failures.filter(t => !baseFailureSet.has(t));
    if (newFailures.length === 0) return { passed: true };
    return { passed: false, error: `New test failures: ${newFailures.join(', ')}` };
  }

  // Whole-suite script: fix failed. Blame it only if main was green; if main is
  // also red we can't attribute the failure, so fail closed to human review.
  if (base.outcome === 'pass') {
    return { passed: false, error: `The fix's test suite fails (clean on origin/main):\n${fix.detail}` };
  }
  console.warn(`[VALIDATE] the test suite fails on both the fix branch and origin/main — pre-existing breakage, unable to validate the fix.`);
  return { passed: false, unvalidated: true, error: `Test suite fails on both the fix branch and a clean origin/main; cannot attribute to the fix.` };
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
 *   no-changes        → the fix produced no diff at all (hard fail)
 *   no-code-change    → only test/config/docs changed (fails closed → human)
 *   tests-missing     → code changed but no test added/modified
 *   tests             → new test failures introduced by the fix
 *   tests-unvalidated → tests could not be run/validated (fails closed → human)
 *   lint              → new lint errors introduced by the fix
 */
export async function validateBranch(worktreeDir, env = process.env) {
  try {
    const changed = collectChangedFiles(worktreeDir);

    // A fix that produced no diff at all is a non-fix — never confirm it (A3).
    if (changed.length === 0) {
      return { passed: false, stage: 'no-changes', error: 'The fix produced no changes.' };
    }

    const { code, tests } = classifyChangedFiles(changed, env);

    // No production code changed (test-only, config-only, or docs-only). The
    // code/test gate can't validate such a change, and a "fix" that touches no
    // production code is suspicious → hand to a human, never auto-confirm (A3).
    if (code.length === 0) {
      return {
        passed: false,
        stage: 'no-code-change',
        unvalidated: true,
        error: `The fix changed no production code (only: ${changed.join(', ')}). Cannot validate automatically.`,
      };
    }

    // Gate: a fix that changes code must add or modify tests.
    if (requireTests(env) && tests.length === 0) {
      return {
        passed: false,
        stage: 'tests-missing',
        error: `Fix changed code (${code.join(', ')}) but added/modified no tests. Set REQUIRE_TESTS=false to disable this gate.`,
      };
    }

    // Gate: related tests must pass (no new failures). A result we couldn't
    // validate (no runner, or crashes on both branches) is surfaced as a
    // distinct 'tests-unvalidated' stage so the caller hands it to a human
    // rather than reworking (rework can't fix an environmental gap) or, worse,
    // calling it confirmed (A1).
    const testResult = runRelatedTests(worktreeDir, code, env);
    if (!testResult.passed) {
      return {
        passed: false,
        stage: testResult.unvalidated ? 'tests-unvalidated' : 'tests',
        unvalidated: !!testResult.unvalidated,
        error: testResult.error,
      };
    }

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

// Hidden marker on the handoff comment so we can detect (and not duplicate) it.
const REVIEW_MARKER = '<!-- orchestrator:needs-human-review -->';

/**
 * Add a "needs-human-review" label and a comment explaining why. `reason`
 * carries the real cause (A4) — the old hardcoded "refinement broke tests"
 * message was wrong for the CI-failed / blocking-review / unvalidated cases.
 *
 * Label and comment are retried separately (D1): the old code wrapped both in
 * one Promise.all, so a transient comment failure re-ran addLabels AND
 * re-posted the comment. addLabels is idempotent; the comment is not, so it's
 * skipped when a prior handoff comment (marker) already exists.
 */
export async function flagForHumanReview(owner, repo, prNumber, reason = 'this fix could not be automatically confirmed') {
  await withRetry(
    () => octokit.issues.addLabels({ owner, repo, issue_number: prNumber, labels: ['needs-human-review'] }),
    `flagForHumanReview.label(#${prNumber})`,
  );

  const existing = await withRetry(
    () => octokit.paginate(octokit.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 }),
    `flagForHumanReview.list(#${prNumber})`,
  );
  if (existing.some(c => c.body?.includes(REVIEW_MARKER))) return;

  await withRetry(
    () => octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `${REVIEW_MARKER}\n⚠️ **Needs human review.** Auto-merge was skipped because ${reason}. Please review before merging.`,
    }),
    `flagForHumanReview.comment(#${prNumber})`,
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

