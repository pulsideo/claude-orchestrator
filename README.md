# Claude Issue Orchestrator

Automatically fixes GitHub issues using Claude Code agents, prioritized from highest to lowest severity.

## How It Works

0. **(Optional) Discovery** — when `DISCOVERY=true`, a scan agent reads the target repo within `DISCOVERY_SCOPE`, dedups against open issues, and files up to `DISCOVERY_MAX` new issues (agent-assigned severity), which then flow through the steps below in the same run
1. Fetches open issues from your GitHub repo that have severity labels (`critical`, `high`, `medium`, `low`, or `bug`), paginating through all of them
2. Sorts them by severity (critical first)
3. For each issue, creates an isolated git worktree on a `fix/issue-{number}` branch
4. Runs a **triage agent** (fast tier) to analyze the root cause
5. Runs a **fix agent** (strong tier for critical/high, fast for medium/low) to implement the fix, commit and push; the **orchestrator** then opens the PR
6. Runs an **iterative fix→review loop** (up to `MAX_ITERATIONS`): validate ordered gates — **tests present** (a code change must add/modify a test, unless `REQUIRE_TESTS=false`) → **related tests pass** → **lint passes** — then **review** (Greptile or the reviewer provider). On any failing gate or blocking finding it reworks the fix and repeats; the fix is *confirmed* when gates pass and review has no blocking findings
7. Optionally waits for **CI** to go green on the PR (`WAIT_FOR_CI=true`); unconfirmed fixes at the cap leave the PR flagged `needs-human-review`
8. By default **leaves the open PR for a human to merge** (`AUTO_MERGE=false`). Set `AUTO_MERGE=true` to squash-merge confirmed PRs automatically and delete the branch
9. Verifies a PR actually exists; a pushed fix with no PR is reported as `no-pr`, never `success`

The worktree and its `fix/issue-{number}` branch are cleaned up after each issue.

## Prerequisites

- **Node.js 18+**
- **Claude Code CLI** installed and authenticated (`claude` command available in your PATH)
- **Claude Max plan** (20x recommended for concurrent agents)
- **GitHub personal access token** with repo scope
- A **local git clone** of your target repository

## Setup

```bash
# Clone this orchestrator
git clone <this-repo> claude-issue-orchestrator
cd claude-issue-orchestrator

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your values
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub PAT with repo scope |
| `GITHUB_OWNER` | Repository owner (username or org) |
| `GITHUB_REPO` | Repository name |
| `REPO_LOCAL_PATH` | Absolute path to your local clone |
| `MAX_CONCURRENCY` | Parallel agents (default: 3, max recommended: 5) |
| `COST_CEILING_USD` | Stop processing after this spend **for the current run** (default: 50) |
| `MAX_ITERATIONS` | Fix→review loop cap before leaving the PR for a human (default: 3) |
| `DISCOVERY` | Set `true` to scan the repo and file new issues before processing (default off) |
| `DISCOVERY_SCOPE` / `DISCOVERY_MAX` | Free-text discovery scope, and max new issues filed per run (default 5) |
| `AUTO_MERGE` | Squash-merge confirmed PRs and delete the branch (default: `false` — leave for human review) |
| `DEFAULT_PROVIDER` | Provider for triage/refine/discovery (`claude`/`codex`/`kimi`, default `claude`) |
| `FIX_PROVIDER` / `REVIEW_PROVIDER` | Override the provider for the fix and reviewer roles |
| `*_MODEL_STRONG` / `*_MODEL_FAST` | Override a provider's tier models (e.g. `CLAUDE_MODEL_STRONG`) |
| `FIX_MODEL` / `REVIEW_MODEL` | Pin an exact model for the fix / reviewer role |
| `MOONSHOT_API_KEY` / `KIMI_BASE_URL` | Kimi auth + endpoint (Kimi runs via the Claude CLI) |
| `MODEL_PRICES` | Optional JSON override merged onto `prices.json` (USD per 1M tokens) |
| `ENABLE_REVIEW` | Set `false` to skip code review entirely (default on) |
| `GREPTILE_API_KEY` | Optional. Use Greptile as the reviewer instead of the review agent |
| `PACKAGE_MANAGER` | Optional. Override worktree package-manager detection (`npm`/`pnpm`/`yarn`/`bun`). Auto-detected from the lockfile otherwise |
| `EXTRA_TEST_DEPS` | Optional. Space-separated dev deps to install in the worktree; the manifest/lockfile are restored afterward so they never pollute the PR diff |
| `REQUIRE_TESTS` | Reject a fix that changes code but adds/modifies no test (default: `true`) |
| `LINT_COMMAND` | Optional. Override the lint command; otherwise the target repo's `lint` script is used if present |
| `WAIT_FOR_CI` | Wait for the PR's GitHub CI checks to go green before merging (default: `false`) |
| `CI_TIMEOUT_MS` / `CI_POLL_INTERVAL_MS` | Tune CI polling (defaults: `600000` / `15000`) |

### Issue Labels

The orchestrator looks for issues with these labels:
- `critical` — processed first, uses Opus
- `high` — processed second, uses Opus
- `medium` — processed third, uses Sonnet
- `low` — processed last, uses Sonnet
- `bug` — included but sorted after labeled severity issues

## Usage

```bash
# Dry run: shows which issues would be processed and in what order
npm run dry-run

