/**
 * Golden tests for Agile / Jira metrics (Group E).
 *
 * Degenerate-input goldens per SPEC WP-METRICS-AGILE DoD:
 *   - New sprint with unmapped story-point field → velocity null
 *   - 0 committed → Say/Do null (not NaN)
 *   - n=1 → predictability null (insufficient_sample)
 *   - Subtask + parent both pointed → velocity counts once (no double-count)
 *   - Kanban board → velocity null (degrades gracefully)
 */

import { ENGINE_VERSION } from '@lazy-flow/core'
import { baseOrg, IDS } from '@lazy-flow/testkit'
import { describe, expect, it } from 'vitest'
import type { EstimationPair } from './estimationAccuracy.js'
import {
  estimationAccuracy,
  isSpearmanSignificant,
  sayDo,
  sprintPredictability,
  sprintVelocity,
  tiedSpearman,
} from './index.js'
import type { IssueRecord, SprintMembershipEventRecord, SprintRecord } from './types.js'

const AS_OF = '2024-06-01T12:00:00Z'

// ---------------------------------------------------------------------------
// Build inputs from baseOrg
// ---------------------------------------------------------------------------

const baseSprint = baseOrg.sprints[0]
if (!baseSprint) throw new Error('baseOrg.sprints is empty — testkit is broken')

const sprint: SprintRecord = {
  id: IDS.sprintId,
  boardId: IDS.boardId,
  type: 'scrum',
  startAt: baseSprint.startAt,
  endAt: baseSprint.endAt,
  completeAt: baseSprint.completeAt,
}

const membershipEvents: SprintMembershipEventRecord[] = baseOrg.sprintMembershipEvents.map((e) => ({
  sprintId: e.sprintId,
  issueId: e.issueId,
  change: e.change,
  pointsAtEvent: e.pointsAtEvent,
  transitionedAt: e.transitionedAt,
  wasPresentAtStart: e.wasPresentAtStart,
}))

// Build issue records from baseOrg
const issues: IssueRecord[] = baseOrg.jiraIssues.map((issue) => {
  const transitions = baseOrg.issueTransitions[issue.id] ?? []
  const sorted = [...transitions].sort(
    (a, b) => new Date(a.transitionedAt).getTime() - new Date(b.transitionedAt).getTime(),
  )
  const doneTransitions = sorted.filter((t) => t.toStatusId === IDS.statusDone)
  const reopenTransitions = sorted.filter((t) => t.fromStatusId === IDS.statusDone)
  const wasReopened = reopenTransitions.length > 0
  // completedInSprintIds: simplified — if statusCategory='done' and has done transitions
  const completedInSprintIds = doneTransitions.length > 0 ? [IDS.sprintId] : []

  return {
    id: issue.id,
    hierarchyLevel: issue.hierarchyLevel,
    parentId: issue.parentId,
    isSubtask: issue.isSubtask,
    storyPoints: issue.storyPoints,
    storyPointsFieldMapped: issue.storyPointsFieldId !== null,
    statusCategory: issue.statusCategory,
    completedInSprintIds,
    wasReopened,
    type: issue.type,
  }
})

// ---------------------------------------------------------------------------
// Sprint Velocity
// ---------------------------------------------------------------------------

