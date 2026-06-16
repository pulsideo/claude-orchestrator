import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, parseProposedBugs, dedupeProposed } from '../src/discovery.js';

test('parseProposedBugs extracts a JSON array and validates entries', () => {
  const out = `Here is what I found:
  [
    {"title": "Null deref in parser", "body": "src/p.js:10", "severity": "high"},
    {"title": "  Leaky fd  ", "body": "", "severity": "BOGUS"},
    {"body": "no title - dropped", "severity": "low"}
  ]
  Done.`;
  const bugs = parseProposedBugs(out);
  assert.equal(bugs.length, 2);
  assert.deepEqual(bugs[0], { title: 'Null deref in parser', body: 'src/p.js:10', severity: 'high' });
  assert.equal(bugs[1].title, 'Leaky fd', 'title is trimmed');
  assert.equal(bugs[1].severity, 'medium', 'invalid severity defaults to medium');
});

test('parseProposedBugs returns [] when no array / invalid JSON', () => {
  assert.deepEqual(parseProposedBugs('no json here'), []);
  assert.deepEqual(parseProposedBugs('[not valid json}'), []);
  assert.deepEqual(parseProposedBugs(''), []);
});

test('normalizeTitle lowercases, trims, and collapses whitespace', () => {
  assert.equal(normalizeTitle('  Fix   the   Bug '), 'fix the bug');
});

test('dedupeProposed drops matches against open issues and duplicates', () => {
  const proposed = [
    { title: 'Fix the bug', severity: 'high' },
    { title: 'FIX THE BUG', severity: 'low' }, // dup of the first (normalized)
    { title: 'New thing', severity: 'medium' },
  ];
  const existing = ['Already filed', 'fix the bug']; // matches the first proposal
  const fresh = dedupeProposed(proposed, existing);
  assert.deepEqual(fresh.map(b => b.title), ['New thing']);
});

test('dedupeProposed enforces the cap', () => {
  const proposed = [
    { title: 'a', severity: 'low' },
    { title: 'b', severity: 'low' },
    { title: 'c', severity: 'low' },
  ];
  assert.equal(dedupeProposed(proposed, [], 2).length, 2);
});
