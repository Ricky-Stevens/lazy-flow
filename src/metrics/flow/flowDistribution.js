import { ENGINE_VERSION, safeRatio } from '../../core/index.js'
import { BUG_TYPES } from '../shared/bugTypes.js'

const FORMULA_DOC =
  'Flow Distribution (SPEC §8.2): ' +
  'Classify completed issues into feature/bug/debt/other buckets from the Jira ' +
  'issue type field (deterministic). Distribution = count/total per bucket. ' +
  '(Reserved extension point: an `llmClassifications` map keyed by issue id may ' +
  'override the deterministic call per-issue — no production caller wires it ' +
  'today; semantic skill-domain classification is a separate, unbuilt layer.)'

// ---------------------------------------------------------------------------
// Deterministic type classifier
// ---------------------------------------------------------------------------

const DEBT_TYPES = new Set(['technical debt', 'tech debt', 'debt', 'refactor', 'chore', 'task'])
const FEATURE_TYPES = new Set([
  'story',
  'feature',
  'epic',
  'improvement',
  'enhancement',
  'user story',
  'new feature',
])

export function classifyIssueType(issueType) {
  const lower = issueType.toLowerCase()
  if (BUG_TYPES.has(lower)) return 'bug'
  if (DEBT_TYPES.has(lower)) return 'debt'
  if (FEATURE_TYPES.has(lower)) return 'feature'
  return 'other'
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const flowDistribution = {
  id: 'flow.flow_distribution',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const llm = inputs.llmClassifications ?? {}
    const hasLlmClassifications = Object.keys(llm).length > 0

    const counts = { feature: 0, bug: 0, debt: 0, other: 0 }

    for (const issue of inputs.issues) {
      const type = llm[issue.id] ?? classifyIssueType(issue.type)
      counts[type]++
    }

    const total = inputs.issues.length

    const buckets = Object.entries(counts).map(([type, count]) => ({
      type,
      count,
      ratio: safeRatio(count, total),
    }))

    return {
      id: 'flow.flow_distribution',
      trustTier: 'deterministic',
      scope: 'team',
      value: total,
      unit: 'issues',
      dataQuality: total === 0 ? 'no_data' : 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      buckets,
      total,
      hasLlmClassifications,
    }
  },
}