describe('sprintVelocity', () => {
  it('computes velocity from sprint-1 — counting at level 1 (story), not double-counting subtasks', () => {
    // Sprint-1 has:
    //   - story-1: present at start (wasPresentAtStart=true), 5 points, statusDone
    //   - subtask-1: added mid-sprint then REMOVED
    // After removal, subtask-1 not in final member set
    // story-1 is level=1 (count level), so 5 points
    // subtask-1 level=2 → rolls up to story-1 (parent), but parent has points → skip subtask
    // Committed = story-1 (5 pts); subtask-1 was never at start
    const result = sprintVelocity.compute({ sprint, membershipEvents, issues }, AS_OF)

    expect(result.id).toBe('agile.sprint_velocity')
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    expect(result.pointsFieldMapped).toBe(true)
    expect(result.isKanban).toBe(false)
    // committed: story-1 at start = 5
    expect(result.committed).toBe(5)
    // completed: story-1 is done and in final member set
    expect(result.completed).toBeGreaterThan(0)
    expect(result.dataQuality).toBe('ok')
  })

  it('subtask + parent both pointed → velocity counts once (parent wins)', () => {
    // story-1 (5 pts, level 1) + subtask-1 (3 pts, level 2, parent=story-1)
    // At countLevel=1: story-1 is counted, subtask-1 rolls up to story-1 which has points → skip
    // Result: 5 pts, not 8
    const storyEvents: SprintMembershipEventRecord[] = [
      {
        sprintId: IDS.sprintId,
        issueId: IDS.issueStory1,
        change: 'added',
        pointsAtEvent: 5,
        transitionedAt: '2024-02-05T00:00:00Z',
        wasPresentAtStart: true,
      },
      {
        sprintId: IDS.sprintId,
        issueId: IDS.issueSubtask1,
        change: 'added',
        pointsAtEvent: 3,
        transitionedAt: '2024-02-05T00:00:00Z',
        wasPresentAtStart: true,
      },
    ]

    const result = sprintVelocity.compute(
      { sprint, membershipEvents: storyEvents, issues, countLevel: 1 },
      AS_OF,
    )

    expect(result.committed).toBe(5) // NOT 8 (no double-count)
    expect(result.pointsFieldMapped).toBe(true)
  })

  it('subtask in sprint but pointed parent NOT in sprint → counts the subtask (no silent drop)', () => {
    // Only the subtask is a sprint member; its pointed parent is outside the
    // sprint set. The parent is never iterated, so skipping the subtask (the old
    // behaviour) dropped BOTH the parent's and the subtask's points. The subtask
    // must be counted instead.
    const subtaskOnlyEvents: SprintMembershipEventRecord[] = [
      {
        sprintId: IDS.sprintId,
        issueId: IDS.issueSubtask1,
        change: 'added',
        pointsAtEvent: 3,
        transitionedAt: '2024-02-05T00:00:00Z',
        wasPresentAtStart: true,
      },
    ]
    const twoIssues: IssueRecord[] = [
      {
        id: IDS.issueStory1,
        hierarchyLevel: 1,
        parentId: null,
        isSubtask: false,
        storyPoints: 5, // parent has points but is NOT a sprint member
        storyPointsFieldMapped: true,
        statusCategory: 'indeterminate',
        completedInSprintIds: [],
        wasReopened: false,
        type: 'Story',
      },
      {
        id: IDS.issueSubtask1,
        hierarchyLevel: 2,
        parentId: IDS.issueStory1,
        isSubtask: true,
        storyPoints: 3,
        storyPointsFieldMapped: true,
        statusCategory: 'indeterminate',
        completedInSprintIds: [],
        wasReopened: false,
        type: 'Sub-task',
      },
    ]
    const result = sprintVelocity.compute(
      { sprint, membershipEvents: subtaskOnlyEvents, issues: twoIssues, countLevel: 1 },
      AS_OF,
    )
    expect(result.committed).toBe(3)
  })

  it('unmapped story-point field → velocity null (flagged, not 0)', () => {
    const unmappedIssues: IssueRecord[] = issues.map((i) => ({
      ...i,
      storyPointsFieldMapped: false,
    }))
    const result = sprintVelocity.compute(
      { sprint, membershipEvents, issues: unmappedIssues },
      AS_OF,
    )
    expect(result.value).toBeNull()
    expect(result.committed).toBeNull()
    expect(result.completed).toBeNull()
    expect(result.pointsFieldMapped).toBe(false)
    expect(result.dataQuality).toBe('no_data')
  })

  it('kanban board → velocity null (degrades gracefully)', () => {
    const kanbanSprint: SprintRecord = { ...sprint, type: 'kanban' }
    const result = sprintVelocity.compute({ sprint: kanbanSprint, membershipEvents, issues }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.isKanban).toBe(true)
    expect(result.dataQuality).toBe('no_data')
  })
})

