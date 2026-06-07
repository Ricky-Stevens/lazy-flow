/**
 * generate-formulas.ts — regenerate docs/FORMULAS.md from metric module formulaDoc strings.
 *
 * Usage: node --import tsx/esm scripts/generate-formulas.ts
 *   or:  npx tsx scripts/generate-formulas.ts
 *
 * The generated file is committed to the repo. The formulas.test.ts test asserts
 * that every registered metric id appears in the file, so CI will fail if the doc
 * goes stale after a metric is added or renamed.
 *
 * This script is intentionally simple: it imports every metric module directly
 * and writes Markdown. No build step required.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Import all metric modules
// ---------------------------------------------------------------------------

import {
  agingWip,
  cfd,
  changeFailureRate,
  ciHealth,
  codeChangeImpact,
  commentsPerPr,
  complexityDelta,
  cycleTime,
  deploymentFrequency,
  deploymentReworkRate,
  estimationAccuracy,
  flowDistribution,
  flowEfficiency,
  halocAggregate,
  incidentReopenRate,
  leadTime,
  maintainabilityIndex,
  mergeWithoutReviewRate,
  monteCarlo,
  nagappanBall,
  prCycleTime,
  prSize,
  recoveryTime,
  reliabilityProxy,
  reviewCoverage,
  reviewerLoad,
  reviewersPerPr,
  reviewIterations,
  reviewLatency,
  reworkChurn,
  sayDo,
  sprintPredictability,
  sprintVelocity,
  stalePr,
  throughput,
  timeInStatus,
  timeToFirstReview,
  timeToMerge,
  wipLoad,
} from '../packages/metrics/src/index.js'

import type { MetricModule } from '../packages/metrics/src/types.js'

// ---------------------------------------------------------------------------
// Metric registry — grouped by SPEC §8 group (A–E)
// ---------------------------------------------------------------------------

interface MetricEntry {
  module: MetricModule<unknown>
  group: string
  groupLabel: string
  specSection: string
}

const REGISTRY: MetricEntry[] = [
  // Group A — DORA
  { module: deploymentFrequency, group: 'A', groupLabel: 'Group A — DORA / Delivery (`team+`)', specSection: '§8.1' },
  { module: leadTime, group: 'A', groupLabel: 'Group A — DORA / Delivery (`team+`)', specSection: '§8.1' },
  { module: changeFailureRate, group: 'A', groupLabel: 'Group A — DORA / Delivery (`team+`)', specSection: '§8.1' },
  { module: recoveryTime, group: 'A', groupLabel: 'Group A — DORA / Delivery (`team+`)', specSection: '§8.1' },
  { module: incidentReopenRate, group: 'A', groupLabel: 'Group A — DORA / Delivery (`team+`)', specSection: '§8.1' },
  { module: deploymentReworkRate, group: 'A', groupLabel: 'Group A — DORA / Delivery (`team+`)', specSection: '§8.1' },
  { module: reliabilityProxy, group: 'A', groupLabel: 'Group A — DORA / Delivery (`team+`)', specSection: '§8.1' },
  // Group B — Flow
  { module: cycleTime, group: 'B', groupLabel: 'Group B — Flow (value stream, `team+`)', specSection: '§8.2' },
  { module: flowEfficiency, group: 'B', groupLabel: 'Group B — Flow (value stream, `team+`)', specSection: '§8.2' },
  { module: throughput, group: 'B', groupLabel: 'Group B — Flow (value stream, `team+`)', specSection: '§8.2' },
  { module: wipLoad, group: 'B', groupLabel: 'Group B — Flow (value stream, `team+`)', specSection: '§8.2' },
  { module: flowDistribution, group: 'B', groupLabel: 'Group B — Flow (value stream, `team+`)', specSection: '§8.2' },
  { module: cfd, group: 'B', groupLabel: 'Group B — Flow (value stream, `team+`)', specSection: '§8.2' },
  { module: agingWip, group: 'B', groupLabel: 'Group B — Flow (value stream, `team+`)', specSection: '§8.2' },
  { module: timeInStatus, group: 'B', groupLabel: 'Group B — Flow (value stream, `team+`)', specSection: '§8.2' },
  { module: monteCarlo, group: 'B', groupLabel: 'Group B — Flow (value stream, `team+`)', specSection: '§8.2' },
  // Group C — PR
  { module: prCycleTime, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: prSize, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: reviewCoverage, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: reviewersPerPr, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: reviewerLoad, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: commentsPerPr, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: reviewIterations, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: mergeWithoutReviewRate, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: reviewLatency, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: timeToFirstReview, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: timeToMerge, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: stalePr, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  { module: ciHealth, group: 'C', groupLabel: 'Group C — PR / Review (`team+`)', specSection: '§8.3' },
  // Group D — Code
  { module: halocAggregate, group: 'D', groupLabel: 'Group D — Code (`team+`, descriptive only)', specSection: '§8.4' },
  { module: reworkChurn, group: 'D', groupLabel: 'Group D — Code (`team+`, descriptive only)', specSection: '§8.4' },
  { module: nagappanBall, group: 'D', groupLabel: 'Group D — Code (`team+`, descriptive only)', specSection: '§8.4' },
  { module: complexityDelta, group: 'D', groupLabel: 'Group D — Code (`team+`, descriptive only)', specSection: '§8.4' },
  { module: maintainabilityIndex, group: 'D', groupLabel: 'Group D — Code (`team+`, descriptive only)', specSection: '§8.4' },
  { module: codeChangeImpact, group: 'D', groupLabel: 'Group D — Code (`team+`, descriptive only)', specSection: '§8.4' },
  // Group E — Agile
  { module: sprintVelocity, group: 'E', groupLabel: 'Group E — Agile / Jira (`team+`)', specSection: '§8.5' },
  { module: sayDo, group: 'E', groupLabel: 'Group E — Agile / Jira (`team+`)', specSection: '§8.5' },
  { module: sprintPredictability, group: 'E', groupLabel: 'Group E — Agile / Jira (`team+`)', specSection: '§8.5' },
  { module: estimationAccuracy, group: 'E', groupLabel: 'Group E — Agile / Jira (`team+`)', specSection: '§8.5' },
]

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function paramsToString(params: Record<string, unknown>): string {
  const entries = Object.entries(params)
  if (entries.length === 0) return '_(none)_'
  return entries.map(([k, v]) => `\`${k}: ${JSON.stringify(v)}\``).join(', ')
}

function generateMarkdown(): string {
  const lines: string[] = []

  lines.push('# lazy-flow — Formula Reference')
  lines.push('')
  lines.push('> **Auto-generated** from metric module `formulaDoc` strings.')
  lines.push('> Do not edit by hand — run `npm run generate:formulas` to regenerate.')
  lines.push('>')
  lines.push('> Every metric exported from `@lazy-flow/metrics` is listed here with its')
  lines.push('> `id`, `trustTier`, `scope`, `params`, and the full published `formulaDoc`')
  lines.push('> string (SPEC §8.6 contract). Grouped by SPEC §8 group (A–E).')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## Trust tiers')
  lines.push('')
  lines.push('| Tier | Meaning |')
  lines.push('|---|---|')
  lines.push('| `deterministic` | Pure computation — timestamps, counts, AST walks, statistical simulations. Formula fully reproducible. |')
  lines.push('| `hybrid` | Deterministic features + LLM judgment. LLM output is schema/enum-bounded and audited. |')
  lines.push('| `probabilistic` | LLM-dominant, advisory. Use with appropriate uncertainty. |')
  lines.push('')
  lines.push('---')
  lines.push('')

  // Group entries
  let currentGroup = ''
  for (const entry of REGISTRY) {
    const { module: m, group, groupLabel } = entry

    if (group !== currentGroup) {
      currentGroup = group
      lines.push(`## ${groupLabel}`)
      lines.push('')
      lines.push('---')
      lines.push('')
    }

    lines.push(`### \`${m.id}\``)
    lines.push('')
    lines.push('| Field | Value |')
    lines.push('|---|---|')
    lines.push(`| **Trust tier** | \`${m.trustTier}\` |`)
    lines.push(`| **Scope** | \`${m.scope}\` |`)
    lines.push(`| **Default params** | ${paramsToString(m.params)} |`)
    lines.push('')
    lines.push('**Formula:**')
    lines.push(`> ${m.formulaDoc.replace(/\n/g, '\n> ')}`)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  lines.push(`*${REGISTRY.length} metrics total. Generated from source: \`packages/metrics/src/\`.*`)
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Write the file
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const outPath = resolve(__dirname, '..', 'docs', 'FORMULAS.md')
const content = generateMarkdown()
writeFileSync(outPath, content, 'utf8')
console.log(`Written ${REGISTRY.length} metrics to ${outPath}`)
