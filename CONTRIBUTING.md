# Contributing to lazy-flow

## Prerequisites

| Tool | Required version | Notes |
|---|---|---|
| **Node.js** | ≥ 22 (pinned: 25 in CI) | Uses `node:sqlite` built-in (stable from Node 22) |
| **npm** | ≥ 10 | Workspace support required |
| **TypeScript** | 5.7+ | Installed as devDependency via workspace root |

Clone the repo and install:

```sh
git clone https://github.com/your-org/lazy-flow.git
cd lazy-flow
npm install
```

No build step is required for development — the workspace exports point directly to
TypeScript source files (`"exports": { ".": "./src/index.ts" }`).

---

## Workspace layout

```
lazy-flow/
├── packages/
│   ├── core/            # domain types, Store interface, NodeSqliteStore, migrations, identity
│   ├── ingest-github/   # octokit REST+GraphQL adapter, 3-phase sync
│   ├── ingest-jira/     # Jira REST v3 + Agile + bulk changelog adapter
│   ├── metrics/         # deterministic metric engine (Groups A–E), formulaDocs, golden tests
│   ├── code-analysis/   # web-tree-sitter complexity, HALOC, blame / work-type
│   ├── ai/              # prompt registry, Claude client, calibration harness, ai_verdicts
│   ├── mcp-server/      # MCP tools/resources, bundled via tsup → server/dist/server.js
│   ├── orchestrator/    # sync orchestrator, freshness tracking, issue linking
│   └── testkit/         # MSW handlers, fixture corpora, synthetic base-org dataset
├── docs/                # SPEC.md, WORKPLAN.md, FORMULAS.md, ARCHITECTURE.md, etc.
├── biome.json           # format + lint config (single quotes, no semis, 2-space, width 100)
├── tsconfig.base.json   # strict ESM TypeScript config
└── vitest.config.ts     # test runner config
```

Each package has its own `package.json` with `"type": "module"` and direct TypeScript
source exports. There are no compiled artefacts in development — only the `mcp-server`
bundle (`tsup`) is compiled for distribution.

---

## Daily development commands

```sh
# Format (writes changes)
npm run format

# Lint + format check (CI fails on diff)
npm run lint

# Type-check (whole workspace, noEmit)
npm run typecheck

# Run all tests
npm test

# All three in one (equivalent to CI gate)
npm run check
```

All commands run from the **workspace root** and apply to all packages. You do not need
to `cd` into individual packages.

---

## Code style

Enforced by **Biome** (`biome.json`):

- Single quotes, no semicolons
- 2-space indentation, line width 100
- ESLint-recommended rules; `lint` is a hard CI gate

TypeScript rules (`tsconfig.base.json`):

- `strict: true` — no implicit any, strict null checks
- `noUncheckedIndexedAccess: true` — array/object indexing returns `T | undefined`
- `verbatimModuleSyntax: true` — type-only imports must use `import type`
- No `any` without a comment explaining why it is unavoidable
- **Explicit return types on all exported functions**

---

## §8.6 determinism rules (MANDATORY for metric contributors)

These rules are enforced by the Engine Determinism & Reproducibility Contract (SPEC §8.6)
and are required for every metric that lives under `packages/metrics/src/`.

### No wall-clock or RNG in metric paths

```ts
// WRONG — non-deterministic
const now = Date.now()
const x = Math.random()

// RIGHT — inject clock and seed
function compute(inputs: MyInputs, asOf: string): MyResult {
  const nowMs = new Date(asOf).getTime()
  // ...
}
```

The linter enforces this: `Date.now()` and `Math.random()` in metric paths will fail CI.
Use the injected `asOf` parameter (ISO-8601 string) for the clock and the vendored
`createPrng(seed)` (mulberry32) for any simulation that requires randomness.

### Every metric module must export the §8.6 contract

