import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Point the logger at a throwaway file BEFORE importing it.
const LOG = join(tmpdir(), `orch-test-log-${process.pid}.json`);
process.env.RUN_LOG_PATH = LOG;

const { startRun, logResult, getRunCost, getLifetimeCost } = await import('../src/logger.js');

after(() => { try { rmSync(LOG); } catch {} });

// CRITIQUE #1, bug 2: the cost ceiling must be scoped to the current run, not
// the lifetime total summed across all historical runs.
test('getRunCost is scoped to the current run, not lifetime history', () => {
  startRun();
  logResult(1, { model: 'opus', cost: 2, status: 'merged', duration: 10, output: '' });
  logResult(2, { model: 'opus', cost: 3, status: 'merged', duration: 10, output: '' });
  assert.equal(getRunCost(), 5, 'run cost accumulates within a run');

  // A new run resets the per-run counter...
  startRun();
  assert.equal(getRunCost(), 0, 'startRun resets per-run cost');
  logResult(3, { model: 'sonnet', cost: 1, status: 'merged', duration: 10, output: '' });
  assert.equal(getRunCost(), 1, 'second run does not include first run spend');

  // ...but lifetime cost still reflects everything persisted.
  assert.equal(getLifetimeCost(), 6, 'lifetime cost sums all persisted runs');
});

test('logResult returns the current run cost (what the ceiling checks)', () => {
  startRun();
  const after1 = logResult(9, { model: 'opus', cost: 4, status: 'merged', duration: 5, output: '' });
  assert.equal(after1, 4);
});
