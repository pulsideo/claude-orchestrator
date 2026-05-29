import { execFile } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSeverity } from './github.js';
import { loadPrompt } from './agent.js';
import { resolveRole, resolveBin, REGISTRY } from './providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Absolute path to the saved workflow, kept in THIS repo. We invoke it by
// scriptPath (not the /fix-issue slash command) so it stays discoverable when
// `claude` runs with cwd set to the *target* repo's worktree — without
// installing into ~/.claude/workflows (agent-config self-modification) or
// copying into the target repo (diff pollution). Verified to work headlessly.
const WORKFLOW_SCRIPT = join(__dirname, '..', '.claude', 'workflows', 'fix-issue.js');

// Default ceiling for a single workflow invocation (the convergence loop runs
// inside it). Generous because one call now covers triage + fix + review loop.
const WORKFLOW_TIMEOUT = 30 * 60 * 1000;

// Schema the saved workflow's return is validated against (--json-schema). The
// harness reads these from the result's `structured_output` field.
export const FIX_ISSUE_SCHEMA = {
  type: 'object',
  required: ['confirmed', 'summary'],
  properties: {
    confirmed: { type: 'boolean' },
    summary: { type: 'string' },
    iterations: { type: 'number' },
    findings: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Build the args object passed to the .claude/workflows/fix-issue.js workflow.
 * Prompts are rendered HERE (the workflow script has no filesystem access) with
 * runtime placeholders ({{triageAnalysis}}, {{diff}}, {{feedback}}) left intact
 * for the workflow to fill. Models come from the same resolveRole() the
 * hand-rolled path uses, so severity→tier behavior is identical.
 */
export function buildWorkflowArgs(issue, worktree, severity, env = process.env) {
  const ctx = {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '(no description)',
  };
  const fixTemplate = (severity === 'critical' || severity === 'high') ? 'fix-critical' : 'fix-standard';
  const branchName = worktree.branch;
  const tokenBudget = parseInt(env.PER_ISSUE_TOKEN_BUDGET || '0', 10) || null;

  return {
    issueNumber: issue.number,
    branch: branchName,
    severity,
    maxIterations: Math.max(1, parseInt(env.MAX_ITERATIONS || '3', 10) || 3),
    tokenBudget,
    models: {
      triage: resolveRole('triage', severity, env).model,
      fix: resolveRole('fix', severity, env).model,
      review: resolveRole('review', severity, env).model,
    },
    triagePrompt: loadPrompt('triage', ctx),
    fixPrompt: loadPrompt(fixTemplate, { ...ctx, branchName }),
    reviewPrompt: loadPrompt('review', ctx),
    reworkPrompt: loadPrompt('rework', { ...ctx, branchName }),
  };
}

/**
 * Parse the JSON emitted by `claude -p ... --output-format json` for a workflow
 * run. Reads the schema-validated `structured_output` (NOT `result`) and the
 * real `total_cost_usd`. FAILS CLOSED: any parse error, CLI error, or missing
 * confirmation yields confirmed:false so the harness never treats an unverified
 * fix as confirmed.
 */
export function parseWorkflowResult(stdout, cliError) {
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* leave null */ }
  const out = (parsed && parsed.structured_output) || {};
  const apiError = !!cliError || parsed?.is_error === true || !parsed;
  return {
    confirmed: !apiError && out.confirmed === true,
    summary: out.summary || parsed?.result || (cliError ? String(cliError.message || cliError) : ''),
    findings: Array.isArray(out.findings) ? out.findings : [],
    filesChanged: Array.isArray(out.filesChanged) ? out.filesChanged : [],
    iterations: out.iterations || 0,
    cost: parsed?.total_cost_usd || 0,
    apiError,
  };
}

/**
 * Build the argv for the headless workflow invocation. No shell: the prompt
 * (incl. the args JSON with untrusted issue title/body) is one argv element,
 * never interpolated into a command string. We instruct the run to invoke the
 * workflow by scriptPath so it's discoverable from the target worktree cwd.
 * `--allowedTools Workflow,...` clears the dynamic-workflow review gate AND
 * gives the workflow's sub-agents tool access.
 */
export function buildWorkflowArgv(wfArgs, { budgetUsd, scriptPath = WORKFLOW_SCRIPT } = {}) {
  const prompt =
    `Run the dynamic workflow script located at ${scriptPath} using the Workflow tool ` +
    `with scriptPath, passing exactly this args object (JSON) verbatim as the args parameter: ` +
    `${JSON.stringify(wfArgs)}. Return its result and nothing else.`;
  const argv = [
    '-p', prompt,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(FIX_ISSUE_SCHEMA),
    '--allowedTools', 'Workflow,Bash,Read,Write,Edit',
  ];
  if (budgetUsd && budgetUsd > 0) {
    argv.push('--max-budget-usd', String(budgetUsd));
  }
  return argv;
}

/**
 * Run the Claude "brain" for one issue as a saved dynamic workflow (triage →
 * fix → converge with adversarial review). This is the single swappable seam:
 * to move to the Agent SDK later, only this function changes — the dispatcher
 * keeps calling runFixWorkflow() and reading the same result shape.
 *
 * Returns { confirmed, summary, findings, filesChanged, iterations, cost,
 * duration, provider, model, apiError }. `confirmed` is ADVISORY — the harness
 * re-runs validateBranch authoritatively before merging.
 */
export function runFixWorkflow(issue, worktree, { severity, budgetUsd, env = process.env } = {}) {
  const sev = severity || getSeverity(issue);
  const wfArgs = buildWorkflowArgs(issue, worktree, sev, env);
  const argv = buildWorkflowArgv(wfArgs, { budgetUsd });
  const bin = resolveBin(REGISTRY.claude, env);

  // Strip Claude Code's own env so the subprocess doesn't think it's nested.
  const cliEnv = { ...env };
  delete cliEnv.CLAUDECODE;
  delete cliEnv.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve, reject) => {
    const start = Date.now();
    execFile(bin, argv, {
      cwd: worktree.dir,
      timeout: WORKFLOW_TIMEOUT,
      maxBuffer: 64 * 1024 * 1024,
      env: cliEnv,
    }, (error, stdout) => {
      const duration = Date.now() - start;
      const result = parseWorkflowResult(stdout, error);

      // Hard failure with nothing parseable: surface as an error to the dispatcher.
      if (error && !stdout) {
        reject({ issueNumber: issue.number, phase: 'workflow', error: error.message, duration });
        return;
      }
      resolve({
        issueNumber: issue.number,
        ...result,
        duration,
        provider: 'claude',
        model: wfArgs.models.fix,
      });
    });
  });
}
