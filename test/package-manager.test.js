import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager, addDevCommand, lockfileFor, worktreeEnvFiles } from '../src/worktree.js';

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

// B2: never copy production secrets into an agent worktree by default.
test('worktreeEnvFiles: defaults to .env.test only, overridable, disablable', () => {
  assert.deepEqual(worktreeEnvFiles({}), ['.env.test']);
  assert.deepEqual(worktreeEnvFiles({ WORKTREE_ENV_FILES: '.env .env.local' }), ['.env', '.env.local']);
  assert.deepEqual(worktreeEnvFiles({ WORKTREE_ENV_FILES: '.env,.env.test' }), ['.env', '.env.test']);
  assert.deepEqual(worktreeEnvFiles({ WORKTREE_ENV_FILES: '' }), []); // explicit empty disables copy
});
