import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Allow overriding the log path (used by tests) so runs don't clobber real history.
const LOG_PATH = process.env.RUN_LOG_PATH || join(__dirname, '..', 'run-log.json');

// Per-run cost is tracked in memory so the cost ceiling is scoped to THIS run,
// not the lifetime total persisted in run-log.json. (CRITIQUE #1, bug 2.)
let runCost = 0;

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
