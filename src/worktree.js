import { execSync, execFileSync } from 'child_process';
import { existsSync, rmSync, copyFileSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import { join, isAbsolute } from 'path';

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

// Git permits ref characters that are unsafe to interpolate into a shell command
// (`;`, `$`, spaces, backticks, …). The base branch IS interpolated into git
// commands across the orchestrator (worktree add, diff, checkout, fetch, rebase)
// and into the workflow's review-diff prompt, so constrain it to a conservative
// subset of valid ref characters: must start alphanumeric, then letters/digits/
// `._/-`, and no `..` (which git disallows in refs anyway). (#3)
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isSafeBranchName(name) {
  return typeof name === 'string' && SAFE_BRANCH_RE.test(name) && !name.includes('..');
}

function assertSafeBranch(name, source) {
  if (!isSafeBranchName(name)) {
    throw new Error(
      `Unsafe base branch name from ${source}: ${JSON.stringify(name)}. ` +
      `Allowed: letters, digits, '.', '_', '/', '-' (not starting with '-' or containing '..').`,
    );
  }
  return name;
}

/**
 * The repo's default/base branch — the branch fixes are cut from, validated
 * against, and merged into (#5). Reads the value index.js resolved once via
 * resolveBaseBranch; falls back to 'main' so nothing hardcodes it. Validated
 * (#3) so an out-of-band BASE_BRANCH can't inject shell syntax at an
 * interpolation site. Pure.
 */
export function baseBranch(env = process.env) {
  return assertSafeBranch(env.BASE_BRANCH || 'main', 'BASE_BRANCH');
}

/**
 * Resolve the target repo's default branch ONCE at startup: BASE_BRANCH wins;
 * else the remote's published default (origin/HEAD) — set by `git clone` or
 * `git remote set-head origin -a`; else 'main'. index.js stores the result in
 * BASE_BRANCH so every later baseBranch() call is a cheap env read, and a repo
 * on master/trunk/etc. is no longer assumed to use 'main'. An explicit but
 * unsafe BASE_BRANCH throws (fail fast at startup); an unsafe *detected* name is
 * ignored in favor of 'main' since detection is best-effort (#3).
 */
export function resolveBaseBranch(repoPath, env = process.env) {
  if (env.BASE_BRANCH) return assertSafeBranch(env.BASE_BRANCH, 'BASE_BRANCH');
  try {
    const ref = execSync('git symbolic-ref --short refs/remotes/origin/HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const name = ref.replace(/^origin\//, '');
    if (name && isSafeBranchName(name)) return name;
    if (name) console.warn(`[INIT] Ignoring unsafe detected default branch ${JSON.stringify(name)}; using 'main'.`);
  } catch {
    // origin/HEAD not set (some clones don't record it) — fall back to 'main'.
  }
  return 'main';
}

/**
 * Env files to copy into a worktree (B2). Defaults to `.env.test` ONLY — never
 * `.env`/`.env.production` — so target-repo production secrets aren't exposed to
 * an autonomous agent (which runs with Bash) or swept into the PR diff. The old
 * code copied .env/.env.local/.env.development/.env.production unconditionally.
 * Override with WORKTREE_ENV_FILES (comma/space separated); empty disables copy.
 */
export function worktreeEnvFiles(env = process.env) {
  if (env.WORKTREE_ENV_FILES === undefined) return ['.env.test'];
  return env.WORKTREE_ENV_FILES.split(/[\s,]+/).filter(Boolean);
}

/**
 * Append paths to the worktree's git exclude so a copied secret can't be swept
 * into the fix commit by `git add -A` (B2). Idempotent and best-effort — exclude
 * is advisory, the real protection is not copying secrets in the first place.
 */
function excludeFromGit(dir, paths) {
  try {
    const rel = execSync('git rev-parse --git-path info/exclude', { cwd: dir, encoding: 'utf-8' }).trim();
    const file = isAbsolute(rel) ? rel : join(dir, rel);
    const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    const have = new Set(existing.split('\n').map(l => l.trim()));
    const additions = paths.filter(p => !have.has(p));
    if (additions.length === 0) return;
    const lead = existing && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${lead}${additions.join('\n')}\n`);
  } catch {
    // No git dir / unwritable exclude — fall back to the not-copying-secrets
    // protection above. Best effort.
  }
}

/**
 * Stage and commit everything in the worktree; returns whether a commit was made
 * (false = nothing to commit). The orchestrator owns the commit (extending ADR
 * 0003): the fix/rework agents are told to commit, but if one forgets, its edits
 * sit uncommitted — and validation read the dirty working tree while review, the
 * PR diff, and the merge see only committed work, so an uncommitted "fix" could
 * pass the gate yet never reach the PR and be discarded at cleanup (finding #2).
 * Committing here keeps all four in sync. `git add -A` honors info/exclude, so a
 * B2-copied secret can't be swept in. A fixed bot identity is supplied via -c so
 * the commit never fails on a repo with no configured git user.
 */
export function commitAll(worktreeDir, message) {
  execSync('git add -A', { cwd: worktreeDir, stdio: 'pipe' });
  // `git diff --cached --quiet` exits non-zero iff something is staged.
  try {
    execSync('git diff --cached --quiet', { cwd: worktreeDir, stdio: 'pipe' });
    return false; // nothing staged → agent already committed, or no edits
  } catch {
    // staged changes exist — commit them below
  }
  execFileSync('git', [
    '-c', 'user.name=Claude Orchestrator',
    '-c', 'user.email=orchestrator@users.noreply.github.com',
    'commit', '-q', '-m', message,
  ], { cwd: worktreeDir, stdio: 'pipe' });
  return true;
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

/** Combined stdout+stderr from a failed execSync error, trimmed and capped. */
function cmdOutput(err) {
  return [err.stdout?.toString(), err.stderr?.toString()]
    .filter(Boolean).join('\n').trim().slice(0, 2000);
}

/**
 * Resolve the bin directory of the Node version the target repo pins
 * (.nvmrc / mise.toml / .tool-versions / engines.node), via mise. Returns null
 * when mise isn't installed or the repo pins nothing.
 *
 * execSync bypasses mise's shell hook, so without this the worktree's
 * pnpm/npx/vitest run under whatever Node is first on PATH. When the repo pins a
 * different major that fails hard at install (ERR_PNPM_UNSUPPORTED_ENGINE) and
 * the whole issue dies at 'worktree-failed'. We resolve from the (trusted) main
 * checkout and prepend the result to PATH so every child process picks it up —
 * no per-worktree `mise trust` needed.
 */
export function resolveRepoNodeBin(repoPath, env = process.env) {
  try {
    const where = execSync('mise where node', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    }).trim();
    if (where) {
      const bin = join(where, 'bin');
      if (existsSync(bin)) return bin;
    }
  } catch {
    // mise absent, or no Node pin for this repo — caller falls back to PATH Node.
  }
  return null;
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

  // Create the worktree with a fresh branch off the base branch (-B force-creates)
  execSync(
    `git worktree add "${dir}" -B ${branch} origin/${baseBranch()}`,
    { cwd: repoPath, stdio: 'pipe' }
  );

  try {
    return setupWorktree(repoPath, dir, branch, issueNumber);
  } catch (err) {
    // A post-creation step (almost always `install`) failed. Tear down the
    // worktree+branch we just created so failed issues don't leak fix/issue-*
    // branches, then rethrow so the dispatcher can log the failure.
    try { removeWorktree(repoPath, dir, branch); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Trust the worktree's mise config (best-effort). The workflow brain runs the
 * mise-shimmed `claude` with cwd set to the worktree; an untrusted mise.toml
 * there makes mise abort before claude starts. Trusting also lets mise activate
 * the repo-pinned toolchain for the agent's own subprocesses. No-op when mise
 * or a config is absent.
 */
function trustMiseConfig(dir) {
  const cfg = ['mise.toml', '.mise.toml', '.tool-versions']
    .map(f => join(dir, f))
    .find(existsSync);
  if (!cfg) return;
  try {
    execSync(`mise trust "${cfg}"`, { stdio: 'pipe' });
  } catch {
    // mise not installed or trust failed — the PATH-prepended Node still covers
    // the orchestrator's own commands; only the shimmed agent is affected.
  }
}

/** Post-creation setup (deps + env files) for a freshly-added worktree. */
function setupWorktree(repoPath, dir, branch, issueNumber) {
  trustMiseConfig(dir);

  // Install deps using the target repo's own package manager (auto-detected,
  // overridable via PACKAGE_MANAGER) instead of assuming pnpm (CRITIQUE #3).
  if (existsSync(join(dir, 'package.json'))) {
    const pm = detectPackageManager(dir);
    console.log(`[WORKTREE] Installing dependencies (${pm}) for issue #${issueNumber}...`);
    try {
      execSync(`${pm} install`, {
        cwd: dir,
        stdio: 'pipe',
        timeout: 180_000,
      });
    } catch (err) {
      // execSync's "Command failed: pnpm install" hides the real cause. Surface
      // the captured output (e.g. ERR_PNPM_UNSUPPORTED_ENGINE) so the run log
      // says why instead of just that it failed.
      const detail = cmdOutput(err);
      throw new Error(`${pm} install failed${detail ? `: ${detail}` : `: ${err.message}`}`, { cause: err });
    }

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

  // Optional post-install setup, run once the worktree has its deps. Needed for
  // monorepos whose tests import workspace packages by their built `dist/`
  // exports: a fresh checkout has no build output, so without this the test gate
  // crashes with "Failed to resolve entry for package …". Repo-specific; e.g.
  // `pnpm turbo build --filter='./packages/@pulsideo/*'`. Default: none.
  const setupCmd = (process.env.WORKTREE_SETUP_CMD || '').trim();
  if (setupCmd) {
    console.log(`[WORKTREE] Running setup for issue #${issueNumber}: ${setupCmd}`);
    try {
      execSync(setupCmd, { cwd: dir, stdio: 'pipe', timeout: 600_000 });
    } catch (err) {
      // Combine both streams: tools like turbo print the failing task's real
      // error to stdout while stderr only carries the banner.
      const detail = cmdOutput(err);
      throw new Error(`worktree setup command failed${detail ? `: ${detail}` : `: ${err.message}`}`, { cause: err });
    }
  }

  // Copy untracked env files the worktree needs to run tests. Default is
  // .env.test only — production secrets are NOT copied into an agent's reach
  // (B2). Copied files are excluded from git so they can't land in the PR diff.
  const copied = [];
  for (const f of worktreeEnvFiles()) {
    const src = join(repoPath, f);
    if (existsSync(src)) {
      copyFileSync(src, join(dir, f));
      copied.push(f);
    }
  }
  if (copied.length) excludeFromGit(dir, copied);

  return { dir, branch };
}

export function removeWorktree(repoPath, dir, branch) {
  // Drop the mise trust entry we added for this worktree so they don't
  // accumulate as the worktree dir is unique per run. Best-effort, before the
  // dir disappears.
  for (const f of ['mise.toml', '.mise.toml', '.tool-versions']) {
    const cfg = join(dir, f);
    if (!existsSync(cfg)) continue;
    try { execSync(`mise trust --untrust "${cfg}"`, { stdio: 'pipe' }); } catch { /* best effort */ }
  }

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
