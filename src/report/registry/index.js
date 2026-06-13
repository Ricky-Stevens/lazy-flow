import { PRESETS } from './presets.js'

export { PRESETS } from './presets.js'

const BY_KEY = new Map(PRESETS.map((p) => [p.key, p]))

/** Look up a preset by key (e.g. 'monthly:team'), or null. */
export function getPreset(key) {
  return BY_KEY.get(key) ?? null
}

/** Enumerate presets for the list_report_presets tool. */
export function listPresets() {
  return PRESETS.map((p) => ({
    key: p.key,
    title: p.title,
    audience: p.audience,
    scopeType: p.scopeType,
    cadence: p.cadence,
    personScope: p.personScope === true,
  }))
}
