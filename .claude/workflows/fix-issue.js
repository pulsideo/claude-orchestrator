export const meta = {
  name: 'fix-issue',
  description: 'Fix one GitHub issue: triage → fix → converge with adversarial review',
  phases: [
    { title: 'Triage', detail: 'analyze root cause (read-only)' },
    { title: 'Fix', detail: 'implement the initial fix' },
    { title: 'Verify', detail: 'adversarial review → rework, until clean or caps hit' },
  ],
}

// The orchestrator passes args as the trailing text of the slash command, which
// arrives as a STRING — parse it. (Verified headless contract, see project memory.)
const a = typeof args === 'string' ? JSON.parse(args) : (args || {})
const {
  issueNumber,
  maxIterations = 3,
  tokenBudget = null,
  models = {},
  triagePrompt,
  fixPrompt,
  reviewPrompt,
  reworkPrompt,
} = a

// Independent review lenses for the adversarial pass. Each tries to find a real
// BLOCKING defect; a fix is confirmed only when none of them do (fails CLOSED,
// unlike the hand-rolled path's silent-reviewer = non-blocking default).
const LENSES = ['correctness', 'security', 'missing-tests-or-edge-cases']

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['blocking', 'reasons'],
  properties: {
    blocking: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
}

// In-workflow token backstop (defense in depth on top of the harness's
// --max-budget-usd). `budget.total` is null headlessly, but budget.spent() is
// still available.
function overTokenBudget() {
  return tokenBudget && typeof budget !== 'undefined' && budget.spent() > tokenBudget
}

// --- Triage (advisory analysis, read-only) ---------------------------------
phase('Triage')
const analysis = await agent(triagePrompt, {
  label: `triage:#${issueNumber}`, phase: 'Triage', model: models.triage,
})

// --- Initial fix -----------------------------------------------------------
phase('Fix')
await agent(fixPrompt.replaceAll('{{triageAnalysis}}', String(analysis)), {
  label: `fix:#${issueNumber}`, phase: 'Fix', model: models.fix,
})

// --- Converge: adversarial review → rework, until clean or caps hit --------
phase('Verify')
let confirmed = false
let iterations = 0
const findings = []

for (let i = 1; i <= maxIterations; i++) {
  iterations = i

  // Capture the current branch diff for review (sub-agent runs git in the worktree).
  const diff = await agent(
    'Run `git --no-pager diff origin/main...HEAD` and output ONLY the raw diff, no commentary.',
    { label: `diff:#${issueNumber}`, phase: 'Verify', model: models.review },
  )
  const reviewBase = reviewPrompt.replaceAll('{{diff}}', String(diff).slice(0, 60000))

  // Adversarial review: independent lenses run concurrently, each returns a
  // structured verdict (no regex parsing of prose).
  const verdicts = await parallel(LENSES.map(lens => () =>
    agent(
      `${reviewBase}\n\n## Lens\nReview specifically through the **${lens}** lens. ` +
      'Mark blocking=true ONLY for a concrete, real defect that must be fixed before merge. ' +
      'If you cannot identify a concrete defect, return blocking=false.',
      { label: `review:${lens}:#${issueNumber}`, phase: 'Verify', model: models.review, schema: VERDICT_SCHEMA },
    ),
  ))

  const blockers = verdicts.filter(Boolean).filter(v => v.blocking)
  if (blockers.length === 0) { confirmed = true; break }

  const reasons = blockers.flatMap(v => v.reasons || [])
  findings.push(...reasons)

  // Out of iterations or token budget → leave unconfirmed for the human.
  if (i === maxIterations || overTokenBudget()) break

  // Rework to address every blocking finding, then loop to re-review.
  await agent(
    reworkPrompt.replaceAll('{{feedback}}', reasons.map(r => `- ${r}`).join('\n')),
    { label: `rework:#${issueNumber}`, phase: 'Verify', model: models.fix },
  )
}

// Advisory file list for the harness summary.
const filesRaw = await agent(
  'Run `git --no-pager diff --name-only origin/main...HEAD` and output ONLY the file list.',
  { label: `files:#${issueNumber}`, phase: 'Verify', model: models.review },
).catch(() => '')

return {
  confirmed,
  iterations,
  summary: confirmed
    ? `Confirmed after ${iterations} iteration(s); adversarial review found no blocking findings.`
    : `Unconfirmed after ${iterations} iteration(s); ${findings.length} blocking finding(s) remain.`,
  findings: findings.slice(0, 20),
  filesChanged: String(filesRaw).split('\n').map(s => s.trim()).filter(Boolean).slice(0, 50),
}