// ---------------------------------------------------------------------------
// Say/Do Ratio
// ---------------------------------------------------------------------------

describe('sayDo', () => {
  it('computes ratio from committed and completed', () => {
    const result = sayDo.compute({ committed: 10, completed: 8 }, AS_OF)
    expect(result.id).toBe('agile.say_do')
    expect(result.ratio).toBeCloseTo(0.8, 5)
    expect(result.dataQuality).toBe('ok')
  })

  it('0 committed → ratio null (not NaN)', () => {
    const result = sayDo.compute({ committed: 0, completed: 5 }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.ratio).toBeNull()
    expect(result.dataQuality).toBe('no_data')
    // Critical: never NaN
    expect(Number.isNaN(result.ratio as unknown as number)).toBe(false)
  })

  it('null committed (unmapped) → ratio null', () => {
    const result = sayDo.compute({ committed: null, completed: null }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.ratio).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })

  it('over-delivery → ratio > 1', () => {
    const result = sayDo.compute({ committed: 5, completed: 7 }, AS_OF)
    expect(result.ratio).toBeCloseTo(1.4, 5)
  })
})

// ---------------------------------------------------------------------------
// Sprint Predictability
// ---------------------------------------------------------------------------

describe('sprintPredictability', () => {
  it('computes predictability from 3 historical sprints', () => {
    const sprints = [
      { sprintId: 's1', committed: 10, completed: 10 },
      { sprintId: 's2', committed: 10, completed: 9 }, // 10% deviation ≤ 20%
      { sprintId: 's3', committed: 10, completed: 7 }, // 30% deviation > 20%
    ]
    const result = sprintPredictability.compute({ sprints }, AS_OF)
    expect(result.id).toBe('agile.sprint_predictability')
    expect(result.predictabilityScore).toBeCloseTo(2 / 3, 5)
    expect(result.sprintsWithinTolerance).toBe(2)
    expect(result.totalSprints).toBe(3)
    expect(result.dataQuality).toBe('ok')
  })

  it('n=1 sprint → predictability null (insufficient_sample)', () => {
    const result = sprintPredictability.compute(
      { sprints: [{ sprintId: 's1', committed: 10, completed: 10 }] },
      AS_OF,
    )
    expect(result.value).toBeNull()
    expect(result.predictabilityScore).toBeNull()
    expect(result.dataQuality).toBe('insufficient_sample')
  })

  it('n=0 → dataQuality no_data', () => {
    const result = sprintPredictability.compute({ sprints: [] }, AS_OF)
    expect(result.value).toBeNull()
    expect(result.dataQuality).toBe('no_data')
  })

  it('score bounded to [0, 1] always', () => {
    const extreme = [
      { sprintId: 's1', committed: 10, completed: 1 },
      { sprintId: 's2', committed: 10, completed: 1 },
    ]
    const result = sprintPredictability.compute({ sprints: extreme }, AS_OF)
    if (result.predictabilityScore !== null) {
      expect(result.predictabilityScore).toBeGreaterThanOrEqual(0)
      expect(result.predictabilityScore).toBeLessThanOrEqual(1)
    }
  })

  it('sprints with 0 committed are excluded from denominator', () => {
    const sprints = [
      { sprintId: 's1', committed: 0, completed: 0 }, // excluded
      { sprintId: 's2', committed: 10, completed: 10 }, // within tolerance
      { sprintId: 's3', committed: 10, completed: 10 }, // within tolerance
    ]
    const result = sprintPredictability.compute({ sprints }, AS_OF)
    // Only s2 and s3 are valid (n=2), both within tolerance
    expect(result.predictabilityScore).toBeCloseTo(1, 5)
    expect(result.totalSprints).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Estimation Accuracy (Spearman)
// ---------------------------------------------------------------------------

describe('estimationAccuracy', () => {
  it('computes Spearman ρ for correlated estimates', () => {
    // Larger story points → longer cycle time (positive correlation)
    const pairs: EstimationPair[] = [
      { issueId: 'i1', storyPoints: 1, cycleTimeSeconds: 3600, wasReopened: false },
      { issueId: 'i2', storyPoints: 2, cycleTimeSeconds: 7200, wasReopened: false },
      { issueId: 'i3', storyPoints: 3, cycleTimeSeconds: 10800, wasReopened: false },
      { issueId: 'i4', storyPoints: 5, cycleTimeSeconds: 18000, wasReopened: false },
      { issueId: 'i5', storyPoints: 8, cycleTimeSeconds: 28800, wasReopened: false },
      { issueId: 'i6', storyPoints: 13, cycleTimeSeconds: 46800, wasReopened: false },
    ]
    const result = estimationAccuracy.compute({ pairs }, AS_OF)
    expect(result.id).toBe('agile.estimation_accuracy')
    expect(result.suppressed).toBe(false)
    expect(result.spearman).not.toBeNull()
    expect(result.spearman as number).toBeGreaterThan(0.9)
    expect(result.isSignificant).toBe(true)
  })

  it('n < minN → suppressed with insufficient_sample', () => {
    const pairs: EstimationPair[] = [
      { issueId: 'i1', storyPoints: 3, cycleTimeSeconds: 3600, wasReopened: false },
      { issueId: 'i2', storyPoints: 5, cycleTimeSeconds: 7200, wasReopened: false },
    ]
    const result = estimationAccuracy.compute({ pairs, minN: 5 }, AS_OF)
    expect(result.suppressed).toBe(true)
    expect(result.spearman).toBeNull()
    expect(result.dataQuality).toBe('insufficient_sample')
  })

  it('excludes reopened issues', () => {
    const pairs: EstimationPair[] = [
      { issueId: 'i1', storyPoints: 3, cycleTimeSeconds: 3600, wasReopened: true },
      { issueId: 'i2', storyPoints: 3, cycleTimeSeconds: 3600, wasReopened: false },
      { issueId: 'i3', storyPoints: 5, cycleTimeSeconds: 7200, wasReopened: false },
    ]
    // Only 2 eligible after filtering reopened + requiring minN=5
    const result = estimationAccuracy.compute({ pairs, minN: 5 }, AS_OF)
    expect(result.sampleSize).toBe(2) // only non-reopened
    expect(result.suppressed).toBe(true)
  })

  it('excludes 0-point issues', () => {
    const pairs: EstimationPair[] = [
      { issueId: 'i1', storyPoints: 0, cycleTimeSeconds: 3600, wasReopened: false }, // excluded
      { issueId: 'i2', storyPoints: 3, cycleTimeSeconds: 7200, wasReopened: false },
    ]
    const result = estimationAccuracy.compute({ pairs, minN: 5 }, AS_OF)
    expect(result.sampleSize).toBe(1) // only 1 valid
  })

  it('tiedSpearman — handles ties correctly', () => {
    // All same story points → all tied → ρ should be null (no variance)
    const rho = tiedSpearman([3, 3, 3], [1000, 2000, 3000])
    expect(rho).toBeNull()
  })

  it('isSpearmanSignificant — strong correlation at n=6 is significant', () => {
    // ρ = 1.0 at any n > 3 is significant
    expect(isSpearmanSignificant(1.0, 6)).toBe(true)
  })

  it('isSpearmanSignificant — weak correlation at small n is not significant', () => {
    expect(isSpearmanSignificant(0.2, 5)).toBe(false)
  })
})
