import { execFileSync } from 'child_process';
import { readFileSync, existsSync, accessSync, constants } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICES_PATH = join(__dirname, '..', 'prices.json');

/**
 * Parse the JSON emitted by the Claude CLI (`--output-format json`).
 * Shared by the Claude and Kimi adapters (Kimi runs through the Claude CLI).
 */
function parseClaudeJson(stdout) {
  try {
    const j = JSON.parse(stdout);
    const u = j.usage || {};
    return {
      output: j.result || stdout,
      usage: {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
      },
    };
  } catch {
    return { output: stdout, usage: { input: 0, output: 0 } };
  }
}

// Returns argv (excluding the binary). The prompt is fed via the child's stdin,
// never interpolated into a shell string — so untrusted issue content and the
// model/tool names cannot inject shell commands.
function claudeStyleCommand({ model, allowedTools }) {
  return ['--model', model, '--output-format', 'json', '--allowedTools', allowedTools, '-p'];
}

// --- Provider adapters -----------------------------------------------------
// Each adapter knows how to invoke one provider headlessly, parse its output
// into { output, usage:{input,output} }, and its default model tiers. Model IDs
// and prices for Codex/Kimi are best-effort defaults — verify and override.

const claude = {
  name: 'claude',
  defaultModels: { strong: 'opus', fast: 'sonnet' },
  binEnv: 'CLAUDE_BIN',
  binCandidates: ['claude'],
  command: claudeStyleCommand,
  extraEnv() { return {}; },
  parseOutput: parseClaudeJson,
  // Only Claude can host a dynamic workflow (its sub-agents are Claude). The
  // workflow brain is gated on this; Codex/Kimi keep the hand-rolled pipeline.
  supportsWorkflow: true,
};

// Kimi (Moonshot K2) has no native agentic CLI; drive it through the Claude CLI
// pointed at Moonshot's Anthropic-compatible endpoint.
const kimi = {
  name: 'kimi',
  defaultModels: { strong: 'kimi-k2-0905-preview', fast: 'kimi-k2-0905-preview' },
  binEnv: 'CLAUDE_BIN',
  binCandidates: ['claude'],
  command: claudeStyleCommand,
  extraEnv(env = process.env) {
    return {
      ANTHROPIC_BASE_URL: env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_AUTH_TOKEN: env.MOONSHOT_API_KEY || env.KIMI_API_KEY || '',
    };
  },
  parseOutput: parseClaudeJson,
};

const codex = {
  name: 'codex',
  defaultModels: { strong: 'gpt-5-codex', fast: 'gpt-5-codex' },
  binEnv: 'CODEX_BIN',
  binCandidates: ['codex'],
  command({ model }) {
    // codex exec reads the prompt from stdin (trailing `-`); --json emits JSONL.
    return ['exec', '--json', '--model', model, '--dangerously-bypass-approvals-and-sandbox', '-'];
  },
  extraEnv() { return {}; },
  parseOutput(stdout) {
    // Tolerant JSONL parse: take the last agent message and any token usage.
    let output = '';
    const usage = { input: 0, output: 0 };
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      const msg = ev.msg || ev;
      const type = msg.type || ev.type;
      if ((type === 'agent_message' || type === 'message') && (msg.message || msg.text)) {
        output = msg.message || msg.text;
      }
      const u = msg.usage || ev.usage || (type === 'token_count' ? msg : null);
      if (u) {
        usage.input = u.input_tokens ?? u.prompt_tokens ?? usage.input;
        usage.output = u.output_tokens ?? u.completion_tokens ?? usage.output;
      }
    }
    return { output: output || stdout, usage };
  },
};

export const REGISTRY = { claude, kimi, codex };

// --- Role → provider/model resolution --------------------------------------

const ROLE_TIER = { triage: 'fast', discovery: 'fast', refine: 'fast', review: 'strong' };

function tierForRole(role, severity) {
  if (role === 'fix') return (severity === 'critical' || severity === 'high') ? 'strong' : 'fast';
  return ROLE_TIER[role] || 'fast';
}

function providerForRole(role, env) {
  const def = env.DEFAULT_PROVIDER || 'claude';
  if (role === 'review') return env.REVIEW_PROVIDER || def;
  if (role === 'fix') return env.FIX_PROVIDER || def;
  return def;
}

function modelFor(adapter, tier, env) {
  const prefix = adapter.name.toUpperCase();
  const override = tier === 'strong' ? env[`${prefix}_MODEL_STRONG`] : env[`${prefix}_MODEL_FAST`];
  return override || adapter.defaultModels[tier];
}

/**
 * Resolve which provider + model a role should run on. Provider comes from
 * DEFAULT_PROVIDER, with FIX_PROVIDER / REVIEW_PROVIDER overrides; the model
 * comes from the provider's tier (severity-selected), with per-provider tier
 * overrides and exact REVIEW_MODEL / FIX_MODEL overrides.
 */
export function resolveRole(role, severity, env = process.env) {
  const providerName = providerForRole(role, env);
  const adapter = REGISTRY[providerName];
  if (!adapter) {
    throw new Error(`Unknown provider '${providerName}' for role '${role}'. Known: ${Object.keys(REGISTRY).join(', ')}`);
  }
  const tier = tierForRole(role, severity);
  const exact = role === 'review' ? env.REVIEW_MODEL : role === 'fix' ? env.FIX_MODEL : undefined;
  const model = exact || modelFor(adapter, tier, env);
  return { provider: providerName, adapter, model, tier };
}

// --- Cost -------------------------------------------------------------------

let pricesCache;

/** Load the per-model price table (USD per 1M tokens), merging MODEL_PRICES env JSON. */
export function loadPrices(env = process.env) {
  if (!pricesCache) {
    let base = {};
    if (existsSync(PRICES_PATH)) {
      try { base = JSON.parse(readFileSync(PRICES_PATH, 'utf-8')); } catch { base = {}; }
    }
    let override = {};
    if (env.MODEL_PRICES) {
      try { override = JSON.parse(env.MODEL_PRICES); } catch { override = {}; }
    }
    pricesCache = { ...base, ...override };
  }
  return pricesCache;
}

/**
 * Estimate USD cost from token usage and a price table. Unknown models return 0
 * (the caller is expected to warn) so the cost ceiling degrades loudly.
 */
export function estimateCost(model, usage, prices) {
  const p = prices?.[model];
  if (!p) return 0;
  const input = usage?.input || 0;
  const output = usage?.output || 0;
  return (input / 1_000_000) * (p.input || 0) + (output / 1_000_000) * (p.output || 0);
}

/** Resolve the executable for an adapter: env override → PATH → common locations → bare name. */
export function resolveBin(adapter, env = process.env) {
  if (env[adapter.binEnv]) return env[adapter.binEnv];
  for (const candidate of adapter.binCandidates) {
    try {
      return execFileSync('which', [candidate], { encoding: 'utf-8' }).trim();
    } catch {
      // not on PATH — try next
    }
  }
  const fallbacks = [
    join(env.HOME || '', '.local', 'bin', adapter.binCandidates[0]),
    `/usr/local/bin/${adapter.binCandidates[0]}`,
  ];
  for (const p of fallbacks) {
    try { accessSync(p, constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return adapter.binCandidates[0];
}
