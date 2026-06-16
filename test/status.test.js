import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatus, statusForStage, loopDecision, checkBudgetConfig, resolvePerIssueBudget, noCodeChangeAction } from '../src/dispatcher.js';
import { parseReviewVerdict } from '../src/agent.js';

// CRITIQUE #2: a passing fix with no PR must NOT be reported as success.
test('no PR is reported as no-pr, never success', () => {
  assert.equal(resolveStatus({ merged: false, needsHumanReview: false, prExists: false }), 'no-pr');
});

test('passing fix with an open PR is success', () => {
  assert.equal(resolveStatus({ merged: false, needsHumanReview: false, prExists: true }), 'success');
});

test('merged wins over everything', () => {
  assert.equal(resolveStatus({ merged: true, needsHumanReview: true, prExists: true }), 'merged');
});

test('unconfirmed fix flags human review (when a PR exists)', () => {
  assert.equal(resolveStatus({ merged: false, needsHumanReview: true, prExists: true }), 'needs-human-review');
});

test('failing CI blocks success', () => {
  assert.equal(resolveStatus({ merged: false, needsHumanReview: false, ciFailed: true, prExists: true }), 'ci-failed');
});

// C2: an issue that exhausts its per-issue budget is a distinct handoff cause.
test('over-budget reports over-budget, beating the generic human-review handoff', () => {
  assert.equal(resolveStatus({ merged: false, needsHumanReview: true, overBudget: true, prExists: true }), 'over-budget');
  // but a merge still wins (e.g. budget hit after a confirmed merge is moot)
  assert.equal(resolveStatus({ merged: true, overBudget: true, prExists: true }), 'merged');
});

test('statusForStage maps validation stages to terminal statuses', () => {
  assert.equal(statusForStage('tests-missing'), 'tests-missing');
  assert.equal(statusForStage('tests'), 'fix-tests-failed');
  assert.equal(statusForStage('lint'), 'lint-failed');
  assert.equal(statusForStage('ci'), 'ci-failed');
  assert.equal(statusForStage('error'), 'validation-error');
  assert.equal(statusForStage('something-unknown'), 'fix-tests-failed');
});

// A1: tests we couldn't validate are a human handoff, not a hard fail.
test('statusForStage maps tests-unvalidated to needs-human-review', () => {
  assert.equal(statusForStage('tests-unvalidated'), 'needs-human-review');
});

// A3: empty diff is a hard fail; a no-production-code diff is a human handoff.
test('statusForStage maps no-changes and no-code-change (A3)', () => {
  assert.equal(statusForStage('no-changes'), 'no-changes');
  assert.equal(statusForStage('no-code-change'), 'needs-human-review');
});

test('noCodeChangeAction: human-review by default, rework only when opted in', () => {
  assert.equal(noCodeChangeAction({}), 'human-review');
  assert.equal(noCodeChangeAction({ NO_CODE_CHANGE_ACTION: 'rework' }), 'rework');
  assert.equal(noCodeChangeAction({ NO_CODE_CHANGE_ACTION: 'human-review' }), 'human-review');
  assert.equal(noCodeChangeAction({ NO_CODE_CHANGE_ACTION: 'nonsense' }), 'human-review');
});

// --- fix→review loop decisions (ADR 0002) ---------------------------------

test('loopDecision: failed gates rework while iterations remain, else fail', () => {
  assert.equal(loopDecision({ validationPassed: false, blocking: false, iteration: 1, maxIterations: 3 }), 'rework-validation');
  assert.equal(loopDecision({ validationPassed: false, blocking: false, iteration: 3, maxIterations: 3 }), 'fail-validation');
});

test('loopDecision: passing gates + no blocking findings = confirmed', () => {
  assert.equal(loopDecision({ validationPassed: true, blocking: false, iteration: 1, maxIterations: 3 }), 'confirmed');
});

test('loopDecision: blocking findings rework while iterations remain, else unconfirmed', () => {
  assert.equal(loopDecision({ validationPassed: true, blocking: true, iteration: 2, maxIterations: 3 }), 'rework-review');
  assert.equal(loopDecision({ validationPassed: true, blocking: true, iteration: 3, maxIterations: 3 }), 'unconfirmed-blocking');
});

// --- budget config sanity check -------------------------------------------

test('resolvePerIssueBudget: explicit override wins, else ceiling/concurrency', () => {
  assert.equal(resolvePerIssueBudget(15, 3, { PER_ISSUE_BUDGET_USD: '5' }), 5);
  assert.equal(resolvePerIssueBudget(15, 3, {}), 5);
  assert.equal(resolvePerIssueBudget(15, 0, {}), 15); // guards against /0
});

test('checkBudgetConfig: errors when a per-issue budget exceeds the ceiling', () => {
  const r = checkBudgetConfig({ costCeiling: 5, perIssueBudget: 8, concurrency: 3 });
  assert.equal(r.level, 'error');
  assert.equal(r.effectiveConcurrency, 0);
});

test('checkBudgetConfig: errors on non-positive ceiling or budget', () => {
  assert.equal(checkBudgetConfig({ costCeiling: 0, perIssueBudget: 5, concurrency: 3 }).level, 'error');
  assert.equal(checkBudgetConfig({ costCeiling: 15, perIssueBudget: 0, concurrency: 3 }).level, 'error');
});

test('checkBudgetConfig: warns when budget×concurrency exceeds ceiling, capping concurrency', () => {
  const r = checkBudgetConfig({ costCeiling: 15, perIssueBudget: 10, concurrency: 3 });
  assert.equal(r.level, 'warn');
  assert.equal(r.effectiveConcurrency, 1); // floor(15/10)
});

test('checkBudgetConfig: ok at the boundary (default config)', () => {
  const r = checkBudgetConfig({ costCeiling: 15, perIssueBudget: 5, concurrency: 3 });
  assert.equal(r.level, 'ok');
  assert.equal(r.effectiveConcurrency, 3);
});

// --- review verdict parsing ------------------------------------------------

test('parseReviewVerdict honors an explicit VERDICT line', () => {
  assert.equal(parseReviewVerdict('all good\nVERDICT: PASS'), false);
  assert.equal(parseReviewVerdict('problems found\nVERDICT: CHANGES'), true);
});

test('parseReviewVerdict falls back to BLOCKING marker, ignoring non-blocking', () => {
  assert.equal(parseReviewVerdict('this is a BLOCKING bug'), true);
  assert.equal(parseReviewVerdict('only non-blocking nits here'), false);
  assert.equal(parseReviewVerdict('looks fine to me'), false);
});
