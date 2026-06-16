import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretGreptileResponse } from '../src/greptile.js';

// Finding #4: blocking must come from the verdict, not from the presence of any
// prose. The old code treated any message as a blocking comment, so a "looks
// good" reply read as changes-requested and the loop could never confirm.

test('an explicit PASS verdict is non-blocking even though prose is present', () => {
  const { blocking, comments } = interpretGreptileResponse({
    message: 'The change looks correct and complete.\nVERDICT: PASS',
  });
  assert.equal(blocking, false);
  // prose is still surfaced (as a summary) for context, just not treated as blocking
  assert.ok(comments.some(c => c.type === 'summary'));
});

test('an explicit CHANGES_REQUESTED verdict is blocking', () => {
  const { blocking } = interpretGreptileResponse({
    message: 'Null deref on line 12.\nVERDICT: CHANGES_REQUESTED',
  });
  assert.equal(blocking, true);
});

test('positive prose with no verdict is NOT blocking (the core regression)', () => {
  assert.equal(interpretGreptileResponse({ message: 'Looks good to me, nice fix.' }).blocking, false);
  assert.equal(interpretGreptileResponse({ message: 'No issues found.' }).blocking, false);
});

test('a BLOCKING marker still blocks when no verdict line is present', () => {
  assert.equal(interpretGreptileResponse({ message: 'This is a BLOCKING correctness bug.' }).blocking, true);
});

test('source references become inline comments', () => {
  const { comments } = interpretGreptileResponse({
    message: 'See below.\nVERDICT: PASS',
    sources: [{ filepath: 'src/x.js', linestart: 7, summary: 'context here' }],
  });
  assert.ok(comments.some(c => c.type === 'inline' && c.path === 'src/x.js' && c.line === 7));
});

test('an empty/blank response is non-blocking with no comments', () => {
  assert.deepEqual(interpretGreptileResponse({}), { blocking: false, comments: [] });
  assert.deepEqual(interpretGreptileResponse({ message: '' }), { blocking: false, comments: [] });
});
