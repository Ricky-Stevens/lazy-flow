/**
 * Flow Distribution — Flow Group B (SPEC §8.2)
 *
 * Breaks down completed issues by type (feature / bug / debt / other)
 * using a deterministic prior (conventional commit / path patterns).
 *
 * SPEC §8.2: deterministic type/label prior; leave a hook for the later
 * LLM classifier.  This module implements the deterministic layer only.
 *
 * formulaDoc:
 *   Issues are classified by type field (Jira issue type) into buckets:
 *   feature / bug / debt / other.
 *   Distribution = count per bucket / total, for issues completed in window.
 *   LLM classifier hook: pass llmClassifications to override the deterministic prior.
 */

import type { MetricResult } from '@lazy-flow/core'
import { ENGINE_VERSION, safeRatio } from '@lazy-flow/core'
import type { MetricModule } from '../types.js'
import type { FlowIssueRecord } from './types.js'

export type FlowWorkType = 'feature' | 'bug' | 'debt' | 'other'

export interface FlowDistributionInputs {
  /** Issues completed in the window (pre-filtered by caller). */
  issues: readonly FlowIssueRecord[]
  /**
   * Optional LLM classification overrides (hook for Wave 5).
   * Maps issueId → FlowWorkType.  When present, overrides the deterministic prior.
   */
  llmClassifications?: Record<string, FlowWorkType>
}

export interface FlowDistributionBucket {
  type: FlowWorkType
  count: number
  ratio: number | null
}

export interface FlowDistributionResult extends MetricResult {
  readonly buckets: readonly FlowDistributionBucket[]
  readonly total: number
  readonly hasLlmClassifications: boolean
}

const FORMULA_DOC =
  'Flow Distribution (SPEC §8.2): ' +
  'Classify completed issues into feature/bug/debt/other buckets. ' +
  'Deterministic prior: Jira issue type field. ' +
  'LLM classifier hook: pass llmClassifications to override. ' +
  'Distribution = count/total per bucket.'

// ---------------------------------------------------------------------------
// Deterministic type classifier
// ---------------------------------------------------------------------------

const BUG_TYPES = new Set(['bug', 'defect', 'hotfix', 'incident', 'fix'])
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

export function classifyIssueType(issueType: string): FlowWorkType {
  const lower = issueType.toLowerCase()
  if (BUG_TYPES.has(lower)) return 'bug'
  if (DEBT_TYPES.has(lower)) return 'debt'
  if (FEATURE_TYPES.has(lower)) return 'feature'
  return 'other'
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const flowDistribution: MetricModule<FlowDistributionInputs, FlowDistributionResult> = {
  id: 'flow.flow_distribution',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf): FlowDistributionResult {
    const llm = inputs.llmClassifications ?? {}
    const hasLlmClassifications = Object.keys(llm).length > 0

    const counts: Record<FlowWorkType, number> = { feature: 0, bug: 0, debt: 0, other: 0 }

    for (const issue of inputs.issues) {
      const type = llm[issue.id] ?? classifyIssueType(issue.type)
      counts[type]++
    }

    const total = inputs.issues.length

    const buckets: FlowDistributionBucket[] = (
      Object.entries(counts) as [FlowWorkType, number][]
    ).map(([type, count]) => ({
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
