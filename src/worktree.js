import { execSync } from 'child_process';
import { existsSync, rmSync, copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const WORKTREE_DIR_NAME = '.claude-worktrees';

// Lockfile → package manager, used to auto-detect the target repo's toolchain
// instead of assuming pnpm (CRITIQUE #3).
const LOCKFILES = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
};

/**
 * Detect the package manager for a checkout. `PACKAGE_MANAGER` overrides
 * detection; otherwise the lockfile decides; otherwise npm.
 */
export function detectPackageManager(dir, env = process.env) {
  if (env.PACKAGE_MANAGER) return env.PACKAGE_MANAGER;
  for (const [lockfile, pm] of Object.entries(LOCKFILES)) {
    if (existsSync(join(dir, lockfile))) return pm;
  }
  return 'npm';
}

/** The dev-dependency add command for a given package manager. */
export function addDevCommand(pm, deps) {
  if (pm === 'pnpm') return `pnpm add -D ${deps}`;
  if (pm === 'yarn') return `yarn add -D ${deps}`;
  if (pm === 'bun') return `bun add -d ${deps}`;
  return `npm install -D ${deps}`;
}

/** The tracked lockfile name for a given package manager (for restore). */
export function lockfileFor(pm) {
  return Object.keys(LOCKFILES).find(f => LOCKFILES[f] === pm) || '';
}

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

  // Install deps using the target repo's own package manager (auto-detected,
  // overridable via PACKAGE_MANAGER) instead of assuming pnpm (CRITIQUE #3).
  if (existsSync(join(dir, 'package.json'))) {
    const pm = detectPackageManager(dir);
    console.log(`[WORKTREE] Installing dependencies (${pm}) for issue #${issueNumber}...`);
    execSync(`${pm} install`, {
      cwd: dir,
      stdio: 'pipe',
      timeout: 180_000,
    });

    // Optionally install extra test deps the worktree needs but the manifest
    // lacks. Restore the tracked manifest/lockfile afterward so these installs
    // never pollute the fix's PR diff (CRITIQUE #3). Default: none.
    const extraDeps = (process.env.EXTRA_TEST_DEPS || '').trim();
    if (extraDeps) {
      console.log(`[WORKTREE] Installing extra test deps for issue #${issueNumber}: ${extraDeps}`);
      execSync(addDevCommand(pm, extraDeps), {
        cwd: dir,
        stdio: 'pipe',
        timeout: 120_000,
      });
      const lockfile = lockfileFor(pm);
      const restore = ['package.json', lockfile].filter(Boolean).join(' ');
      try {
        execSync(`git checkout -- ${restore}`, { cwd: dir, stdio: 'pipe' });
      } catch {
        // Nothing tracked to restore (e.g. lockfile was untracked) — fine.
      }
    }
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

  // Delete the local fix branch so fix/issue-N branches don't accumulate after
  // each run (CRITIQUE #6). Prune first so git no longer considers the branch
  // checked out by the (now-removed) worktree; -D because the branch carries
  // fix commits not on main.
  if (branch) {
    try {
      execSync(`git worktree prune`, { cwd: repoPath, stdio: 'pipe' });
      execSync(`git branch -D ${branch}`, { cwd: repoPath, stdio: 'pipe' });
    } catch {
      // Branch already gone or never created — fine.
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
