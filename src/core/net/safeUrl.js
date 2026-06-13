/**
 * Outbound-URL safety guards for the ingestion HTTP clients (SPEC §6.5).
 *
 * The GitHub/Jira clients attach a bearer token to every request, so an
 * attacker who can influence a request URL (a malicious base URL, or a
 * server-controlled `Link: rel="next"` header) could exfiltrate that token to
 * an arbitrary host, or drive an authenticated SSRF at internal/metadata
 * endpoints. These helpers enforce:
 *   - https only (no cleartext token transmission)
 *   - no loopback / link-local / private / metadata hosts (SSRF)
 *   - paginator next-URLs must stay on the configured origin
 *
 * Both guards can be relaxed for tests/self-hosted setups via opt-in flags.
 */

/** True for an IPv4 dotted-quad's octets that fall in a private/reserved range. */
function isPrivateIpv4(o) {
  const [a, b] = o
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true // malformed → unsafe
  if (a === 0 || a === 127) return true // this-host / loopback
  if (a === 10) return true // 10.0.0.0/8
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  return false
}

/**
 * Parse an IPv6 literal (already bracket-stripped, lowercased) to a 128-bit
 * BigInt. Handles `::` zero-compression and a trailing embedded IPv4
 * (e.g. `::ffff:127.0.0.1`). Returns null if the string is not a valid IPv6
 * address. We parse numerically rather than regex-match prefixes so that
 * IPv4-mapped/compat forms cannot smuggle a private address past the guard.
 */
function ipv6ToBigInt(host) {
  if (!host.includes(':')) return null
  let str = host
  // Convert a trailing embedded IPv4 (::ffff:a.b.c.d) into two hextets.
  const v4 = str.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const o = v4.slice(1, 5).map(Number)
    if (o.some((n) => n > 255)) return null
    const [a, b, c, d] = o
    const hi = ((a << 8) | b).toString(16)
    const lo = ((c << 8) | d).toString(16)
    str = `${str.slice(0, v4.index)}${hi}:${lo}`
  }

  const halves = str.split('::')
  if (halves.length > 2) return null // more than one '::' is invalid
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null

  let groups
  if (tail === null) {
    groups = head
  } else {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill('0'), ...tail]
  }
  if (groups.length !== 8) return null

  let value = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    value = (value << 16n) | BigInt(Number.parseInt(g, 16))
  }
  return value
}

/** True for hostnames that must never receive a bearer token (SSRF surface). */
export function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets

  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true

  // IPv4 dotted-quad.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) return isPrivateIpv4(m.slice(1, 5).map(Number))

  // IPv6 — parse to a 128-bit value so mapped/compat forms can't slip through.
  const v = ipv6ToBigInt(host)
  if (v !== null) {
    if (v === 0n) return true // :: unspecified
    if (v === 1n) return true // ::1 loopback
    // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96, deprecated):
    // run the embedded low-32-bit IPv4 through the v4 ranges.
    const high96 = v >> 32n
    if (high96 === 0xffffn || high96 === 0n) {
      const low = Number(v & 0xffffffffn)
      const o = [(low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff]
      if (isPrivateIpv4(o)) return true
    }
    const first16 = Number((v >> 112n) & 0xffffn)
    if ((first16 & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
    if ((first16 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((first16 & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
    return false
  }
  return false
}

/**
 * Validate and normalise a base URL for an outbound, token-bearing client.
 * Throws on a non-https scheme or a private/loopback/metadata host (unless the
 * matching opt-in flag is set). Returns the parsed URL.
 */
export function assertSafeBaseUrl(raw, opts = {}) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid base URL: ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'https:' && !opts.allowInsecure) {
    throw new Error(
      `Refusing non-https base URL (${url.protocol}//) — a bearer token would be sent in cleartext: ${raw}`,
    )
  }
  if (isPrivateHost(url.hostname) && !opts.allowPrivate) {
    throw new Error(
      `Refusing private/loopback/metadata base URL host '${url.hostname}' — would enable an authenticated SSRF: ${raw}`,
    )
  }
  return url
}

/**
 * Assert a follow-up URL (e.g. a Link: rel="next" paginator URL) stays on the
 * same origin as the configured base. Prevents a server-controlled next-URL
 * from redirecting a token-bearing request to an attacker host.
 */
export function assertSameOrigin(candidate, baseOrigin) {
  let url
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`Invalid pagination URL: ${JSON.stringify(candidate)}`)
  }
  if (url.origin !== baseOrigin) {
    throw new Error(
      `Refusing to follow cross-origin pagination URL '${url.origin}' (expected '${baseOrigin}') — would leak the auth token`,
    )
  }
}
