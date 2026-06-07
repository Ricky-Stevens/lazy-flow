/**
 * SSRF-guard regression tests (SPEC §6.5). The guard must block token-bearing
 * requests to loopback / private / metadata hosts across IPv4, IPv6, and the
 * IPv4-mapped/compat IPv6 forms that previously slipped through a hand-rolled
 * prefix check (e.g. `[::ffff:169.254.169.254]`).
 */

import { describe, expect, it } from 'vitest'
import { assertSafeBaseUrl, isPrivateHost } from './safeUrl.js'

describe('isPrivateHost', () => {
  it('blocks IPv4 loopback / private / CGNAT / metadata ranges', () => {
    for (const h of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
    ]) {
      expect(isPrivateHost(h)).toBe(true)
    }
  })

  it('blocks IPv6 loopback / unique-local / link-local / site-local', () => {
    for (const h of ['::1', '[::1]', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1']) {
      expect(isPrivateHost(h)).toBe(true)
    }
  })

  it('blocks IPv4-mapped and IPv4-compatible IPv6 (the regressed bypass)', () => {
    for (const h of [
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:10.0.0.5',
      '[::ffff:169.254.169.254]',
      '::ffff:7f00:1', // hex form of 127.0.0.1
      '::ffff:a9fe:a9fe', // hex form of 169.254.169.254
    ]) {
      expect(isPrivateHost(h)).toBe(true)
    }
  })

  it('allows ordinary public hosts', () => {
    for (const h of ['api.github.com', 'acme.atlassian.net', '8.8.8.8', '2606:4700::1111']) {
      expect(isPrivateHost(h)).toBe(false)
    }
  })
})

describe('assertSafeBaseUrl', () => {
  it('rejects an IPv4-mapped-IPv6 metadata base URL by default', () => {
    expect(() => assertSafeBaseUrl('https://[::ffff:169.254.169.254]/')).toThrow(
      /private|loopback|metadata/i,
    )
  })

  it('rejects non-https (cleartext token) by default', () => {
    expect(() => assertSafeBaseUrl('http://api.github.com')).toThrow(/non-https/i)
  })

  it('accepts a public https base URL', () => {
    expect(assertSafeBaseUrl('https://api.github.com').origin).toBe('https://api.github.com')
  })

  it('honours allowPrivate for self-hosted / test setups', () => {
    expect(() => assertSafeBaseUrl('https://10.0.0.5', { allowPrivate: true })).not.toThrow()
  })
})
