/**
 * Gold-set ingestion — WP-AI-CALIBRATION
 *
 * Two sources of ground truth:
 *   1. Static gold-set files / in-memory GoldItem arrays (per-team labelled examples)
 *   2. `correctVerdict` corrections pulled from ai_verdicts (append-only write path)
 *      — each human correction is ground truth and is treated as a gold label.
 *
 * The merged result feeds the calibration report.
 */

import type { AiVerdict, Store } from '@lazy-flow/core'
import type { CorrectionRecord, GoldItem } from './types.js'

// ─── Correction ingestion ─────────────────────────────────────────────────────

/**
 * Pull all corrected ai_verdicts rows from the store and convert them to
 * CorrectionRecord objects for downstream ingestion.
 *
 * A row qualifies when `corrected_by` is non-null.
 *
 * NOTE: NodeSqliteStore doesn't yet expose a `listAiVerdicts()` method, so we
 * accept an explicit array of AiVerdict rows here; callers are responsible for
 * loading them (e.g. via a custom query or by passing all known verdicts).
 */
export function extractCorrections(verdicts: readonly AiVerdict[]): CorrectionRecord[] {
  return verdicts
    .filter((v): v is AiVerdict & { correctedBy: string; correctionJson: string } => {
      return v.correctedBy !== null && v.correctionJson !== null
    })
    .map((v) => ({
      id: v.id,
      subjectId: v.subjectId,
      metric: v.metric,
      correctionJson: v.correctionJson,
      correctedBy: v.correctedBy,
    }))
}

/**
 * Convert CorrectionRecord objects into GoldItem entries so they can be merged
 * with the static gold set.
 *
 * The correction JSON is expected to contain a `label` field (string).  When
 * absent the record is skipped (corrections without a parseable label cannot
 * contribute a gold label).
 *
 * The `raterId` is set to the `correctedBy` value, making each correction
 * traceable to its human author.
 */
export function correctionsToGoldItems(corrections: readonly CorrectionRecord[]): GoldItem[] {
  const items: GoldItem[] = []
  for (const corr of corrections) {
    let parsed: unknown
    try {
      parsed = JSON.parse(corr.correctionJson)
    } catch {
      // Malformed JSON — skip; cannot contribute a gold label.
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const labelField = (parsed as Record<string, unknown>).label
    if (typeof labelField !== 'string' || labelField.length === 0) continue
    items.push({
      subjectId: corr.subjectId,
      metric: corr.metric,
      humanLabel: labelField,
      raterId: corr.correctedBy,
    })
  }
  return items
}

// ─── Gold set merging ─────────────────────────────────────────────────────────

/**
 * Merge a static gold set with gold items derived from corrections.
 *
 * Deduplication: an item is considered a duplicate when both `subjectId` and
 * `raterId` match an existing entry for the same metric.  The static set takes
 * precedence; corrections that duplicate an existing static item are dropped.
 */
export function mergeGoldSets(
  staticItems: readonly GoldItem[],
  correctionItems: readonly GoldItem[],
): GoldItem[] {
  const seen = new Set<string>()
  const result: GoldItem[] = []

  for (const item of staticItems) {
    const key = `${item.metric}::${item.subjectId}::${item.raterId}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(item)
    }
  }

  for (const item of correctionItems) {
    const key = `${item.metric}::${item.subjectId}::${item.raterId}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(item)
    }
  }

  return result
}

// ─── Gold-set helpers ─────────────────────────────────────────────────────────

/**
 * Group gold items by metric name.
 */
export function groupByMetric(items: readonly GoldItem[]): Map<string, GoldItem[]> {
  const map = new Map<string, GoldItem[]>()
  for (const item of items) {
    const existing = map.get(item.metric)
    if (existing) {
      existing.push(item)
    } else {
      map.set(item.metric, [item])
    }
  }
  return map
}

/**
 * From a set of items for one metric, find all subject IDs that have labels
 * from ≥2 distinct raters.  Returns the list of rater-pair label arrays
 * (one array per rater, aligned by subjectId) suitable for human-ceiling κ.
 *
 * When <2 raters are present, returns null.
 */
