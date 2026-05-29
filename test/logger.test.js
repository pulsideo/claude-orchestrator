import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Point the logger at a throwaway file BEFORE importing it.
const LOG = join(tmpdir(), `orch-test-log-${process.pid}.json`);
process.env.RUN_LOG_PATH = LOG;

const { startRun, logResult, getRunCost, getLifetimeCost, reserveBudget, releaseBudget, getCommittedCost } = await import('../src/logger.js');

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

// Reservation prevents concurrent issues from each seeing spend below the
// ceiling and collectively overspending.
test('reserveBudget blocks starts that would exceed the ceiling; committed = spent + reserved', () => {
  startRun();
  assert.equal(getCommittedCost(), 0);
  assert.equal(reserveBudget(20, 50), true, 'first reservation fits');
  assert.equal(reserveBudget(20, 50), true, 'second fits (40 <= 50)');
  assert.equal(getCommittedCost(), 40, 'reservations count toward committed');
  assert.equal(reserveBudget(20, 50), false, 'third would exceed the ceiling → blocked');
  assert.equal(getCommittedCost(), 40, 'a blocked reservation does not change committed');
});

test('releaseBudget frees reserved budget; logged spend then counts as committed', () => {
  startRun();
  reserveBudget(20, 50);
  logResult(1, { model: 'opus', cost: 5, status: 'merged', duration: 1, output: '' });
  releaseBudget(20);
  assert.equal(getRunCost(), 5, 'actual spend recorded');
  assert.equal(getCommittedCost(), 5, 'committed = spent once the reservation is released');
});

test('startRun resets reservations as well as spend', () => {
  startRun();
  reserveBudget(30, 50);
  startRun();
  assert.equal(getCommittedCost(), 0, 'a new run clears reservations');
});
