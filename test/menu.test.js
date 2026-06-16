import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configFromEnv, applyConfig, shouldShowMenu,
  parseProvider, parseBool, parsePosInt, parsePosNum, providerReadiness,
} from '../src/menu.js';

test('configFromEnv applies defaults and provider fallthrough', () => {
  const c = configFromEnv({ DEFAULT_PROVIDER: 'codex', FIX_PROVIDER: 'kimi' });
  assert.equal(c.defaultProvider, 'codex');
  assert.equal(c.fixProvider, 'kimi');
  assert.equal(c.reviewProvider, 'codex', 'review falls back to default');
  assert.equal(c.autoMerge, false);
  assert.equal(c.maxIterations, 3);
});

test('applyConfig round-trips through env', () => {
  const env = {};
  const c = configFromEnv({});
  c.defaultProvider = 'kimi'; c.autoMerge = true; c.maxIterations = 5; c.discovery = true;
  applyConfig(c, env);
  assert.equal(env.DEFAULT_PROVIDER, 'kimi');
  assert.equal(env.AUTO_MERGE, 'true');
  assert.equal(env.MAX_ITERATIONS, '5');
  assert.equal(env.DISCOVERY, 'true');
  // re-reading yields the same config
  assert.deepEqual(configFromEnv(env), c);
});

test('shouldShowMenu: TTY shows, flags/headless skip', () => {
  assert.equal(shouldShowMenu({ argv: [], env: {}, isTTY: true }), true);
  assert.equal(shouldShowMenu({ argv: [], env: {}, isTTY: false }), false);
  assert.equal(shouldShowMenu({ argv: ['--no-menu'], env: {}, isTTY: true }), false);
  assert.equal(shouldShowMenu({ argv: [], env: { NON_INTERACTIVE: 'true' }, isTTY: true }), false);
  assert.equal(shouldShowMenu({ argv: [], env: { DRY_RUN: 'true' }, isTTY: true }), false);
});

test('parsers keep the current value on blank/invalid input', () => {
  assert.equal(parseProvider('', 'claude'), 'claude');
  assert.equal(parseProvider('CODEX', 'claude'), 'codex');
  assert.equal(parseProvider('bogus', 'claude'), 'claude');
  assert.equal(parseBool('y', false), true);
  assert.equal(parseBool('', true), true);
  assert.equal(parseBool('nope-ish', true), true);
  assert.equal(parseBool('no', true), false);
  assert.equal(parsePosInt('5', 3), 5);
  assert.equal(parsePosInt('0', 3), 3);
  assert.equal(parsePosInt('x', 3), 3);
  assert.equal(parsePosNum('12.5', 50), 12.5);
  assert.equal(parsePosNum('-1', 50), 50);
});

test('providerReadiness warns on missing bins and Kimi key', () => {
  const cfg = { defaultProvider: 'claude', fixProvider: 'codex', reviewProvider: 'kimi' };
  const noBins = providerReadiness(cfg, {}, () => false);
  assert.ok(noBins.some(w => /Claude CLI/.test(w)));
  assert.ok(noBins.some(w => /Codex CLI/.test(w)));
  assert.ok(noBins.some(w => /MOONSHOT_API_KEY/.test(w)));

  const ready = providerReadiness(
    { defaultProvider: 'claude', fixProvider: 'claude', reviewProvider: 'claude' },
    {}, () => true,
  );
  assert.deepEqual(ready, []);
});