export function extractHumanPairs(
  items: readonly GoldItem[],
): { raterA: string[]; raterB: string[] } | null {
  // Collect per-rater maps: raterId → Map<subjectId, label>
  const byRater = new Map<string, Map<string, string>>()
  for (const item of items) {
    let raterMap = byRater.get(item.raterId)
    if (!raterMap) {
      raterMap = new Map<string, string>()
      byRater.set(item.raterId, raterMap)
    }
    raterMap.set(item.subjectId, item.humanLabel)
  }

  const raterIds = Array.from(byRater.keys())
  if (raterIds.length < 2) return null

  // Use first two raters for the ceiling estimate
  const raterAId = raterIds[0] as string
  const raterBId = raterIds[1] as string
  const mapA = byRater.get(raterAId) as Map<string, string>
  const mapB = byRater.get(raterBId) as Map<string, string>

  // Find subjects rated by both
  const sharedSubjects: string[] = []
  for (const subjectId of mapA.keys()) {
    if (mapB.has(subjectId)) sharedSubjects.push(subjectId)
  }

  if (sharedSubjects.length === 0) return null

  const raterA = sharedSubjects.map((s) => mapA.get(s) as string)
  const raterB = sharedSubjects.map((s) => mapB.get(s) as string)

  return { raterA, raterB }
}

/**
 * Resolve a single representative label per subjectId from a potentially
 * multi-rater gold set, using majority vote (first rater wins on ties).
 *
 * Returns a map of subjectId → canonicalLabel.
 */
export function canonicalLabels(items: readonly GoldItem[]): Map<string, string> {
  // Collect votes per subjectId
  const votes = new Map<string, Map<string, number>>()
  for (const item of items) {
    let v = votes.get(item.subjectId)
    if (!v) {
      v = new Map<string, number>()
      votes.set(item.subjectId, v)
    }
    v.set(item.humanLabel, (v.get(item.humanLabel) ?? 0) + 1)
  }

  const result = new Map<string, string>()
  for (const [subjectId, labelVotes] of votes) {
    let best = ''
    let bestCount = -1
    for (const [label, count] of labelVotes) {
      if (count > bestCount) {
        best = label
        bestCount = count
      }
    }
    result.set(subjectId, best)
  }
  return result
}

// ─── Verdict-to-prediction bridge ────────────────────────────────────────────

/**
 * Extract the model's predicted label for a given subject from its
 * structured_verdict_json.  The field searched is `label` if present, then
 * `ordinal`, then the first string-valued key — matching how each insight
 * module serialises its primary output.
 *
 * Returns null when no label can be extracted.
 */
export function extractPredictedLabel(verdict: AiVerdict): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(verdict.structuredVerdictJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  for (const key of ['label', 'ordinal', 'band', 'workType', 'cause', 'tier']) {
    const v = obj[key]
    if (typeof v === 'string') return v
  }
  // Fall back to first string value
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') return v
  }
  return null
}

/**
 * Extract a numeric rank from a structured_verdict_json for use in Spearman.
 *
 * Tries `rank`, then `ordinal` (parsed as number), then `confidence`.
 */
export function extractPredictedRank(verdict: AiVerdict): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(verdict.structuredVerdictJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  for (const key of ['rank', 'ordinal', 'confidence']) {
    const v = obj[key]
    if (typeof v === 'number') return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (!Number.isNaN(n)) return n
    }
  }
  return null
}

// ─── Store helper: load corrected verdicts ────────────────────────────────────

/**
 * Convenience: fetch all verdicts for `subjectIds` and `metrics` from the store,
 * returning only those that have been corrected.
 *
 * Since Store has no `listAiVerdicts`, callers typically pass a pre-loaded list.
 * This function exists as a thin adapter so calibration code never accesses the
 * store directly.
 */
export async function loadCorrectedVerdicts(
  store: Store,
  verdictIds: readonly string[],
): Promise<CorrectionRecord[]> {
  const corrections: CorrectionRecord[] = []
  for (const id of verdictIds) {
    const v = await store.getAiVerdict(id)
    if (v && v.correctedBy !== null && v.correctionJson !== null) {
      corrections.push({
        id: v.id,
        subjectId: v.subjectId,
        metric: v.metric,
        correctionJson: v.correctionJson,
        correctedBy: v.correctedBy,
      })
    }
  }
  return corrections
}
