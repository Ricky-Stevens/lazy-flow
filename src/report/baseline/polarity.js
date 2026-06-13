const LOWER_BETTER = new Set([
  'dora.lead_time',
  'dora.change_failure_rate',
  'dora.recovery_time',
  'dora.incident_reopen_rate',
  'dora.deployment_rework_rate',
  'flow.cycle_time',
  'flow.time_in_status',
  // Monte Carlo forecast value = weeks to clear WIP; fewer weeks is better.
  'flow.monte_carlo_forecast',
  'flow.aging_wip',
  'flow.wip_load',
  'pr.cycle_time',
  'pr.review_latency',
  'pr.time_to_first_review',
  'pr.time_to_merge',
  'pr.stale',
  'pr.review_iterations',
  'pr.merge_without_review_rate',
  'pr.reviewer_load_gini',
  'pr.size',
  'code.rework_churn',
])

const HIGHER_BETTER = new Set([
  'dora.deployment_frequency',
  'dora.reliability_proxy',
  'flow.throughput',
  'flow.flow_efficiency',
  'pr.review_coverage',
  'pr.ci_health',
  'code.maintainability_index',
  'agile.sprint_velocity',
  'agile.say_do',
  'agile.sprint_predictability',
  'agile.estimation_accuracy',
])

/** Resolve the polarity for a metric id (default 'neutral'). */
export function polarityFor(metricId) {
  if (LOWER_BETTER.has(metricId)) return 'lower_better'
  if (HIGHER_BETTER.has(metricId)) return 'higher_better'
  return 'neutral'
}
