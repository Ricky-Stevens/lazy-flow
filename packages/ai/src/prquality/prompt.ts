/**
 * Prompt definitions for PR Quality Score — SPEC §9.2.6
 */

import { registerPrompt } from '../prompts/registry.js'
import { PrQualityLlmOutput } from './types.js'

export const PRQUALITY_PROMPT_VERSION = 'prquality-v1'

export const PRQUALITY_SYSTEM_PROMPT = `\
You are a code-review assistant scoring the quality of a pull request description.

You score THREE dimensions, each on a 0–2 scale:
  0 = absent or missing
  1 = partial / present but incomplete
  2 = clear and substantive

Dimension definitions:
- explains_why: Does the PR body explain WHY the change is needed (motivation, context, business reason)?
  This is about substance, not writing style. A terse "fix null deref in auth middleware; caused 5xx on login"
  scores 2. A verbose but content-free paragraph scores 0. Non-English text is equally valid.
- matches_diff: Does the PR body accurately describe what the diff does?
  Mismatch (stale copy-paste, wrong scope) = 0. Accurate = 2.
- risk_flags: Does the description explicitly note high-blast-radius areas?
  (security changes, DB migrations, API contract changes, config changes, etc.)
  0 = no risks noted at all, 1 = risks mentioned but no mitigations, 2 = risks + mitigations documented.

Rules:
- Quote VERBATIM text from the PR body as evidence. If score=0, note what is missing.
- Base your score on SUBSTANCE (what the text communicates), not length or prose quality.
- Non-English, terse, or bullet-point descriptions are evaluated fairly.
- Return JSON matching: { explains_why, matches_diff, risk_flags } each with { score, evidence }.
`

export function buildPrQualityUserMessage(opts: {
  prTitle: string
  prBody: string
  diffSummary: string
  changedPaths: string[]
}): string {
  const paths = opts.changedPaths.slice(0, 30).join('\n  ')
  return `\
## Pull Request

**Title:** ${opts.prTitle}

**Body:**
${opts.prBody || '(empty)'}

## Changed paths (first 30)
  ${paths || '(none)'}

## Diff summary (first 2000 chars)
${opts.diffSummary.slice(0, 2000) || '(none)'}

---
Score the three dimensions: explains_why, matches_diff, risk_flags.
For each, provide a verbatim evidence quote and a score of 0, 1, or 2.
`
}

export const prQualityOutputSchema = PrQualityLlmOutput

// Register in the prompt registry (SPEC §9.3)
registerPrompt({
  insight: 'prquality',
  version: PRQUALITY_PROMPT_VERSION,
  systemPrompt: PRQUALITY_SYSTEM_PROMPT,
  userPromptTemplate: (opts: unknown) =>
    buildPrQualityUserMessage(
      opts as { prTitle: string; prBody: string; diffSummary: string; changedPaths: string[] },
    ),
})
