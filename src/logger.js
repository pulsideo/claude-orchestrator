import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, '..', 'run-log.json');

function loadLog() {
  if (existsSync(LOG_PATH)) {
    return JSON.parse(readFileSync(LOG_PATH, 'utf-8'));
  }
  return { runs: [], totalCost: 0 };
}

function saveLog(log) {
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
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
  log.totalCost = log.runs.reduce((sum, r) => sum + (r.cost || 0), 0);
  saveLog(log);
  return log.totalCost;
}

export function getTotalCost() {
  return loadLog().totalCost;
}

export function resetLog() {
  saveLog({ runs: [], totalCost: 0 });
}
