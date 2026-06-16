# Provider-agnostic agents via a hybrid adapter registry

Agents are no longer hardwired to the `claude` CLI. A registry of Provider
Adapters (Claude, Codex, Kimi) each declares how to invoke that provider
headlessly, how to parse its output into `{ output, token usage }`, and its
default Model tiers (`strong`/`fast`). Provider is chosen per role: a default
Provider for triage/refine/discovery, with separate overrides for `fix` and the
`reviewer`. Severity picks the Model tier within the chosen provider.

The registry is **hybrid** because the providers don't share one invocation
shape: Claude runs `claude -p --output-format json`, Codex runs `codex exec`,
and Kimi reuses the Claude CLI with `ANTHROPIC_BASE_URL` pointed at Moonshot's
Anthropic-compatible endpoint (Kimi has no native agentic CLI). Adapting per
provider is the only thing that covers all three without forcing a lowest common
denominator.

## Cost across providers

Only Claude reliably reports USD, and a Kimi run through the Claude CLI would
report Anthropic prices (wrong for Kimi). So cost is computed uniformly:
adapters report **token usage**, and the orchestrator multiplies by a
configurable per-model price table (`prices.json`). Unknown models contribute $0
and log a warning, so the cost ceiling degrades loudly, not silently.

## Consequences

- Default Provider is `claude` with `opus`/`sonnet` tiers, so existing behavior
  is unchanged out of the box.
- Codex's JSONL output schema and the default model IDs/prices for Codex/Kimi
  are best-effort defaults — operators should verify and override in config
  (same "verify against the installed CLI" discipline as the Claude cost field).
- Each adapter owns its tool-permission model (`--allowedTools` is Claude-only).
