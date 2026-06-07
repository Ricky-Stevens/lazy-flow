// WP-GDPR-SCAFFOLD — adopter helpers, erasure, org-bound guard, retention
export type { ErasePersonResult } from './erasure.js'
export { erasePerson } from './erasure.js'
export { assertOrgBound } from './orgBound.js'
export { pseudonymize } from './pseudonymize.js'
export type { RetentionConfig } from './retention.js'
export { pruneOlderThan } from './retention.js'
export type { DpiaTemplateOptions } from './templates.js'
export {
  generateDpiaTemplate,
  generateLiaTemplate,
  generateTransparencyNotice,
} from './templates.js'
