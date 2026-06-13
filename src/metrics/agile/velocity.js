import { ENGINE_VERSION } from '../../core/index.js'

const FORMULA_DOC =
  'Sprint Velocity (SPEC §8.5, §8.6): ' +
  'committed = sum of points for issues present at sprint start (wasPresentAtStart=true). ' +
  'completed = sum of points for issues with statusCategory=done at sprint end. ' +
  'Points counted at ONE hierarchy level (default: level 1 stories/tasks). ' +
  'Subtask points roll up to parent: if parent has points, count parent; ' +
  'if parent has no points, count subtask. Never double-count. ' +
  'Returns null (not 0) when story-point field is unmapped. ' +
  'Kanban boards return null — use throughput/cycle-time instead.'

/**
 * Roll up points to the configured count level.
 * For each issue:
 *   - If hierarchyLevel === countLevel → use its own points.
 *   - If hierarchyLevel > countLevel (subtask) → roll up to parent; if parent has points, skip.
 *   - If hierarchyLevel < countLevel (epic) → skip.
 *
 * Returns a map from "representative issue id" → points.
 * Issues not in the sprint are filtered by the caller.
 */
function rollUpPoints(issueIds, allIssues, countLevel) {
  const issueMap = new Map()
  for (const issue of allIssues) {
    issueMap.set(issue.id, issue)
  }

  const result = new Map()

  for (const issueId of issueIds) {
    const issue = issueMap.get(issueId)
    if (!issue) continue

    if (issue.hierarchyLevel === countLevel) {
      // Count at this level
      if (issue.storyPoints !== null && issue.storyPoints > 0) {
        result.set(issue.id, issue.storyPoints)
      }
    } else if (issue.hierarchyLevel > countLevel) {
      // Subtask: roll up to parent
      if (!issue.parentId) continue
      const parent = issueMap.get(issue.parentId)
      if (!parent) continue

      // Skip the subtask ONLY when its pointed parent is itself in the sprint
      // set — then the parent's own entry counts those points. If the parent
      // has points but is NOT in the set, it is never iterated, so skipping the
      // subtask here would silently drop both the parent's and the subtask's
      // points; fall through to count the subtask instead.
      if (parent.storyPoints !== null && parent.storyPoints > 0 && issueIds.has(parent.id)) {
        continue
      }
      // Parent has no points (or is out of the sprint) → use subtask points
      if (issue.storyPoints !== null && issue.storyPoints > 0) {
        // Use the subtask id as representative, keyed under parent to avoid double-count
        const key = `subtask-rollup:${issue.parentId ?? issue.id}`
        const existing = result.get(key) ?? 0
        result.set(key, existing + issue.storyPoints)
      }
    }
    // hierarchyLevel < countLevel (epics): skip
  }

  return result
}

export const sprintVelocity = {
  id: 'agile.sprint_velocity',
  trustTier: 'deterministic',
  scope: 'team',
  formulaDoc: FORMULA_DOC,
  params: { countLevel: 1 },

  compute(inputs, asOf) {
    const { sprint, membershipEvents, issues, countLevel = 1 } = inputs

    // Kanban boards: degrade gracefully
    if (sprint.type === 'kanban') {
      return {
        id: 'agile.sprint_velocity',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'points',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        committed: null,
        completed: null,
        addedAfterStart: null,
        pointsFieldMapped: false,
        isKanban: true,
      }
    }

    // Check if story-point field is mapped for any issue in this sprint
    const sprintIssueIds = new Set(membershipEvents.map((e) => e.issueId))
    const sprintIssues = issues.filter((i) => sprintIssueIds.has(i.id))
    const pointsFieldMapped = sprintIssues.some((i) => i.storyPointsFieldMapped)

    // Null when story-point field unmapped (SPEC §8.5)
    if (!pointsFieldMapped) {
      return {
        id: 'agile.sprint_velocity',
        trustTier: 'deterministic',
        scope: 'team',
        value: null,
        unit: 'points',
        dataQuality: 'no_data',
        engineVersion: ENGINE_VERSION,
        asOf,
        formulaDoc: FORMULA_DOC,
        committed: null,
        completed: null,
        addedAfterStart: null,
        pointsFieldMapped: false,
        isKanban: false,
      }
    }

    // Committed: issues present at sprint start
    const committedIds = new Set(
      membershipEvents
        .filter((e) => e.wasPresentAtStart && e.change === 'added')
        .map((e) => e.issueId),
    )

    // Added after start (for transparency)
    const addedAfterStartIds = new Set(
      membershipEvents
        .filter((e) => !e.wasPresentAtStart && e.change === 'added')
        .map((e) => e.issueId),
    )

    // Removed before end: subtract from counts
    const removedIds = new Set(
      membershipEvents.filter((e) => e.change === 'removed').map((e) => e.issueId),
    )

    // Final member set = added - removed
    const finalMemberIds = new Set(
      [...membershipEvents.filter((e) => e.change === 'added').map((e) => e.issueId)].filter(
        (id) => !removedIds.has(id),
      ),
    )

    // Completed: final members with statusCategory='done' at sprint end.
    // wasReopened is irrelevant for velocity — if the issue is 'done' at sprint close, it counts.
    // (wasReopened exclusion applies to estimation accuracy, not velocity.)
    const completedIds = new Set(
      sprintIssues
        .filter((i) => finalMemberIds.has(i.id) && i.statusCategory === 'done')
        .map((i) => i.id),
    )

    // Roll up and sum points
    const committedPoints = rollUpPoints(committedIds, issues, countLevel)
    const completedPoints = rollUpPoints(completedIds, issues, countLevel)
    const addedAfterStartPoints = rollUpPoints(addedAfterStartIds, issues, countLevel)

    const sumPoints = (m) => [...m.values()].reduce((a, b) => a + b, 0)

    const committed = sumPoints(committedPoints)
    const completed = sumPoints(completedPoints)
    const addedAfterStart = sumPoints(addedAfterStartPoints)

    return {
      id: 'agile.sprint_velocity',
      trustTier: 'deterministic',
      scope: 'team',
      value: completed,
      unit: 'points',
      dataQuality: 'ok',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FORMULA_DOC,
      committed,
      completed,
      addedAfterStart,
      pointsFieldMapped: true,
      isKanban: false,
    }
  },
}
