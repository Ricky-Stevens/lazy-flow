/**
 * Deployment-environment matching for DORA metrics + deploy↔incident linking.
 *
 * The GitHub Deployments API environment is a free-form, user-chosen string
 * (`mapDeployment`: `environment: raw.environment ?? 'production'`). Real prod
 * environments are spelled many ways — `production`, `Production`, `prod`,
 * `production-us`, `prod-eu` — so an exact `=== 'production'` test silently
 * drops genuine production deploys, biasing CFR/lead-time/MTTR and the
 * deploy↔incident linkage. Matching is therefore normalized + prod-family aware.
 */

/** Lowercase + trim; '' for non-strings. */
function normalize(env) {
  return typeof env === 'string' ? env.trim().toLowerCase() : ''
}

/**
 * True when a deployment environment is a production environment. Accepts the
 * canonical spellings plus region/cluster-suffixed variants (production-us,
 * prod-eu, prod_1, production2) while rejecting unrelated names that merely
 * share a prefix (e.g. 'product-catalog', 'preproduction').
 */
export function isProductionEnv(env) {
  const e = normalize(env)
  if (e === 'production' || e === 'prod') return true
  // Suffixed prod envs: a separator or digit must follow the prod token so
  // 'product'/'preproduction' don't match.
  return /^prod(uction)?[-_. ]/.test(e) || /^prod(uction)?\d/.test(e)
}

/**
 * True when a deployment environment matches the metric's TARGET environment.
 * For the (default) production target this uses prod-family matching; for any
 * other configured target it falls back to a case-insensitive exact match so
 * configurability (e.g. targeting 'staging') is preserved.
 */
export function environmentMatches(deployEnv, targetEnv) {
  const target = normalize(targetEnv)
  if (target === 'production' || target === 'prod') return isProductionEnv(deployEnv)
  return normalize(deployEnv) === target
}
