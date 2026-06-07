/**
 * Effort Proportionality prompt registration — SPEC §9.2.2, WP-AI-EFFORT
 */

import { registerPrompt } from '../prompts/registry.js'

export const EFFORT_PROMPT_VERSION = '1.0.0'

export const EFFORT_SYSTEM_PROMPT = `\
You are an engineering-process analyst evaluating whether the effort for a pull request is proportionate to team norms.

You are given:
- An effort vector (HALOC, files, commits, cycle time, review rounds, comments, rework commits)
- A log-ratio: how many standard deviations the HALOC is from the team mean (in log space)
- A cycle-time z-score: how many standard deviations the cycle time is from the team mean
- The ticket scope text for context

Rules:
- Output ONLY an ordinal band: much_lower, lower, as_expected, higher, much_higher
- Do NOT produce a raw number or a precise estimate
- Base your band on the log-ratio and cycle-time z-score as primary signals
- Report confidence as a number in [0, 1]
- Never evaluate individual developers — this is a team-scope metric
- If signals conflict, favour the more conservative (less extreme) band
`

/**
 * Builds the user message for the effort prompt.
 */
export function buildEffortUserMessage(params: {
  vector: {
    haloc: number
    files: number
    commits: number
    cycleTime: number
    reviewRounds: number
    comments: number
    reworkCommits: number
  }
  logRatio: number
  cycleTimeZScore: number
  issueSummary: string
  issueType: string
  storyPoints: number | null
}): string {
  const spLine =
    params.storyPoints != null ? `Story points: ${params.storyPoints}` : 'Story points: (not set)'
  return `\
## Effort Vector
- HALOC (canonical change units): ${params.vector.haloc}
- Files changed: ${params.vector.files}
- Commits: ${params.vector.commits}
- Cycle time: ${params.vector.cycleTime.toFixed(1)} hours
- Review rounds: ${params.vector.reviewRounds}
- Review comments: ${params.vector.comments}
- Rework commits: ${params.vector.reworkCommits}

## Deterministic Signals
- Log-ratio (HALOC vs team mean, std-dev units): ${params.logRatio.toFixed(3)}
- Cycle-time z-score: ${params.cycleTimeZScore.toFixed(3)}

## Ticket Context
- Issue type: ${params.issueType}
- Summary: ${params.issueSummary}
- ${spLine}

Based on the deterministic signals, output the effort band and your confidence.
`
}

registerPrompt({
  insight: 'effort',
  version: EFFORT_PROMPT_VERSION,
  systemPrompt: EFFORT_SYSTEM_PROMPT,
  // biome-ignore lint/suspicious/noExplicitAny: featureVector is typed as effort params at call sites
  userPromptTemplate: (fv: Record<string, unknown>) => buildEffortUserMessage(fv as any),
})
