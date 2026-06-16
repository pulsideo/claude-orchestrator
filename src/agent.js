import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSeverity } from './github.js';
import {
  resolveRole, resolveBin, estimateCost, loadPrices,
  buildSubprocessEnv, fallbackEnabled, isApiKeyDisabled, disableApiKeyForRun, isCreditExhausted,
} from './providers.js';

// Model ids are passed as argv (no shell), but validate anyway as defense in
// depth so a misconfigured override can't smuggle anything odd into the spawn.
const MODEL_RE = /^[A-Za-z0-9._:/-]+$/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

export function loadPrompt(templateName, vars) {
  let template = readFileSync(join(PROMPTS_DIR, `${templateName}.md`), 'utf-8');
  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, String(value));
  }
  return template;
}

/**
 * Run one agent on the provider/model resolved for its role + severity.
 * Returns { output, usage, cost, provider, model, duration }. Cost is estimated
 * from token usage via the price table (uniform across providers).
 */
export function runAgent(opts) {
  // Start honoring the run-scoped latch: if the API key was already exhausted
  // earlier this run, go straight to the subscription.
  return runAgentAttempt(opts, isApiKeyDisabled());
}

function runAgentAttempt(opts, dropApiKey) {
  const { role, severity, prompt, allowedTools = 'Bash,Read', cwd, timeout } = opts;
  const { provider, adapter, model } = resolveRole(role, severity);
  const bin = resolveBin(adapter);

  return new Promise((resolve, reject) => {
    if (!MODEL_RE.test(model)) {
      reject({ error: `Refusing to run: invalid model id '${model}'`, duration: 0, provider, model });
      return;
    }
    const start = Date.now();

    // Per-adapter env, minus CLAUDECODE; drops ANTHROPIC_API_KEY when falling
    // back to the subscription (latch or forced retry).
    const env = buildSubprocessEnv(adapter, process.env, { dropApiKey });
    const apiKeyWasActive = !dropApiKey && !!process.env.ANTHROPIC_API_KEY && fallbackEnabled();

    // argv invocation (no shell); the prompt goes in via stdin, so nothing —
    // not the model, tool list, or untrusted issue content — is interpolated
    // into a command string. Also removes the temp-prompt-file lifecycle.
    const args = adapter.command({ model, allowedTools });
    const child = spawn(bin, args, { cwd, env, timeout });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      reject({ error: err.message, duration: Date.now() - start, provider, model });
    });
    child.on('close', (code) => {
      const duration = Date.now() - start;
      if (code !== 0) {
        const fullError = [stderr, stdout].filter(Boolean).join('\n') || `exited with code ${code}`;
        // API credit exhausted → drop the key and retry once on the subscription.
        if (apiKeyWasActive && isCreditExhausted(fullError)) {
          disableApiKeyForRun();
          runAgentAttempt(opts, true).then(resolve, reject);
          return;
        }
        reject({ error: fullError, duration, provider, model });
        return;
      }
      const { output, usage } = adapter.parseOutput(stdout);
      const cost = estimateCost(model, usage, loadPrices());
      resolve({ output, usage, cost, provider, model, duration });
    });

    child.stdin.on('error', () => { /* ignore EPIPE if the child exits early */ });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Scan the target repo for bugs within a free-text scope. Read-only; returns
 * the agent's raw output (a JSON array of proposed bugs) for the caller to parse.
 */
export function runDiscoveryAgent(scope, repoPath, existingTitles = []) {
  // Give the agent the open-issue titles so it can skip bugs already tracked,
  // including ones it would phrase differently — the title-only dedup backstop
  // in discovery.js can't catch semantic duplicates.
  const existing = existingTitles.length
    ? existingTitles.map(t => `- ${t}`).join('\n')
    : '(none)';
  const prompt = loadPrompt('discover', { scope: scope || 'the whole codebase', existing });

  return runAgent({
    role: 'discovery',
    severity: 'medium',
    prompt,
    allowedTools: 'Bash,Read',
    cwd: repoPath,
    timeout: 600_000,
  }).then(result => ({
    output: result.output,
    cost: result.cost,
    duration: result.duration,
    provider: result.provider,
    model: result.model,
  })).catch(err => {
    throw { phase: 'discovery', error: err.error, duration: err.duration };
  });
}

export function runTriageAgent(issue, worktreeDir) {
  const prompt = loadPrompt('triage', {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '(no description)',
  });

  return runAgent({
    role: 'triage',
    severity: getSeverity(issue),
    prompt,
    allowedTools: 'Bash,Read',
    cwd: worktreeDir,
    timeout: 300_000,
  }).then(result => ({
    issueNumber: issue.number,
    analysis: result.output,
    cost: result.cost,
    duration: result.duration,
    provider: result.provider,
    model: result.model,
  })).catch(err => {
    throw { issueNumber: issue.number, phase: 'triage', error: err.error, duration: err.duration };
  });
}

/**
 * Decide whether a review's output contains blocking findings. Prefers an
 * explicit machine-readable `VERDICT:` line; falls back to detecting a
 * BLOCKING marker (ignoring "non-blocking"). Defaults to non-blocking so the
 * loop terminates when the reviewer is silent.
 */
export function parseReviewVerdict(output) {
  const text = output || '';
  if (/VERDICT:\s*(CHANGES|BLOCK)/i.test(text)) return true;
  if (/VERDICT:\s*(PASS|APPROVE|LGTM)/i.test(text)) return false;
  return /\bBLOCKING\b/i.test(text.replace(/non-blocking/gi, ''));
}

/**
 * Rework the fix to address feedback — either a failing validation gate or
 * blocking review findings. Runs on the fix provider/tier (one loop iteration).
 */
export function runReworkAgent(issue, feedback, worktreeDir) {
  const prompt = loadPrompt('rework', {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '(no description)',
    feedback,
    branchName: `fix/issue-${issue.number}`,
  });

  return runAgent({
    role: 'fix',
    severity: getSeverity(issue),
    prompt,
    allowedTools: 'Bash,Read,Write,Edit',
    cwd: worktreeDir,
    timeout: 600_000,
  }).then(result => ({
    issueNumber: issue.number,
    output: result.output,
    cost: result.cost,
    duration: result.duration,
    provider: result.provider,
    model: result.model,
  })).catch(err => {
    throw { issueNumber: issue.number, phase: 'rework', error: err.error, duration: err.duration };
  });
}

export function runFixAgent(issue, triageAnalysis, worktreeDir) {
  const severity = getSeverity(issue);
  const templateName = (severity === 'critical' || severity === 'high') ? 'fix-critical' : 'fix-standard';

  const prompt = loadPrompt(templateName, {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '(no description)',
    triageAnalysis: triageAnalysis || 'No triage analysis available.',
    branchName: `fix/issue-${issue.number}`,
  });

  return runAgent({
    role: 'fix',
    severity,
    prompt,
    allowedTools: 'Bash,Read,Write,Edit',
    cwd: worktreeDir,
    timeout: 600_000,
  }).then(result => ({
    issueNumber: issue.number,
    model: result.model,
    provider: result.provider,
    output: result.output,
    cost: result.cost,
    duration: result.duration,
  })).catch(err => {
    throw { issueNumber: issue.number, phase: 'fix', model: err.model, error: err.error, duration: err.duration };
  });
}

/**
 * Review a fix's diff on the configured reviewer provider (REVIEW_PROVIDER),
 * which may differ from the default provider. Returns review comments in the
 * shape the refinement agent expects.
 */
export function runReviewAgent(issue, diff, worktreeDir) {
  const prompt = loadPrompt('review', {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '(no description)',
    diff: diff || '(no diff)',
  });

  return runAgent({
    role: 'review',
    severity: getSeverity(issue),
    prompt,
    allowedTools: 'Bash,Read',
    cwd: worktreeDir,
    timeout: 300_000,
  }).then(result => ({
    issueNumber: issue.number,
    blocking: parseReviewVerdict(result.output),
    comments: result.output?.trim() ? [{ type: 'summary', body: result.output }] : [],
    cost: result.cost,
    duration: result.duration,
    provider: result.provider,
    model: result.model,
  })).catch(err => {
    throw { issueNumber: issue.number, phase: 'review', error: err.error, duration: err.duration };
  });
}
