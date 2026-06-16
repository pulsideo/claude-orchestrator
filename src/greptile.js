import { execSync } from 'child_process';
import { parseReviewVerdict } from './agent.js';

const GREPTILE_API_BASE = 'https://api.greptile.com/v2';

const {
  GREPTILE_API_KEY,
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
} = process.env;

/**
 * Review a diff against the indexed codebase using Greptile's query API.
 * Returns `{ blocking, comments }` — `blocking` comes from an explicit verdict in
 * the model's reply, NOT from whether it produced any prose (a "looks good"
 * summary is still text). `comments` carry the prose/sources for the rework
 * prompt. An empty diff is non-blocking with nothing to say.
 */
export async function reviewWithGreptile(worktreeDir) {
  if (!GREPTILE_API_KEY) {
    throw new Error('GREPTILE_API_KEY is not set');
  }

  const diff = getDiff(worktreeDir);
  if (!diff) {
    return { blocking: false, comments: [] };
  }

  const response = await fetch(`${GREPTILE_API_BASE}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GREPTILE_API_KEY}`,
      'X-GitHub-Token': GITHUB_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: `Review the following code changes. Focus on:
- Bugs or correctness issues
- Missing error handling or edge cases
- Security concerns
- Performance problems

Be specific: reference file paths and line numbers when possible. Skip purely stylistic feedback.

End your reply with a verdict line on its own: \`VERDICT: CHANGES_REQUESTED\` if there are blocking issues that must be fixed before merge, or \`VERDICT: PASS\` if the change is correct and complete.

\`\`\`diff
${diff}
\`\`\``,
        },
      ],
      repositories: [
        { remote: 'github', repository: `${GITHUB_OWNER}/${GITHUB_REPO}`, branch: 'main' },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Greptile API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return interpretGreptileResponse(data);
}

/**
 * Interpret a Greptile response into `{ blocking, comments }`. Pure, so the
 * verdict logic is testable without a live API call. `blocking` is decided by
 * the verdict in the reply (shared with the review agent via parseReviewVerdict),
 * never by mere presence of text — otherwise any "looks good" summary would read
 * as changes-requested and the loop could never confirm a clean fix.
 */
export function interpretGreptileResponse(data) {
  return {
    blocking: parseReviewVerdict(data?.message || ''),
    comments: formatGreptileResponse(data),
  };
}

export function getDiff(worktreeDir) {
  try {
    // Committed changes vs origin/main
    const committed = execSync('git diff origin/main...HEAD', {
      cwd: worktreeDir,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    });
    // Plus any staged but uncommitted changes
    const staged = execSync('git diff --cached', {
      cwd: worktreeDir,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    });
    return [committed, staged].filter(Boolean).join('\n').trim();
  } catch {
    return '';
  }
}

/**
 * Convert Greptile's response into the comment format the refinement agent expects:
 *   { type: 'summary' | 'inline', body, path?, line? }
 */
function formatGreptileResponse(data) {
  const comments = [];

  // Greptile returns { message, sources }
  if (data.message) {
    comments.push({ type: 'summary', body: data.message });
  }

  // If Greptile provides source references, include them as inline context
  if (Array.isArray(data.sources)) {
    for (const source of data.sources) {
      if (source.filepath && source.summary) {
        comments.push({
          type: 'inline',
          path: source.filepath,
          line: source.linestart || null,
          body: source.summary,
        });
      }
    }
  }

  return comments;
}
