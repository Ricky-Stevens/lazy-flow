function esc(s) {
  // Escape pipes/newlines so table cells don't break.
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function fmtValue(value, unit) {
  if (value === null || !Number.isFinite(value)) return '—'
  const s = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
  return unit && unit !== 'count' ? `${s} ${unit}` : s
}

function comparisonCell(cell) {
  const c = cell.comparison
  if (c === undefined) return '—'
  if (c.significant) {
    const arrow = c.trendArrow === 'up' ? '▲' : c.trendArrow === 'down' ? '▼' : '▬'
    const delta =
      c.delta === null ? '' : ` ${c.delta >= 0 ? '+' : ''}${fmtValue(c.delta, cell.unit)}`
    return `${arrow} ${c.trendArrow}${delta}`
  }
  return c.note ?? '—'
}

/** Render a ReportModel to GitHub-flavoured Markdown. */
export function renderMarkdown(model) {
  const out = []
  out.push(`# ${model.title}`)
  out.push('')
  out.push(
    `**${model.scope.type}: ${model.scope.id}** · ${model.period.label}` +
      (model.period.priorLabel ? ` (vs ${model.period.priorLabel})` : ''),
  )
  out.push(`Audience: ${model.audience} · generated ${model.generatedAt}`)
  if (model.personScope) {
    out.push('')
    out.push(
      '> **Private self-view** — narrow flow slice; does not measure scope, judgment, ' +
        'mentorship, or impact. Not for appraisal or cross-person comparison.',
    )
  }
  out.push('')

  if (model.blindSpots.length > 0) {
    out.push(`> **What this report cannot see:** ${model.blindSpots.map(esc).join('; ')}`)
    out.push('')
  }

  for (const s of model.sections) {
    out.push(`## ${s.title}`)
    if (s.purpose) out.push(`_${esc(s.purpose)}_`)
    out.push('')
    if (s.cells.length > 0) {
      out.push('| Metric | Value | vs baseline | Trust | Benchmark |')
      out.push('| --- | --- | --- | --- | --- |')
      for (const cell of s.cells) {
        const bench =
          cell.benchmark === undefined
            ? '—'
            : cell.benchmark.suppressed
              ? `suppressed — ${cell.benchmark.note}`
              : `${cell.benchmark.band ?? ''} ${cell.benchmark.source}`.trim()
        const proxy = cell.proxy === true ? ' _(proxy)_' : ''
        out.push(
          `| ${esc(cell.label)}${proxy} | ${fmtValue(cell.value, cell.unit)} | ` +
            `${esc(comparisonCell(cell))} | ${cell.trustTier} | ${esc(bench)} |`,
        )
      }
      out.push('')
    }
    for (const c of s.charts) {
      out.push(`_${esc(c.alt)}_`)
      out.push('')
    }
    if (s.narrative !== null) {
      const label = s.narrative.modelSnapshot ? 'AI — advisory' : 'Summary'
      out.push(
        `> **${label}${s.narrative.contestable ? ' (contestable)' : ''}:** ${esc(s.narrative.summary)}`,
      )
      for (const b of s.narrative.bullets) out.push(`> - ${esc(b)}`)
      out.push('')
    }
    for (const cv of s.caveats) out.push(`⚠️ ${esc(cv)}`)
    if (s.caveats.length > 0) out.push('')
  }

  const p = model.provenance
  out.push('---')
  out.push(
    `Engine ${p.engineVersion} · trust: ${p.trustTier} · data quality: ${p.dataQuality} · ` +
      `as of ${p.asOf}${p.coverageFingerprint ? ` · coverage ${p.coverageFingerprint}` : ''}`,
  )
  return `${out.join('\n')}\n`
}
