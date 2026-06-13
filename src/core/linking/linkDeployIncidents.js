/**
 * Deploy ↔ incident linking (DORA CFR / recovery / rework attribution).
 *
 * There is no authoritative deploy↔incident join in the source systems (Jira
 * incidents carry no deploy reference), so we attribute each incident to the
 * MOST RECENT production deployment whose createdAt precedes the incident within
 * a proximity window — the standard DORA temporal-proximity approximation. This
 * module PERSISTS that attribution (link_type='proximity') so it is inspectable
 * via query_db and reusable by the insight/reporting layer, rather than only
 * being recomputed inside the metric engine.
 *
 * Single-org DB: incidents (which carry no repo) are linked across all synced
 * repos' production deployments, matching the single-team aggregate scope model.
 */

/** Default proximity window: 7 days (DORA "failed deployment recovery" guidance). */
export const INCIDENT_DEPLOY_PROXIMITY_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Pure proximity linker. Returns `{ deployId, incidentIssueId }` for every
 * incident that has a preceding production deploy within `proximityMs`.
 *
 * @param prodDeploys  Production deployments with `{ id, createdAt }`.
 * @param incidents    Incident issues with `{ id, createdAt }`.
 */
export function linkDeploysToIncidents(
  prodDeploys,
  incidents,
  proximityMs = INCIDENT_DEPLOY_PROXIMITY_MS,
) {
  const sorted = [...prodDeploys]
    .map((d) => ({ id: d.id, ms: new Date(d.createdAt).getTime() }))
    .filter((d) => Number.isFinite(d.ms))
    .sort((a, b) => a.ms - b.ms)

  const links = []
  for (const incident of incidents) {
    const openedMs = new Date(incident.createdAt).getTime()
    if (!Number.isFinite(openedMs)) continue
    // Newest→oldest: first deploy that precedes the incident within the window wins.
    for (let i = sorted.length - 1; i >= 0; i--) {
      const d = sorted[i]
      if (d === undefined || d.ms > openedMs) continue
      if (openedMs - d.ms > proximityMs) break
      links.push({ deployId: d.id, incidentIssueId: incident.id })
      break
    }
  }
  return links
}

/**
 * Recompute and persist proximity deploy↔incident links from the current store
 * contents. Idempotent: clears existing proximity links and rewrites them in one
 * transaction. Best-effort attribution metadata for the DORA metrics + insight
 * layer; the metric engine still computes its own linkage, so a failure here does
 * not change metric values.
 *
 * @returns `{ linksUpserted }`
 */
export async function linkDeployIncidents(store, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const proximityMs = options.proximityMs ?? INCIDENT_DEPLOY_PROXIMITY_MS

  const prodDeploys = (await store.listAllDeployments()).filter(
    (d) => d.environment === 'production',
  )
  const incidents = await store.listIncidentIssues()
  const links = linkDeploysToIncidents(prodDeploys, incidents, proximityMs)

  await store.transaction(async () => {
    await store.clearDeployIncidentLinks('proximity')
    for (const link of links) {
      await store.upsertDeployIncidentLink({
        deployId: link.deployId,
        incidentIssueId: link.incidentIssueId,
        linkType: 'proximity',
        linkedAt: now,
      })
    }
  })

  return { linksUpserted: links.length }
}
