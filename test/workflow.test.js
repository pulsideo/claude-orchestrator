import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowArgs, buildWorkflowArgv, parseWorkflowResult } from '../src/workflow.js';
import { useWorkflowBrain } from '../src/dispatcher.js';

const ISSUE = { number: 7, title: 'Crash on empty input', body: 'It throws when input is empty.' };
const WT = { dir: '/tmp/wt', branch: 'fix/issue-7' };

// --- buildWorkflowArgs: prompts rendered, runtime placeholders left intact ---

test('buildWorkflowArgs renders prompts and leaves runtime placeholders for the workflow', () => {
  const a = buildWorkflowArgs(ISSUE, WT, 'high', {});
  // Issue context is substituted by the harness...
  assert.match(a.fixPrompt, /#7/);
  assert.match(a.fixPrompt, /Crash on empty input/);
  // ...but the runtime tokens are left for the workflow to fill.
  assert.match(a.fixPrompt, /\{\{triageAnalysis\}\}/);
  assert.match(a.reviewPrompt, /\{\{diff\}\}/);
  assert.match(a.reworkPrompt, /\{\{feedback\}\}/);
  assert.equal(a.branch, 'fix/issue-7');
});

test('buildWorkflowArgs picks fix template + models from severity (same as hand-rolled path)', () => {
  const crit = buildWorkflowArgs(ISSUE, WT, 'critical', {});
  assert.equal(crit.models.fix, 'opus');     // critical → strong
  assert.equal(crit.models.review, 'opus');  // review → strong
  assert.equal(crit.models.triage, 'sonnet'); // triage → fast
  assert.match(crit.fixPrompt, /CRITICAL/);   // fix-critical template

  const low = buildWorkflowArgs(ISSUE, WT, 'low', {});
  assert.equal(low.models.fix, 'sonnet');     // low → fast
});

// --- buildWorkflowArgv: no shell, scriptPath, conditional budget flag --------

test('buildWorkflowArgv references the script by path and embeds args without a shell', () => {
  const argv = buildWorkflowArgv({ issueNumber: 7 }, { budgetUsd: 2.5, scriptPath: '/abs/fix-issue.js' });
  assert.equal(argv[0], '-p');
  assert.match(argv[1], /\/abs\/fix-issue\.js/);
  assert.match(argv[1], /"issueNumber":7/);
  assert.ok(argv.includes('--json-schema'));
  assert.ok(argv.includes('--allowedTools'));
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Workflow,Bash,Read,Write,Edit');
  assert.ok(argv.includes('--max-budget-usd'));
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '2.5');
});

test('buildWorkflowArgv omits --max-budget-usd when no budget given', () => {
  const argv = buildWorkflowArgv({ issueNumber: 7 }, { budgetUsd: 0 });
  assert.ok(!argv.includes('--max-budget-usd'));
});

// --- parseWorkflowResult: FAILS CLOSED --------------------------------------

test('parseWorkflowResult reads structured_output + total_cost_usd on success', () => {
  const stdout = JSON.stringify({
    is_error: false,
    total_cost_usd: 0.42,
    structured_output: { confirmed: true, summary: 'done', findings: [], filesChanged: ['a.js'] },
  });
  const r = parseWorkflowResult(stdout, null);
  assert.equal(r.confirmed, true);
  assert.equal(r.cost, 0.42);
  assert.deepEqual(r.filesChanged, ['a.js']);
  assert.equal(r.apiError, false);
});

test('parseWorkflowResult fails closed when is_error is true', () => {
  const stdout = JSON.stringify({ is_error: true, total_cost_usd: 0.1, structured_output: { confirmed: true, summary: 'x' } });
  const r = parseWorkflowResult(stdout, null);
  assert.equal(r.confirmed, false, 'a CLI error must never be treated as confirmed');
  assert.equal(r.apiError, true);
});

test('parseWorkflowResult fails closed on a CLI error object', () => {
  const r = parseWorkflowResult('', new Error('budget exceeded'));
  assert.equal(r.confirmed, false);
  assert.equal(r.apiError, true);
});

test('parseWorkflowResult fails closed on unparseable stdout', () => {
  const r = parseWorkflowResult('not json at all', null);
  assert.equal(r.confirmed, false);
  assert.equal(r.apiError, true);
});

test('parseWorkflowResult: explicit unconfirmed stays unconfirmed', () => {
  const stdout = JSON.stringify({ is_error: false, structured_output: { confirmed: false, summary: 'blockers remain' } });
  const r = parseWorkflowResult(stdout, null);
  assert.equal(r.confirmed, false);
  assert.equal(r.apiError, false);
});

// --- useWorkflowBrain: gated on opt-in AND a workflow-capable fix provider ---

test('useWorkflowBrain requires USE_WORKFLOW=true', () => {
  assert.equal(useWorkflowBrain('high', {}), false);
  assert.equal(useWorkflowBrain('high', { USE_WORKFLOW: 'true' }), true); // claude default
});

test('useWorkflowBrain is false when the fix provider cannot host a workflow', () => {
  assert.equal(useWorkflowBrain('high', { USE_WORKFLOW: 'true', FIX_PROVIDER: 'codex' }), false);
  assert.equal(useWorkflowBrain('high', { USE_WORKFLOW: 'true', FIX_PROVIDER: 'kimi' }), false);
});
