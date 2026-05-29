import { runDiscoveryAgent } from './agent.js';
import { createIssue, fetchOpenIssueTitles } from './github.js';

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

/** Normalize a title for dedup comparison. */
export function normalizeTitle(title) {
  return (title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Parse the discovery agent's output into validated bug proposals. Tolerant of
 * surrounding prose: extracts the first JSON array. Drops entries without a
 * title; defaults unknown/missing severity to 'medium'.
 */
export function parseProposedBugs(output) {
  const match = (output || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr;
  try { arr = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(b => b && typeof b.title === 'string' && b.title.trim())
    .map(b => ({
      title: b.title.trim(),
      body: typeof b.body === 'string' ? b.body : '',
      severity: SEVERITIES.has(String(b.severity).toLowerCase()) ? String(b.severity).toLowerCase() : 'medium',
    }));
}

/**
 * Drop proposals that match an already-open issue (by normalized title) or each
 * other, then cap the count. Pure.
 */
export function dedupeProposed(proposed, existingTitles, cap = Infinity) {
  const seen = new Set(existingTitles.map(normalizeTitle));
  const out = [];
  for (const bug of proposed) {
    const key = normalizeTitle(bug.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bug);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Discovery phase: scan the target repo, dedup against open issues, and file up
 * to DISCOVERY_MAX new issues with agent-assigned severity (ADR 0001).
 */
export async function runDiscovery(owner, repo, repoPath, env = process.env) {
  const scope = env.DISCOVERY_SCOPE || 'the whole codebase';
  const cap = Math.max(1, parseInt(env.DISCOVERY_MAX || '5', 10) || 5);

  console.log(`[DISCOVERY] Scanning ${scope} (cap ${cap})...`);
  // Fetch open-issue titles first so the agent can avoid re-proposing tracked
  // bugs (semantic dedup); the same list is the title-match dedup backstop.
  const existing = await fetchOpenIssueTitles(owner, repo);
  const result = await runDiscoveryAgent(scope, repoPath, existing);
  const proposed = parseProposedBugs(result.output);
  if (proposed.length === 0) {
    console.log('[DISCOVERY] No bugs proposed.');
    return { filed: [], cost: result.cost };
  }

  const fresh = dedupeProposed(proposed, existing, cap);
  console.log(`[DISCOVERY] ${proposed.length} proposed, ${fresh.length} new after dedup/cap.`);

  const filed = [];
  for (const bug of fresh) {
    try {
      const issue = await createIssue(owner, repo, {
        title: bug.title,
        body: `${bug.body}\n\n_Filed automatically by the discovery agent._`,
        labels: [bug.severity],
      });
      console.log(`[DISCOVERY] Filed #${issue.number} [${bug.severity}] ${bug.title}`);
      filed.push(issue.number);
    } catch (err) {
      console.warn(`[DISCOVERY] Failed to file '${bug.title}': ${err.message}`);
    }
  }
  return { filed, cost: result.cost };
}
