# API-key → subscription fallback on credit exhaustion

The `claude` CLI bills the metered API when `ANTHROPIC_API_KEY` is set in its
environment, and uses the operator's logged-in **subscription** when it isn't.
The orchestrator already controls the env of every spawned CLI process, so it
can switch between the two by adding or removing that one variable.

When a metered key's credit is exhausted, the CLI returns
`HTTP 400 "Your credit balance is too low to access the Anthropic API…"`. On
detecting that string (`isCreditExhausted`), the orchestrator **re-invokes the
same call with `ANTHROPIC_API_KEY` stripped** from the child env, so the CLI
authenticates against the subscription instead. A run-scoped latch
(`disableApiKeyForRun`) then drops the key for every subsequent call, so we don't
keep paying a failed round-trip to the dead key.

This is reactive by necessity: Anthropic exposes **no endpoint to read a
remaining credit balance** (a direct balance GET 404s; only spend/usage reports
exist, behind an Admin key), so exhaustion can only be detected from the error.

## Scope & preconditions

- Centralized in `providers.buildSubprocessEnv`, used by both the hand-rolled
  agent path (`agent.js`) and the workflow brain (`workflow.js`). Each retries
  once on exhaustion; the workflow re-runs end-to-end on the subscription.
- The fallback only authenticates if the CLI is **logged into a subscription**.
  If not, the retry fails normally and the issue is reported failed.
- Only meaningful for Claude (subscriptions are Claude). Dropping the key is a
  no-op for Codex/Kimi auth.

## Consequences

- On by default; disable with `FALLBACK_TO_SUBSCRIPTION=false` to fail hard
  instead of falling back.
- `--max-budget-usd` and the priced cost ceiling are USD concepts that don't map
  to a subscription; after fallback the real bounds are `MAX_ITERATIONS` and the
  per-issue budget reservation, not a dollar cap.
- Subscriptions are rate-limited, so post-fallback runs may hit 429s under
  concurrency — keep `MAX_CONCURRENCY` modest.
