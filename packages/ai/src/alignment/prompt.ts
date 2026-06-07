/**
 * Alignment prompt registration — SPEC §9.2.1, WP-AI-ALIGNMENT
 *
 * Registers the versioned alignment prompt in the shared registry.
 * Uses zodOutputFormat-compatible schema (constrained decoding §9.1.4).
 */

import { registerPrompt } from '../prompts/registry.js'
import { AlignmentLlmOutput } from './types.js'

export const ALIGNMENT_PROMPT_VERSION = '1.0.0'

export const ALIGNMENT_SYSTEM_PROMPT = `\
You are a precise code-review assistant evaluating whether a pull request covers the acceptance criteria of its linked ticket.

Rules:
- Judge EACH criterion independently (pointwise — no pairwise comparison).
- "covered: yes" REQUIRES a verbatim quoted snippet from the diff that directly addresses the criterion.
- If you cannot find a directly relevant diff snippet, use "covered: unclear" or "covered: no".
- Quote ONLY text that appears in the provided diff hunks. Do not fabricate or paraphrase.
- Use "covered: unclear" for vague criteria or when evidence is ambiguous.
- Your ordinal band reflects the overall alignment: 0=none, 1=minimal, 2=partial, 3=mostly, 4=fully covered.
- Report confidence as a number in [0, 1].
`

/**
 * Builds the user message for the alignment prompt from a feature pack.
 * Formats criteria and ranked diff hunks for the LLM.
 */
export function buildAlignmentUserMessage(pack: {
  issueKey: string
  issueType: string
  issueSummary: string
  issueDescription: string
  criteria: Array<{ index: number; text: string }>
  prTitle: string
  prBody: string
  commitMessages: string[]
  diffHunks: Array<{ filePath: string; content: string; relevanceScore: number }>
}): string {
  const criteriaBlock = pack.criteria.map((c) => `[${c.index}] ${c.text}`).join('\n')

  const hunksBlock = pack.diffHunks
    .map((h) => `--- ${h.filePath} (relevance=${h.relevanceScore.toFixed(3)})\n${h.content}`)
    .join('\n\n')

  const commits = pack.commitMessages.map((m) => `- ${m}`).join('\n')

  return `\
## Ticket: ${pack.issueKey} (${pack.issueType})
**Summary:** ${pack.issueSummary}

**Description:**
${pack.issueDescription}

## Acceptance Criteria
${criteriaBlock || '(none provided)'}

## Pull Request: ${pack.prTitle}
**Body:**
${pack.prBody || '(none)'}

**Commits:**
${commits || '(none)'}

## Diff Hunks (relevance-ranked)
${hunksBlock || '(no diff)'}

---
For EACH acceptance criterion above, output whether it is covered by the diff.
Return your answer as JSON matching the schema: { ordinal, criteria: [{index, covered, evidence}], confidence }.
`
}

// ---------------------------------------------------------------------------
// Schema for constrained decoding
// ---------------------------------------------------------------------------

/** Zod schema for the alignment LLM output (registered with constrained decoding). */
export const alignmentOutputSchema = AlignmentLlmOutput

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerPrompt({
  insight: 'alignment',
  version: ALIGNMENT_PROMPT_VERSION,
  systemPrompt: ALIGNMENT_SYSTEM_PROMPT,
  // biome-ignore lint/suspicious/noExplicitAny: featureVector is typed as AlignmentFeaturePack at call sites
  userPromptTemplate: (fv: Record<string, unknown>) => buildAlignmentUserMessage(fv as any),
})
