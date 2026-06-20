import { ENGINE_VERSION, environmentMatches, percentile, safeRatio } from '../../core/index.js'

// ---------------------------------------------------------------------------
// Recovery Time
// ---------------------------------------------------------------------------

const RECOVERY_DOC =
  'Time to Restore Service / MTTR (SPEC §8.1, §8.6). Two signals, deployment preferred: ' +
  '(1) DEPLOYMENT recovery — median(nextSuccessfulDeploy.createdAt − failedDeploy.createdAt) ' +
  'per env, the real production-recovery time, used whenever ingested deployment statuses ' +
  'expose ≥1 failed→recovered deployment. (2) INCIDENT recovery (fallback) — ' +
  'median(firstResolvedAt − createdAt) over incidents, anchored on the FIRST Done transition ' +
  '(a 1h-resolved-then-reopened incident recovers in 1h, not 25h). Returns null on no samples. ' +
  'Type-7 percentile. `recoverySource` records which signal `value` came from.'

/**
 * Real production-recovery durations from deployment outcomes: for each failed
 * (status failure/error) production deployment, the gap to the NEXT successful
 * deployment in the same environment. Failed deploys never followed by a success
 * are unrecovered and excluded (no recovery time yet). Requires real ingested
 * statuses — absent them every deploy reads 'success' and this yields nothing.
 */
function deploymentRecoveryDurations(deploys, env) {
  const FAILED = new Set(['failure', 'error'])
  const inEnv = deploys
    .filter((d) => environmentMatches(d.environment, env))
    .map((d) => ({ status: d.status, ms: new Date(d.createdAt).getTime() }))
    .filter((d) => Number.isFinite(d.ms))
    .sort((a, b) => a.ms - b.ms)

  const durations = []
  for (let i = 0; i < inEnv.length; i++) {
    const d = inEnv[i]
    if (d === undefined || !FAILED.has(d.status)) continue
    // First subsequent successful deploy in the same env = service restored.
    for (let j = i + 1; j < inEnv.length; j++) {
      const next = inEnv[j]
      if (next?.status === 'success') {
        durations.push((next.ms - d.ms) / 1000)
        break
      }
    }
  }
  return durations
}

export const recoveryTime = {
  id: 'dora.recovery_time',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: RECOVERY_DOC,
  params: { environment: 'production' },

  compute(inputs, asOf) {
    const env = inputs.environment ?? 'production'

    // Signal 1 (preferred): real deployment-to-recovery time.
    const deployDurations = inputs.deploys ? deploymentRecoveryDurations(inputs.deploys, env) : []

    // Signal 2 (fallback): incident resolution time. `incidents` is optional —
    // a deploy-only caller (or the deployment-recovery unit path) must not crash.
    const incidents = inputs.incidents ?? []
    const resolved = incidents.filter((i) => i.firstResolvedAt !== null)
    const incidentDurations = resolved.map((i) => {
      const created = new Date(i.createdAt).getTime()
      const firstResolved = new Date(i.firstResolvedAt).getTime()
      return Math.max(0, (firstResolved - created) / 1000) // clamp for clock skew (§8.6)
    })

    const useDeploy = deployDurations.length > 0
    const durations = useDeploy ? deployDurations : incidentDurations
    const recoverySource = useDeploy ? 'deployment' : 'incident'

    const deployRecoveryP50Seconds =
      deployDurations.length > 0 ? percentile(deployDurations, 0.5) : null
    const incidentRecoveryP50Seconds =
      incidentDurations.length > 0 ? percentile(incidentDurations, 0.5) : null

    if (durations.length === 0) {
      return {
        id: 'dora.recovery_time',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'seconds',
        dataQuality: incidents.length === 0 ? 'no_data' : 'insufficient_sample',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: RECOVERY_DOC,
        p50Seconds: null,
        sampleSize: 0,
        recoverySource: 'none',
        deployRecoveryP50Seconds,
        incidentRecoveryP50Seconds,
      }
    }

    const p50 = percentile(durations, 0.5)

    return {
      id: 'dora.recovery_time',
      trustTier: 'deterministic',
      scope: 'team',
      value: p50,
      unit: 'seconds',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: RECOVERY_DOC,
      p50Seconds: p50,
      sampleSize: durations.length,
      recoverySource,
      deployRecoveryP50Seconds,
      incidentRecoveryP50Seconds,
    }
  },
}

// ---------------------------------------------------------------------------
// Reopen Rate (companion metric)
// ---------------------------------------------------------------------------

const REOPEN_DOC =
  'Incident Reopen Rate (SPEC §8.1): reopened_incidents / total_incidents. ' +
  'A reopened incident = incident with reopenCount > 0 in the window. ' +
  'Tracked separately from recovery time (reopens do not move the MTTR anchor). ' +
  'Returns null on 0 incidents.'

export const incidentReopenRate = {
  id: 'dora.incident_reopen_rate',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: REOPEN_DOC,
  params: {},

  compute(inputs, asOf) {
    const total = inputs.incidents.length

    if (total === 0) {
      return {
        id: 'dora.incident_reopen_rate',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'ratio',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: REOPEN_DOC,
        rate: null,
        reopenedCount: 0,
        totalIncidents: 0,
      }
    }

    const reopened = inputs.incidents.filter((i) => i.reopenCount > 0).length
    const rate = safeRatio(reopened, total)

    return {
      id: 'dora.incident_reopen_rate',
      trustTier: 'deterministic',
      scope: 'team',
      value: rate,
      unit: 'ratio',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: REOPEN_DOC,
      rate,
      reopenedCount: reopened,
      totalIncidents: total,
    }
  },
}
