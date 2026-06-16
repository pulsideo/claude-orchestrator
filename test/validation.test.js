import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTestFile,
  classifyChangedFiles,
  requireTests,
  detectLintCommand,
  detectTestRunner,
  summarizeChecks,
} from '../src/github.js';

test('isTestFile recognizes test suffixes and test directories', () => {
  assert.ok(isTestFile('src/foo.test.ts'));
  assert.ok(isTestFile('src/foo.spec.jsx'));
  assert.ok(isTestFile('src/__tests__/foo.ts'));
  assert.ok(isTestFile('test/foo.js'));
  assert.ok(isTestFile('tests/foo.js'));
  assert.ok(!isTestFile('src/foo.ts'));
  assert.ok(!isTestFile('README.md'));
});

test('classifyChangedFiles splits code vs tests and ignores non-code', () => {
  const { code, tests } = classifyChangedFiles([
    'src/app.ts', 'src/app.test.ts', 'README.md', 'src/util.js', 'docs/x.png',
  ]);
  assert.deepEqual(code, ['src/app.ts', 'src/util.js']);
  assert.deepEqual(tests, ['src/app.test.ts']);
});

// #6: other languages can opt in via CODE_FILE_EXTENSIONS so their fixes aren't
// mislabeled 'no-code-change', with test-naming conventions recognized too.
test('classifyChangedFiles honors CODE_FILE_EXTENSIONS (Python)', () => {
  const { code, tests } = classifyChangedFiles(
    ['app.py', 'test_app.py', 'pkg/foo.py', 'main.go', 'README.md'],
    { CODE_FILE_EXTENSIONS: 'py' },
  );
  assert.deepEqual(code, ['app.py', 'pkg/foo.py']);
  assert.deepEqual(tests, ['test_app.py']); // test_ prefix; .go/.md ignored (not py)
});

test('classifyChangedFiles honors CODE_FILE_EXTENSIONS (Go, _test suffix)', () => {
  const { code, tests } = classifyChangedFiles(
    ['main.go', 'main_test.go', 'app.js'],
    { CODE_FILE_EXTENSIONS: 'go' },
  );
  assert.deepEqual(code, ['main.go']);
  assert.deepEqual(tests, ['main_test.go']); // app.js ignored (not go)
});

test('isTestFile recognizes per-language conventions under a configured ext', () => {
  const env = { CODE_FILE_EXTENSIONS: 'py' };
  assert.ok(isTestFile('test_foo.py', env));
  assert.ok(isTestFile('pkg/tests/foo.py', env)); // test directory
  assert.ok(!isTestFile('foo.py', env));
});

test('requireTests defaults on, disabled only by explicit false', () => {
  assert.equal(requireTests({}), true);
  assert.equal(requireTests({ REQUIRE_TESTS: 'true' }), true);
  assert.equal(requireTests({ REQUIRE_TESTS: 'false' }), false);
});

test('detectLintCommand: env override > lint script > none', () => {
  const d = mkdtempSync(join(tmpdir(), 'orch-lint-'));
  try {
    // env override wins even with no package.json
    assert.equal(detectLintCommand(d, { LINT_COMMAND: 'eslint .' }), 'eslint .');

    // lint script present, no lockfile → npm run lint
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint' } }));
    assert.equal(detectLintCommand(d, {}), 'npm run lint');

    // no lint script → null
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    assert.equal(detectLintCommand(d, {}), null);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('detectTestRunner: vitest/jest get JSON related-tests, script falls back, none = null (A1)', () => {
  const d = mkdtempSync(join(tmpdir(), 'orch-runner-'));
  try {
    // TEST_COMMAND overrides everything, even with no package.json
    assert.deepEqual(detectTestRunner(d, { TEST_COMMAND: 'make test' }), { kind: 'custom', parse: false });

    // no package.json → null (fail closed, caller hands to human)
    assert.equal(detectTestRunner(d, {}), null);

    // vitest dep → parseable JSON runner
    writeFileSync(join(d, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1' } }));
    assert.deepEqual(detectTestRunner(d, {}), { kind: 'vitest', parse: true });

    // jest dep → parseable JSON runner
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { jest: '^29' } }));
    assert.deepEqual(detectTestRunner(d, {}), { kind: 'jest', parse: true });

    // no known runner but a test script → whole-suite, exit-code mode
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'mocha' } }));
    assert.deepEqual(detectTestRunner(d, {}), { kind: 'script', parse: false });

    // a package.json with neither a known runner nor a test script → null
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    assert.equal(detectTestRunner(d, {}), null);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('summarizeChecks: pending when any check is unfinished', () => {
  const s = summarizeChecks([
    { status: 'completed', conclusion: 'success' },
    { status: 'in_progress' },
  ]);
  assert.equal(s.state, 'pending');
  assert.equal(s.pending, 1);
});

test('summarizeChecks: failed when any completed check did not pass', () => {
  const s = summarizeChecks([
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'failure' },
  ]);
  assert.equal(s.state, 'failed');
  assert.equal(s.failed, 1);
});

test('summarizeChecks: neutral/skipped count as passing', () => {
  const s = summarizeChecks([
    { status: 'completed', conclusion: 'neutral' },
    { status: 'completed', conclusion: 'skipped' },
  ]);
  assert.equal(s.state, 'passed');
});

test('summarizeChecks: empty set is passed (no CI configured)', () => {
  assert.equal(summarizeChecks([]).state, 'passed');
});
