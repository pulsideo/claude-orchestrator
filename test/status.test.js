import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatus, statusForStage, loopDecision } from '../src/dispatcher.js';
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

test('statusForStage maps validation stages to terminal statuses', () => {
  assert.equal(statusForStage('tests-missing'), 'tests-missing');
  assert.equal(statusForStage('tests'), 'fix-tests-failed');
  assert.equal(statusForStage('lint'), 'lint-failed');
  assert.equal(statusForStage('ci'), 'ci-failed');
  assert.equal(statusForStage('error'), 'validation-error');
  assert.equal(statusForStage('something-unknown'), 'fix-tests-failed');
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
