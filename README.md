# Claude Issue Orchestrator

Automatically fixes GitHub issues using Claude Code agents, prioritized from highest to lowest severity.

## How It Works

1. Fetches open issues from your GitHub repo that have severity labels (`critical`, `high`, `medium`, `low`, or `bug`)
2. Sorts them by severity (critical first)
3. For each issue, creates an isolated git worktree
4. Runs a **triage agent** (Sonnet) to analyze the root cause
5. Runs a **fix agent** (Opus for critical/high, Sonnet for medium/low) to implement the fix
6. Validates by running your test suite
7. Pushes the branch (you create the PRs, or extend the prompts to do it)

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
| `COST_CEILING_USD` | Stop processing after this spend (default: 50) |

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

## Output

- Console logs show real-time progress for each issue
- `run-log.json` tracks every run with cost, duration, status, and output snippets
- Fix branches are pushed as `fix/issue-{number}` to your repo

## Customizing Prompts

Edit the templates in `prompts/`:

- `triage.md` — controls how the analysis agent investigates bugs
- `fix-critical.md` — instructions for high-severity fixes (test-first approach)
- `fix-standard.md` — instructions for lower-severity fixes

Templates use `{{variable}}` placeholders that get filled at runtime.

## Architecture

```
index.js          → Entry point, validates config, kicks off the queue
github.js         → Fetches issues from GitHub API, sorts by severity
worktree.js       → Creates/removes isolated git worktrees per agent
agent.js          → Spawns Claude Code CLI subprocesses
dispatcher.js     → Manages the concurrent work queue with cost ceiling
logger.js         → Tracks cost and results to run-log.json
```

Each agent runs in its own git worktree, so concurrent agents never interfere
with each other's file changes. Worktrees are cleaned up after each agent
finishes (or crashes).

## Tuning

- Start with `MAX_CONCURRENCY=2` and watch for rate limit errors (429s)
- Bump to 3-5 if you're not hitting limits on Max 20x
- Increase timeouts in `agent.js` if your codebase is large (agents need time to read files)
- Adjust `COST_CEILING_USD` based on your issue volume
