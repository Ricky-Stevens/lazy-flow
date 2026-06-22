import { ENGINE_VERSION } from '../../core/index.js'
import { isBugType } from '../shared/bugTypes.js'

const FORMULA_DOC =
  'Priority / Resolution Mix (deterministic, team scope): over the window, the share ' +
  'of issues by Jira priority bucket (e.g. Highest..Lowest) and the share of RESOLVED ' +
  "bug-type issues by resolution name (e.g. Done / Won't Do / Duplicate). " +
  'Headline value is the share of issues that fired a priority (sample-floor gated). ' +
  'Returns no_data when fewer than 5 in-window issues carry a priority. ' +
  'Bug-resolution sub-mix returns null when fewer than 3 resolved bugs in the window.'

/** Minimum issues carrying a priority before the headline mix is reported. */
const PRIORITY_SAMPLE_FLOOR = 5
/** Minimum resolved bug-type issues before the resolution sub-mix is reported. */
const RESOLUTION_SAMPLE_FLOOR = 3

/** Inclusive window check on an issue's createdAt ISO timestamp. */
function inWindow(iso, fromMs, toMs) {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return false
  return t >= fromMs && t <= toMs
}

/** Build a {bucket → { count, share }} payload from a list of bucket strings. */
function distribution(bucketsList) {
  const counts = new Map()
  for (const b of bucketsList) {
    counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  const total = bucketsList.length
  const out = {}
  for (const [bucket, count] of counts) {
    out[bucket] = {
      count,
      share: total > 0 ? count / total : null,
    }
  }
  return out
}

export const priorityMix = {
  id: 'agile.priority_mix',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: {},

  compute(inputs, asOf) {
    const { issues, fromMs, toMs } = inputs

    // 1. In-window issues (anchored on createdAt — same window semantics as the
    // other agile/flow metrics that count "issues active in the window").
    const inWindowIssues = []
    for (const issue of issues) {
      if (!inWindow(issue.createdAt, fromMs, toMs)) continue
      inWindowIssues.push(issue)
    }

    // 2. Priority distribution over EVERY in-window issue with a priority.
    const prioritised = inWindowIssues.filter(
      (i) => typeof i.priority === 'string' && i.priority.length > 0,
    )

    if (prioritised.length < PRIORITY_SAMPLE_FLOOR) {
      return {
        id: 'agile.priority_mix',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        sampleFloor: PRIORITY_SAMPLE_FLOOR,
        prioritisedCount: prioritised.length,
        totalInWindow: inWindowIssues.length,
        priorityMix: null,
        bugResolutionMix: null,
        resolvedBugCount: 0,
      }
    }

    const priorityDistribution = distribution(prioritised.map((i) => i.priority))

    // 3. Bug-resolution sub-mix: among bug-type issues that RESOLVED in window,
    // group by the resolution name. Resolution is only meaningful once an issue
    // is actually resolved, so we anchor on resolvedAt being in-window AND a
    // non-null resolution string.
    const resolvedBugs = []
    for (const issue of issues) {
      if (!isBugType(issue.type)) continue
      if (!inWindow(issue.resolvedAt, fromMs, toMs)) continue
      if (typeof issue.resolution !== 'string' || issue.resolution.length === 0) continue
      resolvedBugs.push(issue)
    }

    const bugResolutionMix =
      resolvedBugs.length >= RESOLUTION_SAMPLE_FLOOR
        ? distribution(resolvedBugs.map((i) => i.resolution))
        : null

    return {
      id: 'agile.priority_mix',
      trustTier: 'deterministic',
      scope: 'team',
      value: inWindowIssues.length > 0 ? prioritised.length / inWindowIssues.length : null,
      unit: 'ratio',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      sampleFloor: PRIORITY_SAMPLE_FLOOR,
      prioritisedCount: prioritised.length,
      totalInWindow: inWindowIssues.length,
      priorityMix: priorityDistribution,
      bugResolutionMix,
      resolvedBugCount: resolvedBugs.length,
    }
  },
}
