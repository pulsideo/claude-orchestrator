import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTRY, resolveRole, estimateCost, loadPrices,
  isCreditExhausted, buildSubprocessEnv, fallbackEnabled,
  isApiKeyDisabled, disableApiKeyForRun, resetApiKeyFallback,
} from '../src/providers.js';

// --- output parsing --------------------------------------------------------

test('claude adapter parses output + token usage (incl. cache tokens)', () => {
  const stdout = JSON.stringify({
    result: 'done',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
  });
  const { output, usage } = REGISTRY.claude.parseOutput(stdout);
  assert.equal(output, 'done');
  assert.equal(usage.input, 120);
  assert.equal(usage.output, 50);
});

test('claude adapter falls back to raw stdout + zero usage on invalid JSON', () => {
  const { output, usage } = REGISTRY.claude.parseOutput('not json');
  assert.equal(output, 'not json');
  assert.deepEqual(usage, { input: 0, output: 0 });
});

test('kimi adapter reuses the claude parser and sets the Moonshot endpoint', () => {
  assert.equal(REGISTRY.kimi.parseOutput, REGISTRY.claude.parseOutput);
  const env = REGISTRY.kimi.extraEnv({ MOONSHOT_API_KEY: 'sk-x' });
  assert.match(env.ANTHROPIC_BASE_URL, /moonshot/);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-x');
});

test('codex adapter parses JSONL agent message + token usage', () => {
  const stdout = [
    JSON.stringify({ msg: { type: 'agent_message', message: 'looks good' } }),
    JSON.stringify({ msg: { type: 'token_count', input_tokens: 10, output_tokens: 5 } }),
  ].join('\n');
  const { output, usage } = REGISTRY.codex.parseOutput(stdout);
  assert.equal(output, 'looks good');
  assert.equal(usage.input, 10);
  assert.equal(usage.output, 5);
});

// --- role resolution -------------------------------------------------------

test('default provider is claude with severity-selected tiers', () => {
  assert.deepEqual(pick(resolveRole('triage', 'low', {})), { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(pick(resolveRole('fix', 'critical', {})), { provider: 'claude', model: 'opus' });
  assert.deepEqual(pick(resolveRole('fix', 'low', {})), { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(pick(resolveRole('review', 'low', {})), { provider: 'claude', model: 'opus' }); // review = strong
});

test('FIX_PROVIDER and REVIEW_PROVIDER override per role, default unaffected', () => {
  const env = { DEFAULT_PROVIDER: 'claude', FIX_PROVIDER: 'codex', REVIEW_PROVIDER: 'kimi' };
  assert.equal(resolveRole('triage', 'low', env).provider, 'claude');
  assert.equal(resolveRole('fix', 'low', env).provider, 'codex');
  assert.equal(resolveRole('review', 'low', env).provider, 'kimi');
});

test('per-provider tier model overrides apply', () => {
  assert.equal(resolveRole('fix', 'critical', { CLAUDE_MODEL_STRONG: 'opus-4-8' }).model, 'opus-4-8');
  assert.equal(resolveRole('triage', 'low', { CLAUDE_MODEL_FAST: 'haiku' }).model, 'haiku');
});

test('exact REVIEW_MODEL / FIX_MODEL overrides win', () => {
  assert.equal(resolveRole('review', 'low', { REVIEW_MODEL: 'custom-rev' }).model, 'custom-rev');
  assert.equal(resolveRole('fix', 'high', { FIX_MODEL: 'custom-fix' }).model, 'custom-fix');
});

test('unknown provider throws a helpful error', () => {
  assert.throws(() => resolveRole('triage', 'low', { DEFAULT_PROVIDER: 'bogus' }), /Unknown provider 'bogus'/);
});

// --- cost ------------------------------------------------------------------

test('estimateCost multiplies token usage by the price table', () => {
  const prices = { sonnet: { input: 3, output: 15 } };
  assert.equal(estimateCost('sonnet', { input: 1_000_000, output: 1_000_000 }, prices), 18);
  assert.equal(estimateCost('sonnet', { input: 0, output: 0 }, prices), 0);
});

test('estimateCost returns 0 for an unpriced model', () => {
  assert.equal(estimateCost('mystery', { input: 5_000, output: 5_000 }, {}), 0);
});

test('loadPrices ships defaults for the built-in models', () => {
  const prices = loadPrices({});
  assert.ok(prices.opus && prices.sonnet, 'opus and sonnet are priced by default');
});

function pick({ provider, model }) {
  return { provider, model };
}

// --- API-key → subscription fallback ---------------------------------------

test('isCreditExhausted matches the real 400 message, ignores unrelated errors', () => {
  assert.equal(isCreditExhausted('Your credit balance is too low to access the Anthropic API.'), true);
  assert.equal(isCreditExhausted('400 {"type":"error","error":{"message":"...credit balance is too low..."}}'), true);
  assert.equal(isCreditExhausted('429 rate_limit_error: too many requests'), false);
  assert.equal(isCreditExhausted('invalid x-api-key'), false);
  assert.equal(isCreditExhausted(''), false);
});

test('fallbackEnabled is on by default, off only when explicitly false', () => {
  assert.equal(fallbackEnabled({}), true);
  assert.equal(fallbackEnabled({ FALLBACK_TO_SUBSCRIPTION: 'false' }), false);
});

test('buildSubprocessEnv strips CLAUDECODE and conditionally drops the API key', () => {
  const base = { ANTHROPIC_API_KEY: 'sk-x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', FOO: 'bar' };
  const keep = buildSubprocessEnv(REGISTRY.claude, base, { dropApiKey: false });
  assert.equal(keep.CLAUDECODE, undefined, 'CLAUDECODE always stripped');
  assert.equal(keep.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(keep.ANTHROPIC_API_KEY, 'sk-x', 'key kept when not dropping');
  assert.equal(keep.FOO, 'bar', 'unrelated vars preserved');

  const dropped = buildSubprocessEnv(REGISTRY.claude, base, { dropApiKey: true });
  assert.equal(dropped.ANTHROPIC_API_KEY, undefined, 'key dropped → CLI uses subscription');
});

test('the run-scoped latch flips on exhaustion and drives buildSubprocessEnv default', () => {
  resetApiKeyFallback();
  assert.equal(isApiKeyDisabled(), false);
  // default dropApiKey follows the latch
  assert.equal('ANTHROPIC_API_KEY' in buildSubprocessEnv(REGISTRY.claude, { ANTHROPIC_API_KEY: 'sk-x' }), true);

  disableApiKeyForRun();
  assert.equal(isApiKeyDisabled(), true);
  assert.equal('ANTHROPIC_API_KEY' in buildSubprocessEnv(REGISTRY.claude, { ANTHROPIC_API_KEY: 'sk-x' }), false,
    'once latched, the key is dropped by default for all later calls');

  resetApiKeyFallback(); // don't leak latch state to other tests
});
