/**
 * Headless chart toolkit — builds static inline SVG strings from data using
 * d3 scale/shape math. Pure functions: no DOM, no canvas, no browser.
 *
 * Each builder in ./index.js composes these helpers into one self-contained
 * <svg> that is baked directly into the HTML report. SVG keeps charts vector
 * (crisp in browser print-to-PDF) and text (Claude can read and edit the
 * markup, and the data blob, after the fact).
 */

/** Shared visual theme so every chart matches the report and prints cleanly. */
export const CHART_CONFIG = {
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  labelColor: '#475569',
  gridColor: '#eef2f7',
  domainColor: '#cbd5e1',
  primary: '#0072B2',
  // Colour-blind-safe categorical palette (Okabe-Ito derived).
  category: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#F0E442'],
}

/** Default plot margins — room for a left y-axis and bottom x-labels. */
export const MARGIN = { top: 16, right: 16, bottom: 28, left: 40 }

const XML_ESC = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }

/** XML-escape text/attribute content destined for SVG. */
export function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (c) => XML_ESC[c])
}

/** Round to 2dp to keep SVG markup small and stable across runs. */
export function round(n) {
  return Math.round(n * 100) / 100
}

/** Pick a palette colour by series index (wraps the categorical palette). */
export function seriesColor(i) {
  return CHART_CONFIG.category[i % CHART_CONFIG.category.length]
}

/** Wrap body markup in an <svg> root carrying the shared font + a11y role. */
export function svgRoot(width, height, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" font-family="${CHART_CONFIG.font}" role="img">${body}</svg>`
  )
}

function tickLabel(v) {
  if (!Number.isFinite(v)) return ''
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

/** Horizontal gridlines + left tick labels for a linear y scale. */
export function yGridAxis(y, left, innerWidth, tickCount = 4) {
  return y
    .ticks(tickCount)
    .map((v) => {
      const py = round(y(v))
      return (
        `<line x1="${left}" x2="${round(left + innerWidth)}" y1="${py}" y2="${py}" stroke="${CHART_CONFIG.gridColor}"/>` +
        `<text x="${left - 6}" y="${py + 3}" text-anchor="end" font-size="11" fill="${CHART_CONFIG.labelColor}">${escapeXml(tickLabel(v))}</text>`
      )
    })
    .join('')
}

/** Bottom category labels for a band or point scale (one per domain entry). */
export function xCategoryAxis(x, baselineY) {
  const offset = typeof x.bandwidth === 'function' ? x.bandwidth() / 2 : 0
  return x
    .domain()
    .map(
      (d) =>
        `<text x="${round(x(d) + offset)}" y="${baselineY + 16}" text-anchor="middle" font-size="11" fill="${CHART_CONFIG.labelColor}">${escapeXml(d)}</text>`,
    )
    .join('')
}

/** A compact horizontal legend (swatch + label) starting at (x, y). */
export function legendRow(entries, x, y) {
  let cursor = x
  return entries
    .map(({ label, color }) => {
      const item =
        `<rect x="${round(cursor)}" y="${y - 9}" width="10" height="10" rx="2" fill="${color}"/>` +
        `<text x="${round(cursor + 14)}" y="${y}" font-size="11" fill="${CHART_CONFIG.labelColor}">${escapeXml(label)}</text>`
      // Advance past swatch (10) + gap (4) + estimated text width + trailing gap.
      cursor += 14 + String(label).length * 6.4 + 16
      return item
    })
    .join('')
}
