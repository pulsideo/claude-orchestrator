import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager, addDevCommand, lockfileFor, worktreeEnvFiles, baseBranch, resolveBaseBranch, isSafeBranchName } from '../src/worktree.js';

function dirWith(lockfile) {
  const d = mkdtempSync(join(tmpdir(), 'orch-pm-'));
  if (lockfile) writeFileSync(join(d, lockfile), '');
  return d;
}

// CRITIQUE #3: detect the target repo's package manager instead of assuming pnpm.
test('detects package manager from the lockfile', () => {
  for (const [lockfile, expected] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ]) {
    const d = dirWith(lockfile);
    try { assert.equal(detectPackageManager(d, {}), expected); }
    finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('defaults to npm when no lockfile present', () => {
  const d = dirWith(null);
  try { assert.equal(detectPackageManager(d, {}), 'npm'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('PACKAGE_MANAGER env overrides lockfile detection', () => {
  const d = dirWith('pnpm-lock.yaml');
  try { assert.equal(detectPackageManager(d, { PACKAGE_MANAGER: 'yarn' }), 'yarn'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('addDevCommand builds the right dev-install per manager', () => {
  assert.equal(addDevCommand('npm', 'vitest'), 'npm install -D vitest');
  assert.equal(addDevCommand('pnpm', 'vitest'), 'pnpm add -D vitest');
  assert.equal(addDevCommand('yarn', 'vitest'), 'yarn add -D vitest');
  assert.equal(addDevCommand('bun', 'vitest'), 'bun add -d vitest');
});

test('lockfileFor maps manager back to its lockfile for restore', () => {
  assert.equal(lockfileFor('pnpm'), 'pnpm-lock.yaml');
  assert.equal(lockfileFor('npm'), 'package-lock.json');
});

// #5: the base branch is read live from env, defaulting to 'main' so nothing
// hardcodes it.
test('baseBranch: env override wins, else defaults to main', () => {
  assert.equal(baseBranch({}), 'main');
  assert.equal(baseBranch({ BASE_BRANCH: 'master' }), 'master');
  assert.equal(baseBranch({ BASE_BRANCH: 'trunk' }), 'trunk');
});

// resolveBaseBranch: explicit env wins without touching git; a non-repo path
// can't detect origin/HEAD and falls back to 'main'. (origin/HEAD detection is
// covered against a real clone in worktree.integration.test.js.)
test('resolveBaseBranch: env override wins; falls back to main off a repo', () => {
  assert.equal(resolveBaseBranch('/nonexistent/path', { BASE_BRANCH: 'develop' }), 'develop');
  const d = dirWith(null); // a plain dir, not a git repo
  try { assert.equal(resolveBaseBranch(d, {}), 'main'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// #3: the base branch is interpolated into git commands, so it must be a safe
// ref name — no shell metacharacters.
test('isSafeBranchName accepts normal refs, rejects shell-unsafe ones', () => {
  for (const ok of ['main', 'master', 'trunk', 'release/1.2', 'feature_x', 'v2.0-rc']) {
    assert.ok(isSafeBranchName(ok), `${ok} should be safe`);
  }
  for (const bad of ['main; rm -rf /', 'a b', '$(whoami)', '`id`', '-x', 'a..b', '', 'foo|bar', 42]) {
    assert.ok(!isSafeBranchName(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});

test('baseBranch / resolveBaseBranch reject an unsafe explicit BASE_BRANCH', () => {
  assert.throws(() => baseBranch({ BASE_BRANCH: 'main; echo pwned' }), /Unsafe base branch/);
  assert.throws(() => resolveBaseBranch('/nonexistent', { BASE_BRANCH: '$(id)' }), /Unsafe base branch/);
});

// B2: never copy production secrets into an agent worktree by default.
test('worktreeEnvFiles: defaults to .env.test only, overridable, disablable', () => {
  assert.deepEqual(worktreeEnvFiles({}), ['.env.test']);
  assert.deepEqual(worktreeEnvFiles({ WORKTREE_ENV_FILES: '.env .env.local' }), ['.env', '.env.local']);
  assert.deepEqual(worktreeEnvFiles({ WORKTREE_ENV_FILES: '.env,.env.test' }), ['.env', '.env.test']);
  assert.deepEqual(worktreeEnvFiles({ WORKTREE_ENV_FILES: '' }), []); // explicit empty disables copy
});
