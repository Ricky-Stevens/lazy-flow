/**
 * Config token-resolution tests.
 *
 * Covers the GitHub credential precedence chain and the two failure modes that
 * previously bit us:
 *   - the plugin injects LAZYFLOW_GITHUB_TOKEN="" for an unfilled field, which
 *     must NOT become a bogus empty bearer token;
 *   - with no token configured, the tool must fall back to the locally
 *     authenticated `gh` CLI rather than disabling GitHub sync.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  cascadeWarnings,
  githubTokenFromEnv,
  githubTokenFromGhCli,
  loadConfig,
  parseBool,
  parseDaysWithDefault,
} from './config.js'

describe('githubTokenFromEnv', () => {
  it('prefers LAZYFLOW_GITHUB_TOKEN over the conventional env vars', () => {
    const token = githubTokenFromEnv({
      LAZYFLOW_GITHUB_TOKEN: 'lazyflow-tok',
      GH_TOKEN: 'gh-tok',
      GITHUB_TOKEN: 'github-tok',
    })
    expect(token).toBe('lazyflow-tok')
  })

  it('falls back to GH_TOKEN then GITHUB_TOKEN', () => {
    expect(githubTokenFromEnv({ GH_TOKEN: 'gh-tok', GITHUB_TOKEN: 'github-tok' })).toBe('gh-tok')
    expect(githubTokenFromEnv({ GITHUB_TOKEN: 'github-tok' })).toBe('github-tok')
  })

  it('treats an empty / whitespace value as UNSET (the plugin injects "")', () => {
    expect(githubTokenFromEnv({ LAZYFLOW_GITHUB_TOKEN: '' })).toBeNull()
    expect(githubTokenFromEnv({ LAZYFLOW_GITHUB_TOKEN: '   ' })).toBeNull()
    // empty primary must not shadow a real conventional var
    expect(githubTokenFromEnv({ LAZYFLOW_GITHUB_TOKEN: '', GH_TOKEN: 'gh-tok' })).toBe('gh-tok')
  })

  it('trims surrounding whitespace from the resolved value', () => {
    expect(githubTokenFromEnv({ LAZYFLOW_GITHUB_TOKEN: '  tok\n' })).toBe('tok')
  })

  it('returns null when nothing is set', () => {
    expect(githubTokenFromEnv({})).toBeNull()
  })
})

describe('githubTokenFromGhCli', () => {
  it('returns the trimmed token the gh reader prints', () => {
    expect(githubTokenFromGhCli(() => 'gho_abc123\n')).toBe('gho_abc123')
  })

  it('returns null when the gh reader throws (gh absent / not logged in)', () => {
    expect(
      githubTokenFromGhCli(() => {
        throw new Error('gh: command not found')
      }),
    ).toBeNull()
  })

  it('returns null when gh prints nothing', () => {
    expect(githubTokenFromGhCli(() => '')).toBeNull()
    expect(githubTokenFromGhCli(() => '   \n')).toBeNull()
  })
})

describe('parseBool', () => {
  it('uses the fallback for unset/empty (the plugin injects "")', () => {
    expect(parseBool(undefined, true)).toBe(true)
    expect(parseBool('', true)).toBe(true)
    expect(parseBool('   ', false)).toBe(false)
  })

  it('treats explicit falsy tokens as false (case/whitespace-insensitive)', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', ' Off ']) {
      expect(parseBool(v, true)).toBe(false)
    }
  })

  it('treats any other value as true', () => {
    expect(parseBool('true', false)).toBe(true)
    expect(parseBool('1', false)).toBe(true)
    expect(parseBool('yes', false)).toBe(true)
  })
})

describe('parseDaysWithDefault', () => {
  it('uses the fallback for unset/empty (the plugin injects "")', () => {
    expect(parseDaysWithDefault(undefined, 180)).toBe(180)
    expect(parseDaysWithDefault('', 180)).toBe(180)
    expect(parseDaysWithDefault('   ', 180)).toBe(180)
  })

  it('honours an EXPLICIT 0 as all-time/disabled (distinct from unset)', () => {
    expect(parseDaysWithDefault('0', 180)).toBe(0)
  })

  it('parses an explicit positive day count', () => {
    expect(parseDaysWithDefault('365', 180)).toBe(365)
    expect(parseDaysWithDefault(' 90 ', 180)).toBe(90)
  })
})

describe('loadConfig — retention / window cascade', () => {
  // loadConfig reads process.env directly; clear the knobs we assert so the test
  // sees DEFAULTS regardless of the host environment, and force an in-memory DB so
  // resolveDbPath creates no directory. Saved/restored around each case.
  const KEYS = [
    'LAZYFLOW_DB_PATH',
    'LAZYFLOW_REPO_HISTORY_DAYS',
    'LAZYFLOW_RETENTION_DAYS',
    'LAZYFLOW_SNAPSHOT_HORIZON_DAYS',
    'LAZYFLOW_SNAPSHOT_WINDOW_DAYS',
    'LAZYFLOW_LLM_WINDOW_DAYS',
    'LAZYFLOW_PATCH_RETENTION_DAYS',
  ]
  let saved
  beforeEach(() => {
    saved = {}
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.LAZYFLOW_DB_PATH = ':memory:'
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('defaults to the 90 / 60 / 30 cascade', () => {
    const c = loadConfig()
    expect(c.repoHistoryDays).toBe(90)
    expect(c.retentionDays).toBe(90)
    expect(c.snapshotHorizonDays).toBe(60)
    expect(c.snapshotWindowDays).toBe(30)
    expect(c.llmWindowDays).toBe(30)
    expect(c.patchRetentionDays).toBe(30)
    expect(c.retentionBufferDays).toBe(7)
  })

  it('honours explicit env overrides', () => {
    process.env.LAZYFLOW_REPO_HISTORY_DAYS = '120'
    process.env.LAZYFLOW_RETENTION_DAYS = '120'
    process.env.LAZYFLOW_SNAPSHOT_HORIZON_DAYS = '90'
    process.env.LAZYFLOW_LLM_WINDOW_DAYS = '14'
    process.env.LAZYFLOW_PATCH_RETENTION_DAYS = '7'
    const c = loadConfig()
    expect(c.repoHistoryDays).toBe(120)
    expect(c.retentionDays).toBe(120)
    expect(c.snapshotHorizonDays).toBe(90)
    expect(c.llmWindowDays).toBe(14)
    expect(c.patchRetentionDays).toBe(7)
  })

  it('treats an explicit 0 as "disabled" (keep-all) for retention and patch', () => {
    process.env.LAZYFLOW_RETENTION_DAYS = '0'
    process.env.LAZYFLOW_PATCH_RETENTION_DAYS = '0'
    const c = loadConfig()
    expect(c.retentionDays).toBe(0)
    expect(c.patchRetentionDays).toBe(0)
  })
})

describe('cascadeWarnings', () => {
  const base = {
    repoHistoryDays: 90,
    retentionDays: 90,
    snapshotHorizonDays: 60,
    snapshotWindowDays: 30,
    retentionBufferDays: 7,
  }

  it('returns no warnings for the default 90 / 60 / 30 cascade', () => {
    expect(cascadeWarnings(base)).toEqual([])
  })

  it('warns when retention is below the snapshot horizon + window', () => {
    const w = cascadeWarnings({ ...base, retentionDays: 45 })
    expect(w.length).toBeGreaterThan(0)
    expect(w[0]).toMatch(/retention_days/)
  })

  it('warns when the fetch floor is below retention', () => {
    const w = cascadeWarnings({ ...base, repoHistoryDays: 60 })
    expect(w.some((m) => /repo_history_days/.test(m))).toBe(true)
  })

  it('does not warn when retention/history are 0 (keep-all / all-time)', () => {
    expect(cascadeWarnings({ ...base, retentionDays: 0, repoHistoryDays: 0 })).toEqual([])
  })
})
