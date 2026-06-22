/**
 * Canonical set of Jira issue-type names that classify as "bug" work.
 * Used by priorityMix, flowDistribution, and the person classifier so they
 * cannot drift independently.
 */

export const BUG_TYPES = new Set(['bug', 'defect', 'hotfix', 'incident', 'fix'])

/**
 * Returns true when the lowercased issue type string is a recognised bug type.
 * @param {string} type
 * @returns {boolean}
 */
export function isBugType(type) {
  if (typeof type !== 'string') return false
  return BUG_TYPES.has(type.toLowerCase())
}
