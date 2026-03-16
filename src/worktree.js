import { execSync } from 'child_process';
import { existsSync, rmSync, copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const WORKTREE_DIR_NAME = '.claude-worktrees';

export function createWorktree(repoPath, issueNumber) {
  const worktreeBase = join(repoPath, '..', WORKTREE_DIR_NAME);
  mkdirSync(worktreeBase, { recursive: true });

  const dir = join(worktreeBase, `agent-${issueNumber}-${Date.now()}`);
  const branch = `fix/issue-${issueNumber}`;

  // Make sure main is up to date
  execSync(`git fetch origin`, { cwd: repoPath, stdio: 'pipe' });

  // Prune any stale worktree references first so branch deletion can succeed
  try {
    execSync(`git worktree prune`, { cwd: repoPath, stdio: 'pipe' });
  } catch {
    // Nothing to prune
  }

  // Clean up stale branch if it exists (local and remote tracking)
  try {
    execSync(`git branch -D ${branch}`, { cwd: repoPath, stdio: 'pipe' });
  } catch {
    // Branch doesn't exist, fine
  }

  // Create the worktree with a fresh branch off origin/main (-B force-creates)
  execSync(
    `git worktree add "${dir}" -B ${branch} origin/main`,
    { cwd: repoPath, stdio: 'pipe' }
  );

  // Install deps
  if (existsSync(join(dir, 'package.json'))) {
    console.log(`[WORKTREE] Installing dependencies for issue #${issueNumber}...`);
    execSync(`pnpm install`, {
      cwd: dir,
      stdio: 'pipe',
      timeout: 180_000,
    });

    // pnpm workspaces skip some devDependencies in worktrees
    // Install test deps explicitly
    console.log(`[WORKTREE] Installing test dependencies for issue #${issueNumber}...`);
    execSync(`pnpm add -D vitest @vitejs/plugin-react @testing-library/jest-dom @testing-library/react @testing-library/user-event jsdom`, {
      cwd: dir,
      stdio: 'pipe',
      timeout: 120_000,
    });
  }

  // Copy env files that aren't tracked by git
  const envFiles = ['.env', '.env.local', '.env.test', '.env.development', '.env.production'];
  for (const f of envFiles) {
    const src = join(repoPath, f);
    if (existsSync(src)) {
      copyFileSync(src, join(dir, f));
    }
  }

  return { dir, branch };
}

export function removeWorktree(repoPath, dir, branch) {
  try {
    execSync(`git worktree remove "${dir}" --force`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch {
    // Force cleanup if git worktree remove fails
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    try {
      execSync(`git worktree prune`, { cwd: repoPath, stdio: 'pipe' });
    } catch {
      // Best effort
    }
  }
}

export function cleanupAllWorktrees(repoPath) {
  try {
    const output = execSync(`git worktree list --porcelain`, {
      cwd: repoPath,
      encoding: 'utf-8',
    });

    const worktrees = output
      .split('\n\n')
      .filter(block => block.includes(`${WORKTREE_DIR_NAME}/agent-`))
      .map(block => {
        const match = block.match(/^worktree (.+)$/m);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    for (const dir of worktrees) {
      console.log(`[CLEANUP] Removing stale worktree: ${dir}`);
      try {
        execSync(`git worktree remove "${dir}" --force`, {
          cwd: repoPath,
          stdio: 'pipe',
        });
      } catch {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    execSync(`git worktree prune`, { cwd: repoPath, stdio: 'pipe' });
    console.log(`[CLEANUP] Done. Removed ${worktrees.length} worktrees.`);
  } catch (err) {
    console.warn(`[CLEANUP] Warning: ${err.message}`);
  }
}
