/**
 * Headless chart rendering — vega-lite spec → static inline SVG string.
 *
 * Pure server-side: no DOM, no canvas, no browser. Rendering is wrapped so a
 * failure (e.g. the chart lib unavailable in a stripped runtime) degrades to an
 * empty SVG and the report still renders from the always-present `alt` text.
 */

import * as vega from 'vega'
import { compile } from 'vega-lite'

/** Shared visual theme so every chart matches the report and prints cleanly. */
export const CHART_CONFIG = {
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  background: 'transparent',
  view: { stroke: 'transparent' },
  axis: {
    labelFontSize: 11,
    titleFontSize: 12,
    labelColor: '#475569',
    titleColor: '#334155',
    gridColor: '#eef2f7',
    domainColor: '#cbd5e1',
    tickColor: '#cbd5e1',
  },
  legend: { labelFontSize: 11, titleFontSize: 12, labelColor: '#475569', titleColor: '#334155' },
  range: {
    // Colour-blind-safe categorical palette (Okabe-Ito derived).
    category: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#F0E442'],
  },
}

/**
 * Compile + render a vega-lite spec to an SVG string.
 * Returns '' on any failure (caller falls back to alt text).
 */
export async function renderVegaLiteToSvg(spec) {
  try {
    const withConfig = {
      ...spec,
      config: { ...CHART_CONFIG, ...(spec.config ?? {}) },
    }
    const compiled = compile(withConfig)
    const runtime = vega.parse(compiled.spec)
    const view = new vega.View(runtime, { renderer: 'none' })
    return await view.toSVG()
  } catch {
    // Graceful degrade — the report renders without the chart, alt text carries meaning.
    return ''
  }
}
