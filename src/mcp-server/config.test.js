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

import { describe, expect, it } from 'bun:test'
import {
  githubTokenFromEnv,
  githubTokenFromGhCli,
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
