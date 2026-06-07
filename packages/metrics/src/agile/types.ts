/**
 * Shared input types for Agile / Jira metrics (Group E, SPEC §8.5).
 */

// ---------------------------------------------------------------------------
// Sprint record
// ---------------------------------------------------------------------------

export interface SprintRecord {
  id: string
  boardId: string
  type: 'scrum' | 'kanban'
  startAt: string | null
  endAt: string | null
  completeAt: string | null
}

// ---------------------------------------------------------------------------
// Sprint membership event
// ---------------------------------------------------------------------------

export interface SprintMembershipEventRecord {
  sprintId: string
  issueId: string
  change: 'added' | 'removed'
  /** Story points at the time of the event (null = unmapped). */
  pointsAtEvent: number | null
  transitionedAt: string
  wasPresentAtStart: boolean
}

// ---------------------------------------------------------------------------
// Issue record (minimal for velocity/estimation)
// ---------------------------------------------------------------------------

export interface IssueRecord {
  id: string
  /** Jira hierarchy level: 0=epic, 1=story/task, 2=subtask. */
  hierarchyLevel: number
  parentId: string | null
  isSubtask: boolean
  storyPoints: number | null
  /** True when the story-point field is mapped for this project. */
  storyPointsFieldMapped: boolean
  statusCategory: 'new' | 'indeterminate' | 'done'
  /** IDs of sprints this issue completed in (first Done per §8.6 dedup policy). */
  completedInSprintIds: readonly string[]
  /** True if the issue was reopened after Done (§8.6 reopen policy). */
  wasReopened: boolean
  type: string
}
