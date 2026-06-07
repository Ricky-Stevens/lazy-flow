/**
 * Prompt definitions for Velocity Anomaly Explanation — SPEC §9.2.3
 */

import { registerPrompt } from '../prompts/registry.js'
import type { AnomalySignalPack } from './types.js'
import { AnomalyLlmOutput } from './types.js'

export const ANOMALY_PROMPT_VERSION = 'anomaly-v1'

export const ANOMALY_SYSTEM_PROMPT = `\
You are an engineering-process analyst explaining a velocity anomaly to a team.

You are given a signal pack of systemic process indicators from the anomaly window.

Rules:
- Rank ONLY the candidate causes from the closed menu provided.
- Every ranked cause MUST include an evidence_pointer naming the specific signal-pack field that supports it.
- If the signals are too weak or ambiguous to rank causes, emit a single entry with cause='insufficient_signal'.
- NEVER attribute causes to an individual person, developer, or reviewer by name.
- Phrase the summary as "consistent with", never "caused by" or "proves" or "was caused by".
- Base rankings ONLY on the signal-pack values provided. Do not invent signals.
- Output confidence as a number in [0, 1] for each cause.
`

export function buildAnomalyUserMessage(pack: AnomalySignalPack): string {
  return `\
## Signal Pack (anomaly window)

- avgWip: ${pack.avgWip.toFixed(1)} items
- reviewerLatencyHours: ${pack.reviewerLatencyHours.toFixed(1)} h
- blockedCount: ${pack.blockedCount} issues
- ticketChurnCount: ${pack.ticketChurnCount} re-opens / AC edits
- teamSizeDelta: ${pack.teamSizeDelta >= 0 ? '+' : ''}${pack.teamSizeDelta} members
- largePrShare: ${(pack.largePrShare * 100).toFixed(1)}%
- incidentCount: ${pack.incidentCount}
- dependencyWaitHours: ${pack.dependencyWaitHours.toFixed(1)} h
- throughputZScore: ${pack.throughputZScore !== null ? pack.throughputZScore.toFixed(2) : 'n/a'}
- cycleTimeZScore: ${pack.cycleTimeZScore !== null ? pack.cycleTimeZScore.toFixed(2) : 'n/a'}

## Candidate causes (closed menu — pick ONLY from this list)
- high_wip         → evidence_pointer: "avgWip"
- reviewer_latency → evidence_pointer: "reviewerLatencyHours"
- blocked_issues   → evidence_pointer: "blockedCount"
- ticket_churn     → evidence_pointer: "ticketChurnCount"
- team_size_change → evidence_pointer: "teamSizeDelta"
- large_pr_overhead→ evidence_pointer: "largePrShare"
- incident_response→ evidence_pointer: "incidentCount"
- dependency_wait  → evidence_pointer: "dependencyWaitHours"
- insufficient_signal → use when signals are too weak to rank

Rank the candidate causes from most-likely to least-likely, with a confidence and evidence_pointer per cause.
If signals are insufficient, return a single entry with cause='insufficient_signal', confidence=0, evidence_pointer='(none)'.

Return JSON matching: { ranked_causes: [{cause, confidence, evidence_pointer}], summary }
`
}

export const anomalyOutputSchema = AnomalyLlmOutput

// Register in the prompt registry (SPEC §9.3)
registerPrompt({
  insight: 'anomaly',
  version: ANOMALY_PROMPT_VERSION,
  systemPrompt: ANOMALY_SYSTEM_PROMPT,
  userPromptTemplate: (pack: unknown) => buildAnomalyUserMessage(pack as AnomalySignalPack),
})
