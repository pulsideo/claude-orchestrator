import { execFile } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { getSeverity } from './github.js';
import { resolveRole, resolveBin, estimateCost, loadPrices } from './providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

function loadPrompt(templateName, vars) {
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
export function runAgent({ role, severity, prompt, allowedTools = 'Bash,Read', cwd, timeout }) {
  const { provider, adapter, model } = resolveRole(role, severity);
  const bin = resolveBin(adapter);

  return new Promise((resolve, reject) => {
    const promptFile = join(tmpdir(), `agent-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(promptFile, prompt);
    const start = Date.now();

    // Per-adapter env (e.g. Kimi points the Claude CLI at Moonshot). Strip
    // CLAUDECODE so the subprocess doesn't think it's nested.
    const env = { ...process.env, ...adapter.extraEnv(process.env) };
    delete env.CLAUDECODE;

    const command = adapter.command({ bin, model, allowedTools, promptFile });

    execFile('bash', ['-c', command], {
      cwd, timeout, maxBuffer: 10 * 1024 * 1024, env,
    }, (error, stdout, stderr) => {
      const duration = Date.now() - start;
      try { unlinkSync(promptFile); } catch { /* best effort */ }

      if (error) {
        const fullError = [error.message, stderr, stdout].filter(Boolean).join('\n');
        reject({ error: fullError, duration, provider, model });
        return;
      }

      const { output, usage } = adapter.parseOutput(stdout);
      const cost = estimateCost(model, usage, loadPrices());
      resolve({ output, usage, cost, provider, model, duration });
    });
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

export function runRefinementAgent(issue, reviewComments, worktreeDir) {
  const formattedComments = reviewComments.map(c => {
    if (c.type === 'inline') {
      return `### Inline comment: \`${c.path}\` line ${c.line}\n${c.body}`;
    }
    return `### Summary comment\n${c.body}`;
  }).join('\n\n---\n\n');

  const prompt = loadPrompt('refine', {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '(no description)',
    reviewComments: formattedComments,
    branchName: `fix/issue-${issue.number}`,
  });

  return runAgent({
    role: 'refine',
    severity: getSeverity(issue),
    prompt,
    allowedTools: 'Bash,Read,Write,Edit',
    cwd: worktreeDir,
    timeout: 300_000,
  }).then(result => ({
    issueNumber: issue.number,
    output: result.output,
    cost: result.cost,
    duration: result.duration,
    provider: result.provider,
    model: result.model,
  })).catch(err => {
    throw { issueNumber: issue.number, phase: 'refine', error: err.error, duration: err.duration };
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
    comments: result.output?.trim() ? [{ type: 'summary', body: result.output }] : [],
    cost: result.cost,
    duration: result.duration,
    provider: result.provider,
    model: result.model,
  })).catch(err => {
    throw { issueNumber: issue.number, phase: 'review', error: err.error, duration: err.duration };
  });
}
