/**
 * WP-SCRUB golden tests (SPEC §6.5 acceptance criteria).
 *
 * Golden rule: a body containing a fake AWS key + a ghp_ token + an email
 * must have all three redacted. Ordinary prose must be untouched.
 */

import { describe, expect, it } from 'bun:test'
import { scrubFreeText, scrubRawPayload } from './index.js'

// Fake, well-formed-LOOKING secrets used purely to prove the scrubber redacts
// each token shape. They are assembled from fragments at runtime so that the
// contiguous secret pattern never appears as a literal in this file — otherwise
// GitHub push protection / secret scanners flag these test fixtures as real
// leaked credentials (they are NOT real). The runtime value is identical to a
// real-shaped token, so the scrub regexes still match.
const FAKE_AWS_KEY = `AKIA${'IOSFODNN7EXAMPLE'}`
const FAKE_GHP_TOKEN = `ghp_${'ABCDEFghijklmnopqrstuvwxyz123456'}`
const FAKE_GHO_TOKEN = `gho_${'XYZ123abcdefghij7890ABCDEF'}`
const FAKE_SLACK_TOKEN = `xoxb-${'12345678901-12345678901-aBcDeFgHiJkLmNoPqRsT'}`
// JWT = three base64url segments; joined at runtime so the dotted triple never
// appears contiguously in source.
const FAKE_JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
].join('.')

// ---------------------------------------------------------------------------
// scrubFreeText
// ---------------------------------------------------------------------------

describe('scrubFreeText', () => {
  it('leaves ordinary prose untouched', () => {
    const prose = 'Fixed a bug in the login flow. See PR #42 for details.'
    expect(scrubFreeText(prose)).toBe(prose)
  })

  it('redacts a fake AWS access-key ID', () => {
    const text = `My key is ${FAKE_AWS_KEY} and should be hidden.`
    const out = scrubFreeText(text)
    expect(out).toContain('[REDACTED_SECRET]')
    expect(out).not.toContain(FAKE_AWS_KEY)
  })

  it('redacts a ghp_ GitHub token', () => {
    const text = `token: ${FAKE_GHP_TOKEN}`
    const out = scrubFreeText(text)
    expect(out).toContain('[REDACTED_SECRET]')
    expect(out).not.toContain('ghp_')
  })

  it('redacts a gho_ GitHub token', () => {
    const text = `oauth: ${FAKE_GHO_TOKEN}`
    const out = scrubFreeText(text)
    expect(out).toContain('[REDACTED_SECRET]')
    expect(out).not.toContain('gho_')
  })

  it('redacts a Slack xoxb token', () => {
    const text = `Slack: ${FAKE_SLACK_TOKEN}`
    const out = scrubFreeText(text)
    expect(out).toContain('[REDACTED_SECRET]')
    expect(out).not.toContain('xoxb-')
  })

  it('redacts a JWT', () => {
    const text = `Authorization: Bearer ${FAKE_JWT}`
    const out = scrubFreeText(text)
    expect(out).toContain('[REDACTED_SECRET]')
    expect(out).not.toContain('eyJ')
  })

  it('redacts an email address', () => {
    const text = 'Contact alice@example.com for help.'
    const out = scrubFreeText(text)
    expect(out).toContain('[REDACTED_EMAIL]')
    expect(out).not.toContain('alice@example.com')
  })

  it('redacts high-entropy 32+ char strings', () => {
    // Simulate a generic API secret / bearer token.
    const secret = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'
    const text = `secret=${secret}`
    const out = scrubFreeText(text)
    expect(out).toContain('[REDACTED_SECRET]')
    expect(out).not.toContain(secret)
  })

  it('does NOT redact long low-entropy strings (repeated chars)', () => {
    // 32 characters but extremely low entropy — not a token.
    const lowEntropy = 'aaaaaaaaaabbbbbbbbbbcccccccccccc'
    expect(scrubFreeText(lowEntropy)).toBe(lowEntropy)
  })

  it('golden: body with AWS key + ghp_ token + email has all three redacted', () => {
    const body = [
      `Here is my AWS key: ${FAKE_AWS_KEY}`,
      `GitHub token: ${FAKE_GHP_TOKEN}`,
      'Reach me at dev@example.org if needed.',
    ].join('\n')

    const out = scrubFreeText(body)

    // All three secret types removed.
    expect(out).not.toContain(FAKE_AWS_KEY)
    expect(out).not.toContain('ghp_')
    expect(out).not.toContain('dev@example.org')

    // Correct replacement tokens present.
    const secretCount = (out.match(/\[REDACTED_SECRET\]/g) ?? []).length
    const emailCount = (out.match(/\[REDACTED_EMAIL\]/g) ?? []).length
    expect(secretCount).toBeGreaterThanOrEqual(2)
    expect(emailCount).toBe(1)
  })

  it('is idempotent — scrubbing twice produces the same output', () => {
    const text = `token: ${FAKE_GHP_TOKEN} email: bob@test.com`
    const once = scrubFreeText(text)
    const twice = scrubFreeText(once)
    expect(twice).toBe(once)
  })

  it('preserves surrounding prose after redaction', () => {
    const text = `Found bug, token ${FAKE_GHP_TOKEN} in config, fix asap.`
    const out = scrubFreeText(text)
    expect(out).toContain('Found bug, token')
    expect(out).toContain('in config, fix asap.')
  })

  it('is ReDoS-resistant — adversarial email-like input completes near-instantly', () => {
    // `a@` + `a.`×n + space triggered quadratic backtracking in the old email
    // regex (~7s at 100KB). Bounded, non-overlapping quantifiers make it linear.
    const payload = `a@${'a.'.repeat(100_000)} `
    const start = performance.now()
    scrubFreeText(payload)
    expect(performance.now() - start).toBeLessThan(250)
  })
})

