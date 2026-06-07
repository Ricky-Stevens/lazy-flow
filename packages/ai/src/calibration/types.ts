/**
 * Calibration harness types — WP-AI-CALIBRATION, SPEC §9.1 constraint 6 + §9.3
 *
 * Gold-set ingestion, agreement metrics (κ / macro-F1 / Spearman), confidence
 * calibration (ECE), and ensemble-eligibility gate.
 */

// ─── Gold set ─────────────────────────────────────────────────────────────────

/**
 * A single labelled example in the gold set.
 *
 * `humanLabel` is the ground-truth label for a given item.  When two or more
 * raters label the same item the array has ≥2 entries for that `subjectId`.
 */
export interface GoldItem {
  /** Stable subject identifier — must match the `subjectId` used in ai_verdicts. */
  subjectId: string
  /** Insight name — must match the `metric` field in ai_verdicts. */
  metric: string
  /**
   * Ground-truth label assigned by a human rater.
   * For ordinal / classification tasks: a string category (e.g. '0'–'4').
   * For rank tasks: numeric rank.
   */
  humanLabel: string
  /**
   * Who assigned this label (email or rater ID).
   * Multiple items with the same subjectId + metric but different raterIds
   * are used to compute human-vs-human agreement (the human ceiling).
   */
  raterId: string
}

/**
 * A correction record sourced from ai_verdicts (corrected_by / correction_json).
 * Ingested via `ingestCorrections()` and treated as ground-truth gold labels.
 */
export interface CorrectionRecord {
  id: string
  subjectId: string
  metric: string
  /** The human-supplied correction JSON (verbatim from correction_json column). */
  correctionJson: string
  /** Who corrected it. */
  correctedBy: string
}

// ─── Agreement metrics ────────────────────────────────────────────────────────

/** Result of a Cohen's κ computation between two label sequences. */
export interface KappaResult {
  /** Cohen's κ in [−1, 1]. */
  kappa: number
  /** Number of items used for computation. */
  n: number
}

/** Per-class precision / recall / F1. */
export interface ClassMetrics {
  label: string
  precision: number
  recall: number
  f1: number
  support: number
}

/** Macro-averaged F1 result. */
export interface MacroF1Result {
  /** Unweighted mean F1 across all classes present in the gold set. */
  macroF1: number
  /** Per-class breakdown. */
  perClass: ClassMetrics[]
}

/** Spearman rank-correlation result (tie-corrected). */
export interface SpearmanResult {
  /** ρ in [−1, 1]. */
  rho: number
  /** Number of paired observations. */
  n: number
}

// ─── Confidence calibration (ECE) ────────────────────────────────────────────

/** One bin of the reliability diagram. */
export interface ReliabilityBin {
  /** Midpoint of the confidence bucket. */
  midpoint: number
  /** Mean model confidence in this bin. */
  avgConfidence: number
  /** Fraction of items in this bin where the model was correct. */
  accuracy: number
  /** Number of items in this bin. */
  count: number
}

/** ECE computation result. */
export interface EceResult {
  /**
   * Expected Calibration Error — weighted mean |accuracy − confidence| across bins.
   * Lower is better; a perfectly calibrated model has ECE = 0.
   */
  ece: number
  /** Number of items used. */
  n: number
  /** Full reliability diagram for inspection. */
  bins: ReliabilityBin[]
}

// ─── Calibration report ───────────────────────────────────────────────────────

/** Agreement stats for a single insight metric. */
export interface InsightCalibration {
  metric: string
  /** Model-vs-gold Cohen's κ. */
  modelKappa: KappaResult
  /** Macro-F1 between model predictions and gold labels. */
  modelMacroF1: MacroF1Result
  /** Spearman ρ between model ranks and gold ranks. */
  modelSpearman: SpearmanResult
  /**
   * Human-vs-human κ when ≥2 raters are present for the same items.
   * null when only one rater is available.
   */
  humanCeilingKappa: KappaResult | null
  /** The effective pass gate: min(0.6, humanCeilingKappa.kappa) or 0.6 when no ceiling. */
  passGate: number
  /** Whether modelKappa.kappa ≥ passGate. */
  kappaPass: boolean
  /** Whether modelMacroF1.macroF1 ≥ 0.7. */
  macroF1Pass: boolean
  /** Confidence ECE result. null when no confidence data available. */
  ece: EceResult | null
  /** Whether confidence is calibrated (ECE ≤ threshold supplied to the harness). */
  confidenceCalibrated: boolean
}

/**
 * Full calibration report produced by `report()`.
 *
 * The ensemble-enablement flag (`ensembleEligible`) is false until ALL metrics
 * that appear in the gold set have `confidenceCalibrated = true`.  This
 * sequencing gate enforces SPEC §9.3 — the D8 ensemble must not be enabled
 * until confidence is proven calibrated.
 */
export interface CalibrationReport {
  /** ISO-8601 timestamp of this report. */
  generatedAt: string
  /** Per-insight calibration stats. */
  insights: InsightCalibration[]
  /**
   * True only when every insight with a gold set has `confidenceCalibrated = true`.
   * This is the hard gate for enabling the D8 ensemble.
   */
  ensembleEligible: boolean
}
