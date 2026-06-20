import { describe, expect, it } from 'bun:test'

import { classifyPath, classifyWorkType, isProdCode, isTestFile, skillDomain } from './classify.js'

describe('classifyPath', () => {
  it('classifies test, docs, config, generated, and prod', () => {
    expect(classifyPath('src/foo.test.ts')).toBe('test')
    expect(classifyPath('src/__tests__/foo.ts')).toBe('test')
    expect(classifyPath('docs/guide.md')).toBe('docs')
    expect(classifyPath('config/app.yaml')).toBe('config')
    expect(classifyPath('dist/bundle.min.js')).toBe('generated')
    expect(classifyPath('bun.lockb')).toBe('generated')
    expect(classifyPath('src/core/store.ts')).toBe('prod')
  })

  it('isProdCode / isTestFile agree with classifyPath', () => {
    expect(isProdCode('src/x.ts')).toBe(true)
    expect(isProdCode('src/x.test.ts')).toBe(false)
    expect(isTestFile('src/x.test.ts')).toBe(true)
  })
})

describe('skillDomain', () => {
  it('maps paths to domains', () => {
    expect(skillDomain('src/auth/session.ts')).toBe('auth')
    expect(skillDomain('src/db/migrations/0001.sql')).toBe('database')
    expect(skillDomain('src/api/handler.ts')).toBe('api')
    expect(skillDomain('.github/workflows/ci.yml')).toBe('ci_build')
    expect(skillDomain('src/components/Button.tsx')).toBe('frontend')
    expect(skillDomain('src/misc/thing.ts')).toBe('other')
  })
})

describe('classifyWorkType', () => {
  it('prefers the Jira issue type', () => {
    expect(classifyWorkType('Bug', ['src/x.ts'])).toBe('bug')
    expect(classifyWorkType('Story', ['src/x.ts'])).toBe('feature')
    expect(classifyWorkType('Chore', [])).toBe('debt')
  })

  it('falls back to path class when no issue type', () => {
    expect(classifyWorkType(null, ['src/x.test.ts', 'src/y.test.ts'])).toBe('test')
    expect(classifyWorkType(null, ['docs/a.md'])).toBe('docs')
    expect(classifyWorkType(null, ['src/x.ts'])).toBe('feature')
  })

  it('a typed-but-unmatched issue with code changes is other', () => {
    expect(classifyWorkType('Task', ['src/x.ts'])).toBe('other')
  })
})
