/**
 * AI engine constants (SPEC §9.3, D8)
 */

/** Default high-volume model. Never sends temperature to opus ids. */
export const DEFAULT_MODEL = 'claude-sonnet-4-6' as const

/** Ensemble escalation model. Opus ids must NOT receive sampling params. */
export const ENSEMBLE_MODEL = 'claude-opus-4-8' as const
