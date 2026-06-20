/**
 * Deterministic path / work-type classifiers (phase-1, no LLM). These are the
 * cheap priors the hybrid metrics use; the in-session Claude verdict layer can
 * later override low-confidence cases. Pure functions over file paths + Jira
 * issue types — no store, no I/O.
 */

const TEST_RE =
  /(^|\/)(tests?|__tests__|spec|specs|e2e)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i
const DOCS_RE = /(^|\/)docs?(\/|$)|\.(md|mdx|rst|txt|adoc)$|(^|\/)(readme|changelog|license)/i
const CONFIG_RE =
  /\.(ya?ml|toml|ini|cfg|conf|json5?|lock|env)$|(^|\/)\.[^/]+rc(\.[a-z]+)?$|(^|\/)(dockerfile|makefile|\.github|\.gitlab)/i
const GENERATED_RE =
  /(^|\/)(dist|build|out|vendor|node_modules|generated|__generated__)(\/|$)|\.(min\.[a-z]+|generated\.[a-z]+|pb\.go|g\.dart)$|(^|\/)(package-lock\.json|yarn\.lock|bun\.lockb|go\.sum)$/i

/**
 * Classify a file path into a coarse work surface.
 * Precedence: generated > test > docs > config > prod (the default for source).
 */
export function classifyPath(path) {
  const p = String(path)
  if (GENERATED_RE.test(p)) return 'generated'
  if (TEST_RE.test(p)) return 'test'
  if (DOCS_RE.test(p)) return 'docs'
  if (CONFIG_RE.test(p)) return 'config'
  return 'prod'
}

/** True for a path that is production source (not test/docs/config/generated). */
export function isProdCode(path) {
  return classifyPath(path) === 'prod'
}

/** True for a test file. */
export function isTestFile(path) {
  return classifyPath(path) === 'test'
}

// ---------------------------------------------------------------------------
// Skill-domain taxonomy (path + language → domain)
// ---------------------------------------------------------------------------

const DOMAIN_RULES = [
  ['ci_build', /(^|\/)(\.github|\.gitlab|ci|\.circleci)(\/|$)|(dockerfile|makefile|\.ya?ml$)/i],
  ['infra', /(^|\/)(terraform|infra|deploy|k8s|kubernetes|helm|ansible|\.tf)(\/|$)|\.tf$/i],
  ['auth', /(^|\/)(auth|oauth|login|session|permission|rbac|identity|jwt|token)(\/|$|[._-])/i],
  [
    'database',
    /(^|\/)(db|database|migration|migrations|schema|sql|repository|store|model|entity)(\/|$|[._-])/i,
  ],
  [
    'api',
    /(^|\/)(api|controller|handler|route|router|endpoint|graphql|resolver|grpc)(\/|$|[._-])/i,
  ],
  [
    'frontend',
    /(^|\/)(components?|ui|views?|pages?|styles?|css|hooks?)(\/|$)|\.(tsx|jsx|vue|svelte|css|scss)$/i,
  ],
  ['test', /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\./i],
  ['docs', /(^|\/)docs?(\/|$)|\.(md|mdx|rst)$/i],
]

/** Map a file path to a skill domain (first matching rule, else 'other'). */
export function skillDomain(path) {
  const p = String(path)
  for (const [domain, re] of DOMAIN_RULES) {
    if (re.test(p)) return domain
  }
  return 'other'
}

// ---------------------------------------------------------------------------
// Work-type classifier (deterministic prior)
// ---------------------------------------------------------------------------

const FEATURE_TYPES = new Set(['story', 'feature', 'epic', 'new feature'])
const BUG_TYPES = new Set(['bug', 'defect', 'incident', 'hotfix'])
const DEBT_TYPES = new Set(['debt', 'tech debt', 'technical debt', 'chore', 'maintenance'])

/**
 * Classify a unit of work into a bucket. Prefers the Jira issue type when
 * present; otherwise falls back to the dominant changed-path class.
 * @param issueType  Jira issue.type string (may be null)
 * @param paths      changed file paths for the unit (may be empty)
 * Returns one of feature|bug|debt|refactor|test|docs|other.
 */
export function classifyWorkType(issueType, paths = []) {
  if (issueType) {
    const t = String(issueType).toLowerCase()
    if (BUG_TYPES.has(t)) return 'bug'
    if (FEATURE_TYPES.has(t)) return 'feature'
    if (DEBT_TYPES.has(t)) return 'debt'
  }
  // Path-based fallback when no (useful) issue type.
  if (paths.length > 0) {
    const classes = paths.map(classifyPath)
    const prod = classes.filter((c) => c === 'prod').length
    const test = classes.filter((c) => c === 'test').length
    const docs = classes.filter((c) => c === 'docs').length
    if (prod === 0 && test > 0) return 'test'
    if (prod === 0 && docs > 0) return 'docs'
  }
  // A typed-but-unmatched issue (e.g. "Task") with prod changes → feature-ish work.
  return issueType ? 'other' : 'feature'
}
