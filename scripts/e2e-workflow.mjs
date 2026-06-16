#!/usr/bin/env node
/**
 * End-to-end A/B harness for the per-issue brain.
 *
 * Lives in scripts/ (NOT test/) on purpose: `node --test` auto-discovers and
 * RUNS anything under a test/ directory, and this harness spawns the real
 * `claude` CLI (needs auth) and spends real money (~$1-2 per variant). Run it
 * manually as the rollout's A/B gate (ADR 0007):
 *
 *   npm run e2e                # run both the workflow brain and the legacy brain
 *   npm run e2e -- --workflow  # workflow brain only
 *   npm run e2e -- --legacy    # hand-rolled triage+fix brain only
 *   npm run e2e -- --keep      # leave the sandbox on disk for inspection
 *   npm run e2e -- --budget 2  # per-issue --max-budget-usd (default 3)
 *
 * It builds a real vitest target repo whose bug has NO test yet, so the
 * test-first fix prompt naturally satisfies the tests-present gate. It then
 * drives the actual orchestrator code: createWorktree → brain → the
 * authoritative validateBranch → an independent `vitest run`.
 */
import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createWorktree, removeWorktree } from '../src/worktree.js';
import { validateBranch } from '../src/github.js';
import { runFixWorkflow } from '../src/workflow.js';
import { runTriageAgent, runFixAgent } from '../src/agent.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const RUN_WORKFLOW = !flag('--legacy') || flag('--workflow');
const RUN_LEGACY = !flag('--workflow') || flag('--legacy');
const KEEP = flag('--keep');
const BUDGET = parseFloat(opt('--budget', '3'));

const ISSUE = {
  title: 'add() returns the difference instead of the sum',
  body: 'In `src/math.js`, `add(a, b)` returns `a - b`. It should return `a + b`. '
    + 'There is no test for it yet — add a test proving `add(2, 3) === 5`.',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

function preflight() {
  try {
    execFileSync('which', ['claude'], { stdio: 'pipe' });
  } catch {
    console.error('✗ `claude` CLI not found on PATH. This harness needs it (and auth). Aborting.');
    process.exit(2);
  }
}

/** Build a bare origin + working clone with a buggy, test-less vitest project. */
function setupSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'orch-e2e-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  sh(`git init -q --bare "${origin}"`);
  sh(`git clone -q "${origin}" "${repo}"`);
  sh('git config user.email e2e@test.local', repo);
  sh('git config user.name e2e', repo);

  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'math.js'),
    'export function add(a, b) {\n  return a - b; // BUG: should be a + b\n}\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'e2e-sandbox', version: '1.0.0', private: true, type: 'module',
    scripts: { test: 'vitest run' },
    devDependencies: { vitest: '^2.1.0' },
  }, null, 2) + '\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');

  // Generate a lockfile so package-manager detection is deterministic (npm) and
  // the worktree install is cache-warm; commit manifest + lockfile only.
  console.log('[setup] npm install (seeding lockfile + cache)...');
  sh('npm install --silent --no-audit --no-fund', repo);
  sh('git add package.json package-lock.json .gitignore src', repo);
  sh('git commit -q -m "init: math.add bug, no test yet"', repo);
  sh('git branch -M main', repo);
  sh('git push -q origin main', repo);
  return { root, repo };
}

function vitestPasses(dir) {
  try {
    execSync('npx vitest run', { cwd: dir, stdio: 'pipe', timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

async function runVariant(label, repo, issueNumber, runBrain) {
  console.log(`\n=== variant: ${label} (issue #${issueNumber}) ===`);
  const issue = { ...ISSUE, number: issueNumber };
  const worktree = createWorktree(repo, issueNumber);
  const started = Date.now();
  let brain;
  try {
    brain = await runBrain(issue, worktree);
    // Orchestrator-owned PR creation is skipped here (no GitHub); the brain has
    // already committed + pushed to the bare origin. We go straight to the
    // authoritative gate, exactly as the dispatcher does after the brain runs.
    const validation = await validateBranch(worktree.dir);
    const testPasses = vitestPasses(worktree.dir);
    const filesChanged = sh('git --no-pager diff --name-only origin/main...HEAD', worktree.dir)
      .split('\n').map(s => s.trim()).filter(Boolean);
    return {
      label,
      confirmed: brain.confirmed,
      cost: brain.cost,
      iterations: brain.iterations ?? '-',
      validationPassed: validation.passed,
      validationStage: validation.passed ? '-' : validation.stage,
      testPasses,
      filesChanged,
      durationMs: Date.now() - started,
    };
  } finally {
    if (!KEEP) removeWorktree(repo, worktree.dir, worktree.branch);
  }
}

// The new code path under test.
const workflowBrain = (issue, worktree) =>
  runFixWorkflow(issue, worktree, { severity: 'critical', budgetUsd: BUDGET });

// The comparable hand-rolled brain steps (triage + test-first fix). No review
// loop here — this is a cost/outcome A/B reference, not the full legacy pipeline.
const legacyBrain = async (issue, worktree) => {
  const triage = await runTriageAgent(issue, worktree.dir).catch(() => ({ analysis: '', cost: 0 }));
  const fix = await runFixAgent(issue, triage.analysis, worktree.dir);
  try { execSync(`git push origin ${worktree.branch}`, { cwd: worktree.dir, stdio: 'pipe' }); } catch { /* bare origin */ }
  // No adversarial review here; confirmed is decided by the authoritative gate.
  return { confirmed: undefined, cost: (triage.cost || 0) + (fix.cost || 0), iterations: '-' };
};

function report(rows) {
  console.log(`\n${'='.repeat(72)}\nA/B RESULTS\n${'='.repeat(72)}`);
  for (const r of rows) {
    console.log(`\n[${r.label}]`);
    console.log(`  brain confirmed : ${r.confirmed === undefined ? 'n/a (no review loop)' : r.confirmed}`);
    console.log(`  authoritative validate: ${r.validationPassed ? 'PASS' : `FAIL @ ${r.validationStage}`}`);
    console.log(`  vitest run      : ${r.testPasses ? 'PASS' : 'FAIL'}`);
    console.log(`  files changed   : ${r.filesChanged.join(', ') || '(none)'}`);
    console.log(`  cost            : $${(r.cost || 0).toFixed(4)}`);
    console.log(`  iterations      : ${r.iterations}`);
    console.log(`  wall time       : ${(r.durationMs / 1000).toFixed(1)}s`);
  }
  // Success = the gate passed AND the test passes for every variant we ran.
  const ok = rows.every(r => r.validationPassed && r.testPasses);
  console.log(`\n${'='.repeat(72)}\nOVERALL: ${ok ? 'PASS' : 'FAIL'}\n${'='.repeat(72)}`);
  return ok;
}

async function main() {
  preflight();
  const { root, repo } = setupSandbox();
  const rows = [];
  let n = 1001;
  try {
    if (RUN_WORKFLOW) rows.push(await runVariant('workflow', repo, n++, workflowBrain));
    if (RUN_LEGACY) rows.push(await runVariant('legacy', repo, n++, legacyBrain));
  } finally {
    if (KEEP) {
      console.log(`\n[keep] sandbox left at ${root}`);
    } else {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const ok = report(rows);
  process.exit(ok ? 0 : 1);
}

// Only run when invoked directly (`node scripts/e2e-workflow.mjs`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('E2E harness error:', err?.error || err?.message || err);
    process.exit(1);
  });
}
