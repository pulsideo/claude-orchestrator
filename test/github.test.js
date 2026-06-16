import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityScore, getSeverity, parseFailedTests, isVitestReport } from '../src/github.js';

const issue = (...labels) => ({ labels: labels.map(name => ({ name })) });

test('severityScore orders critical < high < medium < low < unlabeled', () => {
  assert.ok(severityScore(issue('critical')) < severityScore(issue('high')));
  assert.ok(severityScore(issue('high')) < severityScore(issue('medium')));
  assert.ok(severityScore(issue('medium')) < severityScore(issue('low')));
  assert.ok(severityScore(issue('low')) < severityScore(issue('bug')));
});

test('severityScore takes the highest severity when multiple labels present', () => {
  assert.equal(severityScore(issue('low', 'critical')), severityScore(issue('critical')));
});

test('getSeverity returns the label name, defaulting to medium', () => {
  assert.equal(getSeverity(issue('high')), 'high');
  assert.equal(getSeverity(issue('bug')), 'medium');
  assert.equal(getSeverity(issue()), 'medium');
});

test('getSeverity handles string labels as well as objects', () => {
  assert.equal(getSeverity({ labels: ['critical'] }), 'critical');
});

test('parseFailedTests extracts failed assertion names', () => {
  const json = JSON.stringify({
    testResults: [
      { assertionResults: [
        { status: 'passed', fullName: 'a' },
        { status: 'failed', fullName: 'b should work' },
      ] },
    ],
  });
  assert.deepEqual(parseFailedTests(json), ['b should work']);
});

test('parseFailedTests returns [] on non-JSON', () => {
  assert.deepEqual(parseFailedTests('garbage'), []);
});

test('isVitestReport distinguishes a real report from a crash', () => {
  // A real run (even with zero failures) is a report.
  assert.equal(isVitestReport(JSON.stringify({ testResults: [] })), true);
  assert.equal(isVitestReport(JSON.stringify({ testResults: [{ assertionResults: [] }] })), true);
  // A crash before tests run: empty output, non-JSON, or JSON without testResults.
  assert.equal(isVitestReport(''), false);
  assert.equal(isVitestReport('Failed to resolve entry for package "@x/y"'), false);
  assert.equal(isVitestReport(JSON.stringify({ error: 'boom' })), false);
});
