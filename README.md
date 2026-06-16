# Claude Issue Orchestrator

Automatically fixes GitHub issues using Claude Code agents, prioritized from highest to lowest severity.

## How It Works

0. **(Optional) Discovery** — when `DISCOVERY=true`, a scan agent reads the target repo within `DISCOVERY_SCOPE`, dedups against open issues, and files up to `DISCOVERY_MAX` new issues (agent-assigned severity), which then flow through the steps below in the same run
1. Fetches open issues from your GitHub repo that have severity labels (`critical`, `high`, `medium`, `low`, or `bug`), paginating through all of them
2. Sorts them by severity (critical first)
3. For each issue, creates an isolated git worktree on a `fix/issue-{number}` branch
4. Runs a **triage agent** (fast tier) to analyze the root cause
5. Runs a **fix agent** (strong tier for critical/high, fast for medium/low) to implement the fix, commit and push; the **orchestrator** then opens the PR
6. Runs an **iterative fix→review loop** (up to `MAX_ITERATIONS`): validate ordered gates — **changed something** → **production code changed** → **tests present** (a code change must add/modify a test, unless `REQUIRE_TESTS=false`) → **related tests pass** → **lint passes** — then **review** (Greptile or the reviewer provider). On any failing gate or blocking finding it reworks the fix and repeats; the fix is *confirmed* when gates pass and review has no blocking findings. The test gate is runner-aware (vitest/jest related-tests, else the repo's `test` script; `TEST_COMMAND` overrides) and **fails closed**: a fix it can't validate — no production code changed, a reviewer that errored, or tests that won't run on a clean main — is handed to a human, never confirmed
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
| `COST_CEILING_USD` | Stop processing after this spend **for the current run**, including the discovery phase (default: 50) |
| `MAX_ITERATIONS` | Fix→review loop cap before leaving the PR for a human (default: 3) |
| `DISCOVERY` | Set `true` to scan the repo and file new issues before processing (default off) |
| `DISCOVERY_SCOPE` / `DISCOVERY_MAX` | Free-text discovery scope, and max new issues filed per run (default 5) |
| `AUTO_MERGE` | Squash-merge confirmed PRs and delete the branch (default: `false` — leave for human review) |
| `USE_WORKFLOW` | Run the per-issue brain as a Claude dynamic workflow (triage→fix→adversarial-review convergence) instead of the hand-rolled loop. Claude fix-provider only; Codex/Kimi unaffected (default: `false`, see ADR 0007) |
| `PER_ISSUE_BUDGET_USD` | USD budget per issue. Reserved before the issue starts (caps concurrent overspend); the workflow path enforces it as a hard `--max-budget-usd`, and the hand-rolled loop stops once cumulative spend reaches it (`over-budget` → human review). Default: `COST_CEILING_USD` ÷ effective concurrency |
| `PER_ISSUE_TOKEN_BUDGET` | Optional in-workflow token backstop on the convergence loop |
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
| `WORKTREE_ENV_FILES` | Optional. Comma/space-separated env files copied from the target repo into each worktree (default: `.env.test` only — production secrets are never copied; set empty to disable). Copied files are git-excluded so they can't land in the PR diff |
| `REQUIRE_TESTS` | Reject a fix that changes code but adds/modifies no test (default: `true`) |
| `TEST_COMMAND` | Optional. Override the test-gate command; otherwise vitest/jest get scoped related-tests, else the repo's `test` script runs. If no runner can be determined the gate fails closed (the fix is handed to a human, never silently passed) |
| `NO_CODE_CHANGE_ACTION` | What to do when a fix changes no production code: `human-review` (default — hand off immediately) or `rework` (nudge the agent to make a real change first, then hand off if it still doesn't) |
| `LINT_COMMAND` | Optional. Override the lint command; otherwise the target repo's `lint` script is used if present |
| `CODE_FILE_EXTENSIONS` | Optional. Comma/space-separated extensions counted as code when classifying a fix's changes (default: `ts,tsx,js,jsx,cjs,mjs`). Widen for non-JS/TS repos, e.g. `py` or `go,rs`, so a real fix isn't mislabeled `no-code-change` |
| `WAIT_FOR_CI` | Wait for the PR's GitHub CI checks to go green before merging (default: `false`) |
| `CI_TIMEOUT_MS` / `CI_POLL_INTERVAL_MS` | Tune CI polling (defaults: `600000` / `15000`) |

#### Language support

The orchestrator is **JavaScript/TypeScript-first**: the worktree install, the
runner-aware test gate (vitest/jest related-tests, else the repo's `test`
script), and the lint gate assume a Node toolchain. Other stacks (Python, Go,
Rust, …) are supported on a best-effort basis by configuring the gates rather
than through built-in language adapters:

- `CODE_FILE_EXTENSIONS` — so the fix's changes are recognized as code (not
  `no-code-change`) and its tests are classified correctly.
- `TEST_COMMAND` — the command the test gate runs (it can't auto-detect a
  non-Node runner; without it the gate fails closed to human review).
- `LINT_COMMAND` — the lint command, if you want a lint gate.
- `PACKAGE_MANAGER` — only relevant for Node repos.

With those set, a fix in another language flows through validation and review;
without them, such a fix is handed to a human rather than silently passed.

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

Terminal statuses per issue: `merged`, `success` (PR open, pending human review), `no-pr` (fix pushed but no PR found), `needs-human-review` (couldn't be confirmed — blocking review findings, a reviewer that errored, tests that couldn't be validated, or a fix that changed no production code), `over-budget` (per-issue budget exhausted before confirmation), `no-changes` (fix produced no diff), `tests-missing` (fix changed code but added no test), `lint-failed`, `ci-failed`, `fix-tests-failed`, `fix-failed`, `worktree-failed`.

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
workflow.js       → Claude-only "workflow brain": invokes the saved fix-issue dynamic workflow
                    headlessly, parses its structured result + real total_cost_usd (ADR 0007)
providers.js      → Provider adapter registry (Claude/Codex/Kimi), role→model resolution, token-based cost
discovery.js      → Optional scan → dedup → file new issues (ADR 0001)
menu.js           → Interactive startup settings menu, auto-skipped when headless (ADR 0004)
greptile.js       → Optional Greptile code review of the branch diff
dispatcher.js     → Per-issue pipeline (brain → validate → merge-or-handoff), concurrent work
                    queue with per-issue budget reservation, per-run cost ceiling, status resolution
logger.js         → Per-run cost tracking + reservation + persisted run-log.json history
.claude/workflows/fix-issue.js → The dynamic workflow brain (triage → fix → adversarial-review
                    convergence), run when USE_WORKFLOW=true on the Claude path
```

The per-issue flow in `dispatcher.js`: triage → fix → orchestrator opens the PR →
**iterative loop (up to `MAX_ITERATIONS`)**: validate (tests-present → tests-pass
→ lint) → review (Greptile or the reviewer provider) → rework on any failing gate
or blocking finding → repeat until confirmed → (optional) wait for CI → auto-merge
if `AUTO_MERGE=true` (else leave the open PR for a human) → resolve terminal status.

**Workflow brain (`USE_WORKFLOW=true`, Claude fix-provider only).** Instead of the
hand-rolled loop, the brain runs as a single Claude dynamic workflow
(`.claude/workflows/fix-issue.js`): triage → fix → a convergence loop with
**adversarial review** (independent correctness/security/edge-case lenses, each
returning a structured verdict — a fix is confirmed only when none find a blocking
defect, so review fails *closed*). The workflow's `confirmed` is advisory; the
harness still runs `validateBranch` authoritatively before merging, and CI/merge/
handoff are unchanged. Codex/Kimi always use the hand-rolled loop. See ADR 0007.

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

**Claude auth & fallback.** The orchestrator runs the `claude` CLI, which uses
your logged-in **subscription** unless `ANTHROPIC_API_KEY` is set (which switches
it to metered API billing). If a key is set and its credit runs out (the CLI
returns `400 "credit balance is too low"`), the run **drops the key and retries
on your subscription**, latching for the rest of the run so it doesn't keep
hitting the dead key — see `docs/adr/0008-api-key-subscription-fallback.md`. This
requires the CLI to be logged into a subscription; disable with
`FALLBACK_TO_SUBSCRIPTION=false`. There is no way to read a remaining API credit
balance ahead of time — Anthropic exposes no such endpoint — so exhaustion is
detected reactively from that error.

## Tuning

- Start with `MAX_CONCURRENCY=2` and watch for rate limit errors (429s)
- Bump to 3-5 if you're not hitting limits on Max 20x
- Increase timeouts in `agent.js` if your codebase is large (agents need time to read files)
- Adjust `COST_CEILING_USD` based on your issue volume