# Full run: processes issues with Claude agents
npm start
```

On a terminal, `npm start` opens an **interactive settings menu** (pre-filled
from `.env`) to set providers, auto-merge, loop iterations, discovery, concurrency,
and the cost ceiling, and to check provider readiness. Headless runs (no TTY,
`--no-menu`, `NON_INTERACTIVE=true`, or dry-run) skip the menu and use `.env`.

## Output

- Console logs show real-time progress for each issue
- `run-log.json` accumulates every issue across all runs (cost, duration, status, output snippet) plus a `lifetimeCost`; the cost ceiling is checked against the **current run's** spend, not the lifetime total
- Fix branches are pushed as `fix/issue-{number}` to your repo

Terminal statuses per issue: `merged`, `success` (PR open, pending human review), `no-pr` (fix pushed but no PR found), `needs-human-review` (refinement reverted), `tests-missing` (fix changed code but added no test), `lint-failed`, `ci-failed`, `fix-tests-failed`, `fix-failed`, `worktree-failed`.

## Customizing Prompts

Edit the templates in `prompts/`:

- `triage.md` — controls how the analysis agent investigates bugs
- `fix-critical.md` — instructions for high-severity fixes (test-first approach)
- `fix-standard.md` — instructions for lower-severity fixes
- `refine.md` — instructions for the refinement agent that addresses Greptile review feedback

Templates use `{{variable}}` placeholders that get filled at runtime.

## Testing & Linting

The orchestrator has its own test suite (zero-dependency `node:test`) and ESLint:

```bash
npm test        # run the test suite
npm run lint    # ESLint (no-unused-vars catches dead params/imports)
npm run lint:fix
```

Tests cover cost parsing, per-run cost scoping, severity ordering, PR-status
resolution, validation gates (tests-present/lint/CI summarizing), package-manager
detection, and the worktree/branch lifecycle.

Both run in CI (`.github/workflows/ci.yml`) on every push to `main` and every
pull request: `npm ci` → `npm run lint` → `npm test`.

## Architecture

```
index.js          → Entry point, validates config, kicks off the queue, prints summary
github.js         → Fetches/paginates issues, sorts by severity, validates branch tests,
                    finds/merges/flags PRs, deletes merged branches
worktree.js       → Creates/removes isolated git worktrees + branches; detects package manager
agent.js          → Runs agents (triage / fix / refinement / review) on the resolved provider
providers.js      → Provider adapter registry (Claude/Codex/Kimi), role→model resolution, token-based cost
discovery.js      → Optional scan → dedup → file new issues (ADR 0001)
menu.js           → Interactive startup settings menu, auto-skipped when headless (ADR 0004)
greptile.js       → Optional Greptile code review of the branch diff
dispatcher.js     → Per-issue pipeline (triage → fix → validate → review/refine → merge-or-handoff),
                    concurrent work queue, per-run cost ceiling, terminal status resolution
logger.js         → Per-run cost tracking + persisted run-log.json history
```

The per-issue flow in `dispatcher.js`: triage → fix → orchestrator opens the PR →
**iterative loop (up to `MAX_ITERATIONS`)**: validate (tests-present → tests-pass
→ lint) → review (Greptile or the reviewer provider) → rework on any failing gate
or blocking finding → repeat until confirmed → (optional) wait for CI → auto-merge
if `AUTO_MERGE=true` (else leave the open PR for a human) → resolve terminal status.

Each agent runs in its own git worktree, so concurrent agents never interfere
with each other's file changes. Worktrees are cleaned up after each agent
finishes (or crashes).

## Providers

Agents are provider-agnostic. A registry of adapters drives **Claude** (`claude -p`),
**Codex** (`codex exec`), and **Kimi** (run through the Claude CLI against
Moonshot's Anthropic-compatible endpoint). Provider is chosen per role:

- `DEFAULT_PROVIDER` — triage, refinement, discovery
- `FIX_PROVIDER` — the fix agent
- `REVIEW_PROVIDER` — the reviewer

So you can, e.g., fix with Claude and review with Codex or Kimi. Within a
provider, issue severity selects a **strong** (critical/high) or **fast**
(medium/low) model tier; both have defaults you can override.

Cost is uniform across providers: adapters report **token usage**, which is
priced via `prices.json` (USD per 1M tokens, override with `MODEL_PRICES`). The
cost ceiling is checked against this estimate. Model IDs and prices for
Codex/Kimi are best-effort defaults — verify them against your accounts. See
`docs/adr/0006-provider-agnostic-adapters.md`.

## Tuning

- Start with `MAX_CONCURRENCY=2` and watch for rate limit errors (429s)
- Bump to 3-5 if you're not hitting limits on Max 20x
- Increase timeouts in `agent.js` if your codebase is large (agents need time to read files)
- Adjust `COST_CEILING_USD` based on your issue volume
