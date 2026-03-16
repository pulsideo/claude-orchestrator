import { execFile, execFileSync } from 'child_process';
import { accessSync, constants, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { getSeverity } from './github.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

// Resolve the full path to `claude` once at startup so spawned shells can find it
// even when PATH doesn't include ~/.local/bin in non-interactive mode.
let CLAUDE_BIN;
try {
  CLAUDE_BIN = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
} catch {
  // Fallback: check common install locations
  const candidates = [
    join(process.env.HOME || '', '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  CLAUDE_BIN = candidates.find(p => {
    try { accessSync(p, constants.X_OK); return true; } catch { return false; }
  }) || 'claude'; // last resort: hope PATH works at runtime
}

function loadPrompt(templateName, vars) {
  let template = readFileSync(join(PROMPTS_DIR, `${templateName}.md`), 'utf-8');
  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, String(value));
  }
  return template;
}

function modelForSeverity(severity) {
  if (severity === 'critical' || severity === 'high') return 'opus';
  return 'sonnet';
}

function runClaude({ prompt, model, allowedTools, cwd, timeout }) {
  return new Promise((resolve, reject) => {
    const promptFile = join(tmpdir(), `claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(promptFile, prompt);

    const start = Date.now();

    // Strip CLAUDECODE env var so the subprocess doesn't think it's nested
    const env = { ...process.env };
    delete env.CLAUDECODE;

    execFile('bash', [
      '-c',
      `cat "${promptFile}" | ${CLAUDE_BIN} --model ${model} --output-format json --allowedTools "${allowedTools}" -p -`,
    ], {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env,
    }, (error, stdout, stderr) => {
      const duration = Date.now() - start;

      // Clean up temp file
      try { unlinkSync(promptFile); } catch {}

      if (error) {
        const fullError = [error.message, stderr, stdout].filter(Boolean).join('\n');
        reject({ error: fullError, duration });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve({
          output: result.result || stdout,
          cost: result.cost_usd || 0,
          duration,
        });
      } catch {
        resolve({
          output: stdout,
          cost: 0,
          duration,
        });
      }
    });
  });
}

export function runTriageAgent(issue, worktreeDir) {
  const prompt = loadPrompt('triage', {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '(no description)',
  });

  return runClaude({
    prompt,
    model: 'sonnet',
    allowedTools: 'Bash,Read',
    cwd: worktreeDir,
    timeout: 300_000,
  }).then(result => ({
    issueNumber: issue.number,
    analysis: result.output,
    cost: result.cost,
    duration: result.duration,
  })).catch(err => {
    throw {
      issueNumber: issue.number,
      phase: 'triage',
      error: err.error,
      duration: err.duration,
    };
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

  return runClaude({
    prompt,
    model: 'sonnet',
    allowedTools: 'Bash,Read,Write,Edit',
    cwd: worktreeDir,
    timeout: 300_000,
  }).then(result => ({
    issueNumber: issue.number,
    output: result.output,
    cost: result.cost,
    duration: result.duration,
  })).catch(err => {
    throw {
      issueNumber: issue.number,
      phase: 'refine',
      error: err.error,
      duration: err.duration,
    };
  });
}

export function runFixAgent(issue, triageAnalysis, worktreeDir) {
  const severity = getSeverity(issue);
  const templateName = (severity === 'critical' || severity === 'high')
    ? 'fix-critical'
    : 'fix-standard';

  const prompt = loadPrompt(templateName, {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '(no description)',
    triageAnalysis: triageAnalysis || 'No triage analysis available.',
    branchName: `fix/issue-${issue.number}`,
  });

  const model = modelForSeverity(severity);

  return runClaude({
    prompt,
    model,
    allowedTools: 'Bash,Read,Write,Edit',
    cwd: worktreeDir,
    timeout: 600_000,
  }).then(result => ({
    issueNumber: issue.number,
    model,
    output: result.output,
    cost: result.cost,
    duration: result.duration,
  })).catch(err => {
    throw {
      issueNumber: issue.number,
      phase: 'fix',
      model,
      error: err.error,
      duration: err.duration,
    };
  });
}
