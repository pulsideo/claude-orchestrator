import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeResult } from '../src/agent.js';

// CRITIQUE #1, bug 1: the CLI emits `total_cost_usd`, not `cost_usd`.
// Verified empirically against Claude Code 2.1.x.
test('parseClaudeResult reads total_cost_usd', () => {
  const stdout = JSON.stringify({ result: 'done', total_cost_usd: 0.0583 });
  const { output, cost } = parseClaudeResult(stdout);
  assert.equal(output, 'done');
  assert.equal(cost, 0.0583);
});

test('parseClaudeResult falls back to legacy cost_usd', () => {
  const stdout = JSON.stringify({ result: 'done', cost_usd: 0.12 });
  assert.equal(parseClaudeResult(stdout).cost, 0.12);
});

test('parseClaudeResult prefers total_cost_usd over legacy field', () => {
  const stdout = JSON.stringify({ result: 'x', total_cost_usd: 0.9, cost_usd: 0.1 });
  assert.equal(parseClaudeResult(stdout).cost, 0.9);
});

test('parseClaudeResult treats a real zero cost as zero (not falsy-skipped)', () => {
  const stdout = JSON.stringify({ result: 'x', total_cost_usd: 0 });
  assert.equal(parseClaudeResult(stdout).cost, 0);
});

test('parseClaudeResult falls back to raw stdout on invalid JSON', () => {
  const { output, cost } = parseClaudeResult('not json');
  assert.equal(output, 'not json');
  assert.equal(cost, 0);
});
