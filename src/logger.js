import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Allow overriding the log path (used by tests) so runs don't clobber real history.
const LOG_PATH = process.env.RUN_LOG_PATH || join(__dirname, '..', 'run-log.json');

// Per-run cost is tracked in memory so the cost ceiling is scoped to THIS run,
// not the lifetime total persisted in run-log.json. (CRITIQUE #1, bug 2.)
let runCost = 0;
// Budget reserved by issues currently in flight but not yet logged. Without
// this, under concurrency several issues can each see runCost below the ceiling
// and all start, overspending together. Committed = spent + reserved.
let reservedCost = 0;

function loadLog() {
  if (existsSync(LOG_PATH)) {
    return JSON.parse(readFileSync(LOG_PATH, 'utf-8'));
  }
  return { runs: [], lifetimeCost: 0 };
}

function saveLog(log) {
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

/**
 * Reset the in-memory per-run cost. Call once at the start of a run.
 */
export function startRun() {
  runCost = 0;
  reservedCost = 0;
}

/**
 * Try to reserve `amount` USD against the ceiling before starting an issue.
 * Returns true if (committed + amount) fits under the ceiling, recording the
 * reservation; false otherwise (caller should not start the issue). Atomic in
 * JS's single-threaded model: no await between check and reserve.
 */
export function reserveBudget(amount, ceiling) {
  if (runCost + reservedCost + amount > ceiling) return false;
  reservedCost += amount;
  return true;
}

/** Release a previously reserved amount (call after the issue is logged). */
export function releaseBudget(amount) {
  reservedCost = Math.max(0, reservedCost - amount);
}

/** Spent + reserved — what the ceiling is actually checked against under concurrency. */
export function getCommittedCost() {
  return runCost + reservedCost;
}

export function logResult(issueNumber, { model, cost, status, duration, output }) {
  const log = loadLog();
  const entry = {
    issue: issueNumber,
    model,
    cost,
    status,
    duration,
    timestamp: new Date().toISOString(),
    outputSnippet: output || '',
  };
  log.runs.push(entry);
  log.lifetimeCost = log.runs.reduce((sum, r) => sum + (r.cost || 0), 0);
  saveLog(log);

  runCost += cost || 0;
  return runCost;
}

/**
 * Cost spent during the current run. This is what the cost ceiling is checked
 * against.
 */
export function getRunCost() {
  return runCost;
}

/**
 * Lifetime cost across all persisted runs. Informational only.
 */
export function getLifetimeCost() {
  return loadLog().lifetimeCost;
}

export function resetLog() {
  saveLog({ runs: [], lifetimeCost: 0 });
}
