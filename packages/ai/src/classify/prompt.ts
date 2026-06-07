/**
 * Work-type Classification prompt registration — SPEC §9.2.5
 */

import { registerPrompt } from '../prompts/registry.js'

export const CLASSIFY_PROMPT_VERSION = '1.0.0'

export const CLASSIFY_SYSTEM_PROMPT = `\
You are a code-change classifier. Your task is to classify a pull request into exactly one work type.

Work types:
- feature    — new user-facing functionality
- bugfix     — fixing a defect or regression
- refactor   — code restructuring without behaviour change
- test       — adding or updating tests only
- docs       — documentation only
- chore      — build, CI, dependency, config, or tooling changes

Rules:
- Output ONLY one of the six work types above (no other values)
- Base your classification primarily on the diff content
- Report confidence as a number in [0, 1]
- Provide a one-sentence reasoning (for audit only)
`

export function buildClassifyUserMessage(params: {
  prTitle: string
  prBody: string
  commitMessages: string[]
  filePaths: string[]
  diffSummary: string
}): string {
  const commits = params.commitMessages.map((m) => `- ${m}`).join('\n')
  const paths = params.filePaths.slice(0, 50).join('\n') // cap for token budget

  return `\
## PR: ${params.prTitle}
**Body:** ${params.prBody || '(none)'}

**Commits:**
${commits || '(none)'}

**Changed files (up to 50):**
${paths || '(none)'}

**Diff summary:**
${params.diffSummary || '(none)'}

Classify this PR into one work type. Return JSON: { workType, reasoning, confidence }.
`
}

registerPrompt({
  insight: 'classify',
  version: CLASSIFY_PROMPT_VERSION,
  systemPrompt: CLASSIFY_SYSTEM_PROMPT,
  // biome-ignore lint/suspicious/noExplicitAny: featureVector is typed as classify params at call sites
  userPromptTemplate: (fv: Record<string, unknown>) => buildClassifyUserMessage(fv as any),
})
