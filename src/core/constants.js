/**
 * ENGINE_VERSION pins the deterministic metric engine version per SPEC §8.6.
 * Every MetricResult and metric_snapshot carries this version so that tools can
 * refuse to plot across mixed engine versions (false-trend guard) and re-derivation
 * can be triggered on a version bump.
 */
export const ENGINE_VERSION = '0.1.1'
