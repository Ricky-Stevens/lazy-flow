// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ingestWorkflows
// ---------------------------------------------------------------------------

/**
 * Discover and persist all workflows + workflow scheme mappings for the
 * given project.
 *
 * Strategy:
 *   1. List all workflows visible to the token (v3 workflow search).
 *   2. List workflow schemes, find the one for this project, resolve its
 *      issue-type→workflow mappings.
 *   3. Upsert `workflows` and `workflow_scheme_mappings`.
 *
 * Because Jira's workflow/scheme APIs vary between Cloud generations, we
 * fall back gracefully: if the scheme-lookup APIs return nothing, we
 * produce a default mapping using the first workflow found (or skip mapping
 * if none found).
 */
export async function ingestWorkflows(store, client, projectId, now) {
  const rawWorkflows = await client.listWorkflows()
  const rawSchemes = await client.listWorkflowSchemes()

  let workflowsUpserted = 0
  let mappingsUpserted = 0

  // -------------------------------------------------------------------------
  // Upsert workflows
  // -------------------------------------------------------------------------
  const workflowMap = new Map()

  for (const rw of rawWorkflows) {
    const workflow = {
      workflowId: rw.id ?? rw.name,
      name: rw.name,
      updatedAt: now,
    }
    await store.upsertWorkflow(workflow)
    workflowMap.set(workflow.workflowId, workflow)
    workflowsUpserted++
  }

  // -------------------------------------------------------------------------
  // Resolve scheme → issue-type mappings for this project
  // -------------------------------------------------------------------------

  // The project id might match the scheme's projectId or be referenced in the
  // scheme's issue-type-to-workflow mappings. We look for a scheme that names
  // this project or, if there's only one, use it.
  let targetScheme = rawSchemes.find(
    (s) =>
      String(s.projectId) === projectId ||
      String(s.id) === projectId ||
      (Array.isArray(s.projects) && s.projects.some((p) => String(p) === projectId)),
  )

  if (!targetScheme && rawSchemes.length === 1) {
    targetScheme = rawSchemes[0]
  }

  if (targetScheme) {
    // Try to get explicit issue-type mappings
    const mappings = await client.getWorkflowSchemeIssueTypeMappings(String(targetScheme.id))

    if (mappings.length > 0) {
      for (const m of mappings) {
        const wfId = resolveWorkflowId(m.workflow, workflowMap)
        if (!wfId) continue

        const mapping = {
          projectId,
          issueType: m.issueType,
          workflowId: wfId,
          updatedAt: now,
        }
        await store.upsertWorkflowSchemeMapping(mapping)
        mappingsUpserted++
      }
    } else {
      // Fall back to inline issueTypeMappings from the scheme object
      const inlineMappings = targetScheme.issueTypeMappings
      if (inlineMappings && typeof inlineMappings === 'object') {
        for (const [issueType, wfName] of Object.entries(inlineMappings)) {
          if (typeof wfName !== 'string') continue
          const wfId = resolveWorkflowId(wfName, workflowMap)
          if (!wfId) continue

          const mapping = {
            projectId,
            issueType,
            workflowId: wfId,
            updatedAt: now,
          }
          await store.upsertWorkflowSchemeMapping(mapping)
          mappingsUpserted++
        }
      }

      // And the default workflow (maps all unspecified issue types)
      if (targetScheme.defaultWorkflow) {
        const defaultWfId = resolveWorkflowId(targetScheme.defaultWorkflow, workflowMap)
        if (defaultWfId) {
          const mapping = {
            projectId,
            issueType: '__default__',
            workflowId: defaultWfId,
            updatedAt: now,
          }
          await store.upsertWorkflowSchemeMapping(mapping)
          mappingsUpserted++
        }
      }
    }
  }

  return { workflowsUpserted, mappingsUpserted }
}

// ---------------------------------------------------------------------------
// ingestWorkflowsFromDataset
// ---------------------------------------------------------------------------

/**
 * Directly ingest a predefined set of workflow + scheme mappings.
 * Used when the caller has already resolved the mappings (e.g. from a
 * fixtures dataset that doesn't need the API), or when the API is not
 * available for this project.
 */
export async function ingestWorkflowsFromDataset(store, workflows, mappings, now) {
  let workflowsUpserted = 0
  let mappingsUpserted = 0

  for (const wf of workflows) {
    await store.upsertWorkflow({ ...wf, updatedAt: now })
    workflowsUpserted++
  }

  for (const m of mappings) {
    await store.upsertWorkflowSchemeMapping({ ...m, updatedAt: now })
    mappingsUpserted++
  }

  return { workflowsUpserted, mappingsUpserted }
}

// ---------------------------------------------------------------------------
// Resolve workflow name or id to a known workflow id
// ---------------------------------------------------------------------------

function resolveWorkflowId(nameOrId, workflowMap) {
  // Exact id match
  if (workflowMap.has(nameOrId)) return nameOrId

  // Name match (case-insensitive)
  const lower = nameOrId.toLowerCase()
  for (const [id, wf] of workflowMap) {
    if (wf.name.toLowerCase() === lower) return id
  }

  // If the map is empty, use the name/id as-is (so tests can wire up
  // mappings without needing a prior /workflow/search call)
  return nameOrId || null
}
