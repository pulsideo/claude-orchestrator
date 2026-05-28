import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatus, statusForStage } from '../src/dispatcher.js';

// CRITIQUE #2: a passing fix with no PR must NOT be reported as success.
test('no PR is reported as no-pr, never success', () => {
  assert.equal(resolveStatus({ merged: false, refinementReverted: false, prExists: false }), 'no-pr');
});

test('passing fix with an open PR is success', () => {
  assert.equal(resolveStatus({ merged: false, refinementReverted: false, prExists: true }), 'success');
});

test('merged wins over everything', () => {
  assert.equal(resolveStatus({ merged: true, refinementReverted: true, prExists: true }), 'merged');
});

test('reverted refinement flags human review (when a PR exists)', () => {
  assert.equal(resolveStatus({ merged: false, refinementReverted: true, prExists: true }), 'needs-human-review');
});

test('reverted refinement with no PR still surfaces no-pr over success', () => {
  // refinementReverted takes precedence as the stronger "human needed" signal,
  // but the key invariant is simply: this is never 'success'.
  assert.notEqual(resolveStatus({ merged: false, refinementReverted: true, prExists: false }), 'success');
});

test('failing CI blocks success', () => {
  assert.equal(resolveStatus({ merged: false, refinementReverted: false, ciFailed: true, prExists: true }), 'ci-failed');
});

test('statusForStage maps validation stages to terminal statuses', () => {
  assert.equal(statusForStage('tests-missing'), 'tests-missing');
  assert.equal(statusForStage('tests'), 'fix-tests-failed');
  assert.equal(statusForStage('lint'), 'lint-failed');
  assert.equal(statusForStage('ci'), 'ci-failed');
  assert.equal(statusForStage('error'), 'validation-error');
  assert.equal(statusForStage('something-unknown'), 'fix-tests-failed');
});
