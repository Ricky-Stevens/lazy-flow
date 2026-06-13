export const DORA_SOURCE = 'DORA 2025'
const LICENSE_NOTE = 'DORA 2025 bands (CC BY 4.0, Google LLC).'

/** value is already normalised to the metric's unit; returns a DORA band. */
function classify(metricId, value) {
  switch (metricId) {
    case 'dora.deployment_frequency': {
      // per day (higher better): elite ≥1/day, high ≥1/week, medium ≥1/month.
      if (value >= 1) return 'elite'
      if (value >= 1 / 7) return 'high'
      if (value >= 1 / 30) return 'medium'
      return 'low'
    }
    case 'dora.lead_time': {
      // hours (lower better): elite <1d, high <1wk, medium <1mo.
      if (value < 24) return 'elite'
      if (value < 168) return 'high'
      if (value < 720) return 'medium'
      return 'low'
    }
    case 'dora.change_failure_rate': {
      // rate (lower better); accept 0–1 or 0–100.
      const rate = value > 1 ? value / 100 : value
      if (rate <= 0.05) return 'elite'
      if (rate <= 0.1) return 'high'
      if (rate <= 0.15) return 'medium'
      return 'low'
    }
    case 'dora.recovery_time': {
      // hours (lower better): elite <1h, high <1d, medium <1wk.
      if (value < 1) return 'elite'
      if (value < 24) return 'high'
      if (value < 168) return 'medium'
      return 'low'
    }
    default:
      return null
  }
}

const THRESHOLDS = {
  'dora.deployment_frequency': [
    { label: 'medium', at: 1 / 30 },
    { label: 'high', at: 1 / 7 },
    { label: 'elite', at: 1 },
  ],
  'dora.lead_time': [
    { label: 'elite', at: 24 },
    { label: 'high', at: 168 },
    { label: 'medium', at: 720 },
  ],
  'dora.change_failure_rate': [
    { label: 'elite', at: 0.05 },
    { label: 'high', at: 0.1 },
    { label: 'medium', at: 0.15 },
  ],
  'dora.recovery_time': [
    { label: 'elite', at: 1 },
    { label: 'high', at: 24 },
    { label: 'medium', at: 168 },
  ],
}

/** Build the DORA benchmark provider (the only industry benchmark we ship). */
export function buildBenchmarkProvider() {
  return {
    lookup(input) {
      // Compatibility matrix: DORA keys only; never person scope.
      if (!(input.metricId in THRESHOLDS)) return null
      if (input.scopeType === 'person' || input.scopeType === 'self') return null

      // Proxy data is not comparable to DORA benchmarks — surface, suppressed.
      if (input.proxy) {
        return {
          source: DORA_SOURCE,
          band: null,
          note: 'proxy-mode — not comparable to DORA benchmarks; connect real deploy/incident data.',
          suppressed: true,
          suppressedReason: 'proxy_data',
        }
      }
      if (input.value === null || !Number.isFinite(input.value)) return null

      const band = classify(input.metricId, input.value)
      if (band === null) return null
      return {
        source: DORA_SOURCE,
        band,
        note: LICENSE_NOTE,
        suppressed: false,
        suppressedReason: null,
      }
    },
    thresholds(metricId) {
      return THRESHOLDS[metricId] ?? []
    },
  }
}
