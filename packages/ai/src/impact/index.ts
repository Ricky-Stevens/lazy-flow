/**
 * @lazy-flow/ai — impact module public API (SPEC §9.2.7)
 */

export {
  buildImpactUserMessage,
  IMPACT_PROMPT_VERSION,
  IMPACT_SYSTEM_PROMPT,
  impactOutputSchema,
} from './prompt.js'
export type { RunImpactOptions } from './runImpact.js'
export { runImpact } from './runImpact.js'
export type { ImpactResult } from './types.js'
export { ImpactRationaleOutput } from './types.js'
