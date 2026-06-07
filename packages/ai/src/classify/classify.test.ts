/**
 * Work-type Classification tests — WP-AI-CLASSIFY (SPEC §9.2.5)
 *
 * All tests use FakeLlmClient — no API key, no network.
 */

import { DatabaseSync } from 'node:sqlite'
import { migrate, NodeSqliteStore } from '@lazy-flow/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { FakeLlmClient } from '../client/FakeLlmClient.js'
import { VerdictCache } from '../verdictCache.js'
import {
  applyDeterministicPrior,
  classifyByConventionalCommit,
  classifyByPathPatterns,
} from './prior.js'
import { runClassify } from './runClassify.js'
import type { ClassifyLlmOutput } from './types.js'
import { WorkType } from './types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function freshStore(): NodeSqliteStore {
  const db = new DatabaseSync(':memory:')
  migrate(db, 'up')
  const store = new NodeSqliteStore(':memory:')
  store.db.close()
  ;(store as unknown as { db: DatabaseSync }).db = db
  return store
}

// ─── classifyByConventionalCommit ─────────────────────────────────────────────

describe('classifyByConventionalCommit', () => {
  it('maps "feat: ..." to "feature"', () => {
    expect(classifyByConventionalCommit('feat: add login page')).toBe('feature')
  })

  it('maps "fix: ..." to "bugfix"', () => {
    expect(classifyByConventionalCommit('fix: correct null check')).toBe('bugfix')
  })

  it('maps "refactor: ..." to "refactor"', () => {
    expect(classifyByConventionalCommit('refactor: extract helper function')).toBe('refactor')
  })

  it('maps "test: ..." to "test"', () => {
    expect(classifyByConventionalCommit('test: add unit tests for login')).toBe('test')
  })

  it('maps "docs: ..." to "docs"', () => {
    expect(classifyByConventionalCommit('docs: update README')).toBe('docs')
  })

  it('maps "chore: ..." to "chore"', () => {
    expect(classifyByConventionalCommit('chore: bump dependencies')).toBe('chore')
  })

  it('maps "ci: ..." to "chore"', () => {
    expect(classifyByConventionalCommit('ci: add lint step')).toBe('chore')
  })

  it('handles scoped commits: "feat(auth): ..."', () => {
    expect(classifyByConventionalCommit('feat(auth): add token refresh')).toBe('feature')
  })

  it('returns null for non-conventional messages', () => {
    expect(classifyByConventionalCommit('WIP stuff')).toBeNull()
    expect(classifyByConventionalCommit('update login page')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(classifyByConventionalCommit('')).toBeNull()
  })
})

// ─── classifyByPathPatterns ───────────────────────────────────────────────────

describe('classifyByPathPatterns', () => {
  it('classifies test files as "test"', () => {
    expect(classifyByPathPatterns(['src/auth/login.test.ts', 'src/auth/logout.test.ts'])).toBe(
      'test',
    )
    expect(classifyByPathPatterns(['src/__tests__/user.ts'])).toBe('test')
  })

  it('classifies markdown files as "docs"', () => {
    expect(classifyByPathPatterns(['README.md', 'CONTRIBUTING.md'])).toBe('docs')
  })

  it('classifies CI/infra files as "chore"', () => {
    expect(classifyByPathPatterns(['.github/workflows/ci.yml'])).toBe('chore')
    expect(classifyByPathPatterns(['Dockerfile'])).toBe('chore')
  })

  it('returns null when no pattern matches', () => {
    expect(classifyByPathPatterns(['src/auth/login.ts', 'src/auth/session.ts'])).toBeNull()
  })

  it('returns null for empty file list', () => {
    expect(classifyByPathPatterns([])).toBeNull()
  })

  it('returns null when matched files are a minority (<50%)', () => {
    // 1 test file, 4 source files → 20% test → no confident prior
    const paths = [
      'src/auth/login.test.ts',
      'src/auth/login.ts',
      'src/auth/logout.ts',
      'src/auth/session.ts',
      'src/auth/token.ts',
    ]
    expect(classifyByPathPatterns(paths)).toBeNull()
  })
})

// ─── applyDeterministicPrior ──────────────────────────────────────────────────

describe('applyDeterministicPrior', () => {
  it('prefers conventional-commit over path pattern', () => {
    const result = applyDeterministicPrior(
      ['feat: add payment API'],
      'feat: add payment API',
      ['package.json'], // would be 'chore' by path
    )
    expect(result?.workType).toBe('feature')
    expect(result?.source).toBe('conventional_commit')
  })

  it('falls back to path pattern when no conventional commits', () => {
    const result = applyDeterministicPrior(
      ['add tests for auth module'],
      'add tests for auth module',
      ['src/auth/login.test.ts', 'src/auth/logout.test.ts'],
    )
    expect(result?.workType).toBe('test')
    expect(result?.source).toBe('path_pattern')
  })

  it('returns null when neither signal matches', () => {
    const result = applyDeterministicPrior(['update login page'], 'update login page', [
      'src/auth/login.ts',
    ])
    expect(result).toBeNull()
  })
})

// ─── WorkType enum ────────────────────────────────────────────────────────────

describe('WorkType enum', () => {
  it('contains the six valid work types', () => {
    expect(WorkType.options).toEqual(['feature', 'bugfix', 'refactor', 'test', 'docs', 'chore'])
  })

  it('parses valid work type strings', () => {
    expect(WorkType.parse('feature')).toBe('feature')
    expect(WorkType.parse('bugfix')).toBe('bugfix')
  })

  it('rejects invalid work type strings', () => {
    expect(() => WorkType.parse('invalid')).toThrow()
    expect(() => WorkType.parse('Feature')).toThrow() // case-sensitive
  })
})

// ─── runClassify integration ──────────────────────────────────────────────────

describe('runClassify', () => {
  let store: NodeSqliteStore
  let cache: VerdictCache

  beforeEach(() => {
    store = freshStore()
    cache = new VerdictCache()
  })

  it('deterministic prior is applied before the LLM (no LLM call for conventional commits)', async () => {
    // No LLM responses — would throw if called
    const client = new FakeLlmClient([])
    const result = await runClassify(
      {
        prTitle: 'feat: add search functionality',
        prBody: '',
        commitMessages: ['feat: add search index', 'feat: add search API'],
        filePaths: ['src/search/index.ts', 'src/search/api.ts'],
        diffSummary: 'Adds search indexing and API endpoints.',
        subjectId: 'pr-conv',
      },
      client,
      store,
      cache,
    )

    expect(result.workType).toBe('feature')
    expect(result.source).toBe('conventional_commit')
    expect(result.confidence).toBe(1.0)
  })

  it('passes a wrapped json_schema output format and a separate system prompt to the client', async () => {
    // Regression for raw-zod-schema-not-wrapped + no-system-role-prompt-injection.
    // Capture exactly what the pipeline hands the client.
    let captured: { system?: string; outputConfigFormat: unknown; userContent: string } | null =
      null
    const capturingClient = {
      // biome-ignore lint/suspicious/noExplicitAny: test capture client
      async parse(req: any) {
        captured = {
          system: req.system,
          outputConfigFormat: req.outputConfigFormat,
          userContent: req.messages[0]?.content ?? '',
        }
        return {
          value: { workType: 'refactor', reasoning: 'r', confidence: 0.9 },
          stopReason: 'end_turn',
          modelSnapshot: 'fake',
          requestShape: { temperature: 0 },
          usage: { inputTokens: 0, outputTokens: 0 },
        }
      },
    }
    await runClassify(
      {
        prTitle: 'Rework the widget rendering path',
        prBody: 'General cleanup of the rendering pipeline.',
        commitMessages: ['tidy up rendering', 'simplify widget tree'],
        filePaths: ['src/widgets/render.ts'],
        diffSummary: 'Refactors rendering.',
        subjectId: 'pr-cap',
      },
      // biome-ignore lint/suspicious/noExplicitAny: test capture client
      capturingClient as any,
      store,
      cache,
    )
    expect(captured).not.toBeNull()
    // Wrapped via zodOutputFormat → a json_schema format, not a bare zod schema.
    expect(
      (captured as unknown as { outputConfigFormat: { type?: string } }).outputConfigFormat.type,
    ).toBe('json_schema')
    // System instructions live in the system channel, not duplicated into the
    // untrusted user turn.
    const cap = captured as unknown as { system?: string; userContent: string }
    expect(cap.system && cap.system.length > 0).toBe(true)
    expect(cap.userContent.includes(cap.system ?? ' ')).toBe(false)
  })

  it('deterministic prior skips LLM for test-only paths', async () => {
    const client = new FakeLlmClient([])
    const result = await runClassify(
      {
        prTitle: 'Add test coverage for auth',
        prBody: '',
        commitMessages: ['add auth tests'],
        filePaths: ['src/__tests__/auth.test.ts', 'src/__tests__/session.test.ts'],
        diffSummary: '',
        subjectId: 'pr-testfiles',
      },
      client,
      store,
      cache,
    )

    expect(result.workType).toBe('test')
    expect(result.source).toBe('path_pattern')
  })

  it('falls through to LLM when no prior matches', async () => {
    const llmOutput: ClassifyLlmOutput = {
      workType: 'refactor',
      reasoning: 'Restructuring without behaviour change',
      confidence: 0.85,
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runClassify(
      {
        prTitle: 'Restructure auth module',
        prBody: 'Moving files around, no feature changes.',
        commitMessages: ['move auth helpers to utils', 'clean up imports'],
        filePaths: ['src/auth/login.ts', 'src/utils/auth.ts'],
        diffSummary: '- import foo from auth\n+ import foo from utils',
        subjectId: 'pr-llm',
      },
      client,
      store,
      cache,
    )

    expect(result.workType).toBe('refactor')
    expect(result.source).toBe('llm')
    expect(result.confidence).toBe(0.85)
  })

  it('output work type is always a valid WorkType enum value', async () => {
    const llmOutput: ClassifyLlmOutput = {
      workType: 'bugfix',
      reasoning: 'Fixing null pointer',
      confidence: 0.9,
    }

    const client = new FakeLlmClient([{ value: llmOutput }])
    const result = await runClassify(
      {
        prTitle: 'Fix crash on empty input',
        prBody: '',
        commitMessages: ['fix null check'],
        filePaths: ['src/parser.ts'],
        diffSummary: '+ if (input === null) return',
        subjectId: 'pr-fix',
      },
      client,
      store,
      cache,
    )

    // Must be a valid WorkType enum value
    expect(WorkType.safeParse(result.workType).success).toBe(true)
  })

  it('blame fallback is used when LLM refuses', async () => {
    const client = new FakeLlmClient([{ value: null, stopReason: 'refusal' }])
    const result = await runClassify(
      {
        prTitle: 'Misc changes',
        prBody: '',
        commitMessages: ['various tweaks'],
        filePaths: ['src/misc.ts'],
        diffSummary: '...',
        subjectId: 'pr-blame',
        blameFallback: 'refactor',
      },
      client,
      store,
      cache,
    )

    expect(result.workType).toBe('refactor')
    expect(result.source).toBe('blame_fallback')
  })
})
