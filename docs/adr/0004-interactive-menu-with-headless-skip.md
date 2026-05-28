# Interactive Settings menu, auto-skipped when headless

The orchestrator's primary control surface is an interactive startup menu that
pre-fills from `.env` and lets the operator set per-run options (auto-merge,
iteration cap, Claude auth, discovery on/off + scope, concurrency, cost
ceiling). When no TTY is present — or `--no-menu` / `NON_INTERACTIVE=true` is
set — the menu is skipped and the run uses `.env` values and defaults.

We chose env-with-interactive-override over pure env-var config (poor UX for
ad-hoc runs, easy to forget a flag) and over a mandatory menu (blocks `/loop`,
`/schedule`, cron, and CI). The same entry point thus serves both an operator at
a terminal and an unattended scheduled run.

## Consequences

- Every menu setting must also be expressible as an env var so headless runs can
  set it.
- The Claude-auth step is interactive-only; headless runs assume auth is already
  present and fail fast if not.
