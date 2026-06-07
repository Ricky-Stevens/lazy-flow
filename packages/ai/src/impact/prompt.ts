/**
 * Prompt definitions for Explainable Code-Change Impact — SPEC §9.2.7
 */

import { registerPrompt } from '../prompts/registry.js'
import { ImpactRationaleOutput } from './types.js'

export const IMPACT_PROMPT_VERSION = 'impact-v1'

export const IMPACT_SYSTEM_PROMPT = `\
You are a code-review assistant explaining why a code change has high or low blast radius.

You are given:
- The list of changed file paths
- Deterministic factor scores (editDiversity, halocNorm, fileCountNorm, changeEntropy, oldCodePct)
- The overall deterministic impact score

Rules:
- Your rationale MUST reference the ACTUAL changed paths provided.
- You explain the impact; you do NOT compute or change the score.
- Keep the rationale concise (1–2 sentences). Reference specific paths or path categories.
- Example: "touched src/auth/middleware.ts and 2 DB migrations; high blast radius due to auth + data layer changes"
- Do NOT invent paths, symbols, or files that are not in the provided list.
- Do NOT output a numeric score — the deterministic score is already computed.
`

export function buildImpactUserMessage(opts: {
  filePaths: string[]
  haloc: number
  impactScore: number
  factors: Record<string, number>
  weights: Record<string, number>
}): string {
  const paths = opts.filePaths.slice(0, 50).join('\n  ')
  const factorsStr = Object.entries(opts.factors)
    .map(([k, v]) => `  ${k}: ${v.toFixed(3)}`)
    .join('\n')
  const weightsStr = Object.entries(opts.weights)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n')

  return `\
## Changed paths (first 50)
  ${paths || '(none)'}

## HALOC
  ${opts.haloc}

## Deterministic factor scores
${factorsStr}

## Factor weights
${weightsStr}

## Overall impact score: ${opts.impactScore.toFixed(3)}

---
Write a 1–2 sentence rationale explaining WHY this change has this impact score.
Reference the ACTUAL changed paths above. Do not invent file names.
Return JSON: { rationale: "..." }
`
}

export const impactOutputSchema = ImpactRationaleOutput

// Register in the prompt registry (SPEC §9.3)
registerPrompt({
  insight: 'impact',
  version: IMPACT_PROMPT_VERSION,
  systemPrompt: IMPACT_SYSTEM_PROMPT,
  userPromptTemplate: (opts: unknown) =>
    buildImpactUserMessage(
      opts as {
        filePaths: string[]
        haloc: number
        impactScore: number
        factors: Record<string, number>
        weights: Record<string, number>
      },
    ),
})
