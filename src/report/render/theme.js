/**
 * Inline CSS theme for self-contained HTML reports. Print-friendly, system fonts,
 * no external assets. Meaning is never encoded by colour alone (bands/arrows carry
 * text), so the report survives B/W printouts and colour-blind readers.
 */
export const REPORT_CSS = `
:root {
  --fg: #0f172a; --muted: #64748b; --line: #e2e8f0; --bg: #ffffff;
  --good: #047857; --bad: #b91c1c; --warn: #b45309; --info: #1d4ed8;
  --chip: #f1f5f9;
}
* { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--fg); background: var(--bg); margin: 0; padding: 32px;
  line-height: 1.45; font-size: 14px;
}
.lf-wrap { max-width: 920px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 2px solid var(--line); }
h3 { font-size: 13px; margin: 0 0 6px; color: var(--muted); font-weight: 600; }
.lf-sub { color: var(--muted); font-size: 13px; margin: 0 0 2px; }
.lf-meta { color: var(--muted); font-size: 12px; }
.lf-purpose { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 13px; }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
td.num { font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; background: var(--chip); color: var(--muted); border: 1px solid var(--line); white-space: nowrap; }
.badge.deterministic { color: #065f46; }
.badge.hybrid { color: #92400e; }
.badge.probabilistic { color: #6d28d9; }
.badge.proxy { color: var(--warn); border-color: #fcd34d; }
.band { font-weight: 600; }
.band.up.higher_better, .band.down.lower_better { color: var(--good); }
.band.down.higher_better, .band.up.lower_better { color: var(--bad); }
.band.steady { color: var(--muted); }
.muted { color: var(--muted); }
.chart { margin: 8px 0 4px; }
.chart svg { max-width: 100%; height: auto; }
.chart .alt { color: var(--muted); font-size: 12px; }
.narrative { border-left: 3px solid var(--info); background: #f8fafc; padding: 8px 12px; margin: 10px 0; border-radius: 0 6px 6px 0; }
.narrative .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--info); font-weight: 700; }
.narrative ul { margin: 6px 0 0; padding-left: 18px; }
.callout { border: 1px solid var(--line); background: #fffbeb; padding: 10px 12px; border-radius: 6px; margin: 12px 0; }
.callout .lbl { font-weight: 700; font-size: 12px; }
.caveat { color: var(--warn); font-size: 12px; margin: 4px 0; }
footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
.boundary { color: var(--bad); font-weight: 600; }
@media print {
  body { padding: 0; font-size: 12px; }
  h2 { break-after: avoid; }
  section { break-inside: avoid; }
  .narrative, .callout { background: #fff !important; }
}
`