// ---------------------------------------------------------------------------
// scrubRawPayload
// ---------------------------------------------------------------------------

describe('scrubRawPayload', () => {
  it('retains only allowlisted fields', () => {
    const obj = { id: 1, body: 'hello', secret: 'should-be-dropped', state: 'open' }
    const out = scrubRawPayload(obj, ['id', 'body', 'state'])
    expect(out).toEqual({ id: 1, body: 'hello', state: 'open' })
    expect('secret' in out).toBe(false)
  })

  it('scrubs free-text in string fields', () => {
    const obj = {
      id: 42,
      body: `token: ${FAKE_GHP_TOKEN} and user@corp.com`,
    }
    const out = scrubRawPayload(obj, ['id', 'body'])
    expect(out.body).toContain('[REDACTED_SECRET]')
    expect(out.body).toContain('[REDACTED_EMAIL]')
    expect(out.body).not.toContain('ghp_')
    expect(out.body).not.toContain('user@corp.com')
  })

  it('preserves non-string values as-is', () => {
    const obj = { id: 99, count: 7, flag: true, nested: { x: 1 } }
    const out = scrubRawPayload(obj, ['id', 'count', 'flag', 'nested'])
    expect(out.id).toBe(99)
    expect(out.count).toBe(7)
    expect(out.flag).toBe(true)
    expect(out.nested).toEqual({ x: 1 })
  })

  it('returns empty object for non-object input', () => {
    expect(scrubRawPayload(null, ['body'])).toEqual({})
    expect(scrubRawPayload(undefined, ['body'])).toEqual({})
    expect(scrubRawPayload('string', ['body'])).toEqual({})
    expect(scrubRawPayload(42, ['body'])).toEqual({})
    expect(scrubRawPayload([], ['body'])).toEqual({})
  })

  it('silently skips allowlisted fields not present in the object', () => {
    const obj = { id: 1 }
    const out = scrubRawPayload(obj, ['id', 'body'])
    expect(out).toEqual({ id: 1 })
  })
})