```ts
export const myMetric: MetricModule<MyInputs, MyResult> = {
  id: 'group.metric_name',          // snake_case dot-namespaced
  trustTier: 'deterministic',       // | 'hybrid' | 'probabilistic'
  scope: 'team',                    // | 'repo' | 'org' | 'person' | 'self'
  formulaDoc: FORMULA_DOC,          // non-empty string; published in docs/FORMULAS.md
  params: { windowDays: 28 },       // defaults; overridable at call-site
  compute(inputs, asOf): MyResult { /* ... */ },
}
```

The `formulaDoc` string is published verbatim in `docs/FORMULAS.md` and shown to users
via the MCP `explain_metric` tool. Write it as plain English that a non-engineer can read.

### Zero-denominator → null, not NaN/0

```ts
// WRONG — NaN escapes into downstream aggregations
const rate = failures / total

// RIGHT — use safeRatio from @lazy-flow/core
import { safeRatio } from '@lazy-flow/core'
const rate = safeRatio(failures, total) // returns null when total === 0
```

### Enum-encode AI outputs (hybrid metrics)

For hybrid metrics that delegate to the LLM layer (Wave 5), AI outputs must be
schema/enum-bounded — never free-form numbers. Bounded enums prevent the LLM from
emitting out-of-range values that corrupt downstream metric state.

### Append-only barrels

`packages/metrics/src/index.ts` is the public barrel. When adding a new metric:

1. Add the metric module file under the appropriate group subdirectory.
2. Export types and the module object from the group's `index.ts`.
3. **Append** the exports to `packages/metrics/src/index.ts` — do not remove or
   reorder existing exports (barrel is append-only).
4. Update `docs/FORMULAS.md` by running `npm run generate:formulas` (see below).
5. Update the metric count in `packages/metrics/src/formulas.test.ts`.

---

## Adding a new metric — step-by-step

1. **Create the module** under `packages/metrics/src/<group>/myMetric.ts` following
   the `MetricModule` contract above.
2. **Write co-located golden tests** in the same directory (e.g. `myMetric.test.ts`
   or add cases to the group test file). Golden tests must include:
   - The happy-path case.
   - Zero-denominator → `null` (not `NaN`).
   - Empty window / below sample floor → `data_quality: 'insufficient_sample'`.
   - Any edge cases called out in SPEC §8.6 for that metric type.
3. **Export** from the group barrel and from `packages/metrics/src/index.ts`.
4. **Regenerate `docs/FORMULAS.md`**: `npm run generate:formulas`.
5. **Update the metric count** in `packages/metrics/src/formulas.test.ts`.
6. Run `npm run check` — all four gates must be green.

---

## Regenerating the formula reference

`docs/FORMULAS.md` is generated from the `formulaDoc` strings in each metric module.
After adding or changing a metric's `formulaDoc`, regenerate it:

```sh
npm run generate:formulas
```

This runs `scripts/generate-formulas.ts` which imports every metric module and writes
the Markdown file. The `formulas.test.ts` test asserts that every registered metric is
covered, so CI will fail if the doc is stale.

---

## Rebuilding the MCP server bundle

The MCP server (`packages/mcp-server/`) is bundled to a single `server/dist/server.js`
via tsup for distribution. You do not need to rebuild during development, but if you
need to test the bundle:

```sh
npm run build
```

The bundle must boot with `node server.js` on a clean machine without any install step —
this is verified by the WP-E2E cross-ABI smoke test.

---

## Testing conventions

- **Tests on behaviour, not implementation.** Assert what the code does (outputs,
  side effects) not how (internal state, private methods).
- **MSW for HTTP mocks.** Use `mockGitHub()` and `mockJira()` from `@lazy-flow/testkit`
  for any test that calls the GitHub or Jira APIs.
- **Fixture isolation.** Never mutate shared fixtures (`baseOrg` is deep-frozen).
  Clone what you need: `{ ...baseOrg.issues[0], id: 'my-test-id' }`.
- **Deterministic time.** Use `fakeClock` from `@lazy-flow/testkit` or pass an explicit
  `asOf` ISO string. No `new Date()` or `Date.now()` in tests.

---

## Reporting bugs and security issues

- **Bugs:** open a GitHub issue.
- **Security vulnerabilities:** see `SECURITY.md` for the responsible disclosure process.
