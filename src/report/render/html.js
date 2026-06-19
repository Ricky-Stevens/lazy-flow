/**
 * HTML renderer — composes a ReportModel into ONE self-contained .html file
 * (inline CSS theme + inline SVG charts, no external assets, emailable/offline).
 *
 * Templating + escaping is delegated to `eta` (auto-escapes <%= %>); only trusted,
 * self-generated SVG is injected raw via <%~ %>. A small view-model keeps all
 * formatting logic in TS so the template stays declarative.
 */

import { Eta } from 'eta'

import { REPORT_CSS } from './theme.js'
import { fmtValue } from './units.js'

const eta = new Eta({ autoEscape: true, autoTrim: false })

const ARROW = { up: '▲', down: '▼', steady: '▬' }
const BAND_LABEL = {
  well_below: 'well below baseline',
  below: 'below baseline',
  in_line: 'in line with baseline',
  above: 'above baseline',
  well_above: 'well above baseline',
  unknown: 'no baseline',
}

function comparisonView(cell) {
  const c = cell.comparison
  if (c === undefined) return null
  const deltaStr =
    c.delta === null
      ? ''
      : `${c.delta >= 0 ? '+' : ''}${fmtValue(c.delta, cell.unit)}${
          c.deltaPct !== null ? ` (${(c.deltaPct * 100).toFixed(0)}%)` : ''
        }`
  return {
    arrowDir: c.trendArrow,
    arrow: ARROW[c.trendArrow] ?? '',
    word: c.trendArrow,
    bandLabel: BAND_LABEL[c.band] ?? c.band,
    polarity: cell.polarity,
    significant: c.significant,
    deltaStr,
    note: c.note,
  }
}

function buildViewModel(model) {
  const sections = model.sections.map((s) => ({
    title: s.title,
    purpose: s.purpose,
    caveats: s.caveats,
    rows: s.cells.map((cell) => ({
      label: cell.label,
      valueStr: fmtValue(cell.value, cell.unit),
      trustTier: cell.trustTier,
      dataQuality: cell.dataQuality,
      proxy: cell.proxy === true,
      comparison: comparisonView(cell),
      benchmark:
        cell.benchmark === undefined
          ? null
          : {
              source: cell.benchmark.source,
              band: cell.benchmark.band,
              note: cell.benchmark.note,
              suppressed: cell.benchmark.suppressed,
            },
    })),
    charts: s.charts.map((c) => ({
      title: c.title,
      svg: c.svg,
      alt: c.alt,
      hasSvg: c.svg.length > 0,
    })),
    narrative: s.narrative,
  }))

  return {
    css: REPORT_CSS,
    title: model.title,
    audience: model.audience,
    scopeLabel: `${model.scope.type}: ${model.scope.id}`,
    periodLabel: model.period.label,
    priorLabel: model.period.priorLabel,
    generatedAt: model.generatedAt,
    personScope: model.personScope,
    blindSpots: model.blindSpots,
    prov: model.provenance,
    sections,
    // The full report model, baked in as inert JSON so the file is fully
    // self-contained (no DB link at view time) and Claude can re-compose
    // charts/tables from the underlying numbers later. `<` is escaped so the
    // payload can never break out of the <script> element.
    reportDataJson: JSON.stringify(model).replace(/</g, '\\u003c'),
  }
}

const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><%= it.title %> — <%= it.periodLabel %></title>
<style><%~ it.css %></style>
</head>
<body>
<div class="lf-wrap">
<header>
<h1><%= it.title %></h1>
<p class="lf-sub"><%= it.scopeLabel %> · <%= it.periodLabel %><% if (it.priorLabel) { %> (vs <%= it.priorLabel %>)<% } %></p>
<p class="lf-meta">Audience: <%= it.audience %> · generated <%= it.generatedAt %></p>
<% if (it.personScope) { %><p class="boundary">Private self-view — narrow flow slice; does not measure scope, judgment, mentorship, or impact. Not for appraisal or cross-person comparison.</p><% } %>
</header>

<% if (it.blindSpots && it.blindSpots.length) { %>
<div class="callout">
<div class="lbl">What this report cannot see</div>
<ul><% it.blindSpots.forEach(function(b){ %><li><%= b %></li><% }) %></ul>
</div>
<% } %>

<% it.sections.forEach(function(s){ %>
<section>
<h2><%= s.title %></h2>
<% if (s.purpose) { %><p class="lf-purpose"><%= s.purpose %></p><% } %>

<% if (s.rows.length) { %>
<table>
<thead><tr><th>Metric</th><th>Value</th><th>vs baseline</th><th>Trust</th><th>Benchmark</th></tr></thead>
<tbody>
<% s.rows.forEach(function(r){ %>
<tr>
<td><%= r.label %><% if (r.proxy) { %> <span class="badge proxy">proxy</span><% } %></td>
<td class="num"><%= r.valueStr %><% if (r.dataQuality !== 'ok') { %> <span class="muted">(<%= r.dataQuality %>)</span><% } %></td>
<td>
<% if (r.comparison && r.comparison.significant) { %>
<span class="band <%= r.comparison.arrowDir %> <%= r.comparison.polarity %>"><%= r.comparison.arrow %> <%= r.comparison.word %></span>
<span class="muted"><%= r.comparison.deltaStr %> · <%= r.comparison.bandLabel %></span>
<% } else if (r.comparison && r.comparison.note) { %>
<span class="muted"><%= r.comparison.note %></span>
<% } else { %><span class="muted">—</span><% } %>
</td>
<td><span class="badge <%= r.trustTier %>"><%= r.trustTier %></span></td>
<td>
<% if (r.benchmark && !r.benchmark.suppressed) { %><%= r.benchmark.band || '' %> <span class="muted"><%= r.benchmark.source %></span>
<% } else if (r.benchmark && r.benchmark.suppressed) { %><span class="muted">suppressed — <%= r.benchmark.note %></span><% } else { %><span class="muted">—</span><% } %>
</td>
</tr>
<% }) %>
</tbody>
</table>
<% } %>

<% s.charts.forEach(function(c){ %>
<div class="chart">
<% if (c.hasSvg) { %><%~ c.svg %><% } else { %><div class="alt"><%= c.alt %></div><% } %>
</div>
<% }) %>

<% if (s.narrative) { %>
<div class="narrative">
<div class="lbl"><% if (s.narrative.modelSnapshot) { %>AI — advisory · <%= s.narrative.modelSnapshot %><% } else { %>Summary<% } %><% if (s.narrative.contestable) { %> · contestable<% } %></div>
<p><%= s.narrative.summary %></p>
<% if (s.narrative.bullets && s.narrative.bullets.length) { %><ul><% s.narrative.bullets.forEach(function(b){ %><li><%= b %></li><% }) %></ul><% } %>
</div>
<% } %>

<% s.caveats.forEach(function(cv){ %><p class="caveat"><%= cv %></p><% }) %>
</section>
<% }) %>

<footer>
Engine <%= it.prov.engineVersion %> · trust: <%= it.prov.trustTier %> · data quality: <%= it.prov.dataQuality %> · as of <%= it.prov.asOf %><% if (it.prov.coverageFingerprint) { %> · coverage <%= it.prov.coverageFingerprint %><% } %>
<br>Published formulas, trust tiers, and AI contestability per the lazy-flow methodology. Generated locally; no data left this machine.
</footer>
</div>
<script type="application/json" id="lazy-flow-report-data"><%~ it.reportDataJson %></script>
</body>
</html>`

/** Render a ReportModel to a single self-contained HTML document. */
export function renderHtml(model) {
  return eta.renderString(TEMPLATE, buildViewModel(model))
}
