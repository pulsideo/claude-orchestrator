import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, removeWorktree } from '../src/worktree.js';

// A real (offline) git repo with an `origin/main` so we exercise the actual
// branch/worktree lifecycle the orchestrator uses — no mocks.
let root, repo;

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-wt-'));
  const remote = join(root, 'origin.git');
  repo = join(root, 'repo');

  execSync(`git init --bare "${remote}"`, { stdio: 'pipe' });
  execSync(`git clone "${remote}" "${repo}"`, { stdio: 'pipe' });
  git('config user.email test@test.com', repo);
  git('config user.name test', repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add -A', repo);
  git('commit -m init', repo);
  git('branch -M main', repo);
  git('push -u origin main', repo);
});

after(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

// CRITIQUE #6: removeWorktree takes a `branch` arg but never deletes it, so
// fix/issue-N branches accumulate in the repo after each run.
test('removeWorktree deletes the local fix branch', () => {
  const { dir, branch } = createWorktree(repo, 4242);
  assert.equal(branch, 'fix/issue-4242');

  // Branch exists while the worktree is live.
  assert.ok(git(`branch --list ${branch}`, repo).includes(branch),
    'branch should exist after createWorktree');

  removeWorktree(repo, dir, branch);

  // After cleanup the branch must be gone, not just the worktree.
  assert.equal(git(`branch --list ${branch}`, repo), '',
    'branch should be deleted after removeWorktree');
});
