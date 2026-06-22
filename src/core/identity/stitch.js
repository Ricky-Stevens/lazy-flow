/**
 * Person stitching — match ladder (SPEC §6.3 WP-IDENTITY v2).
 *
 * Creates / clusters `persons` from `identities` using a strict match ladder:
 *
 *   Tier 1 — Auto-merge (confidence 1.0):
 *     a) Verified full-email match: a commit_email identity shares the same
 *        email address as the primary_account_ref of an existing person
 *        (or a GitHub-verified email attached to a github_login identity via
 *        the raw "email" field from the GitHub Users API).
 *     b) GitHub-verified email↔login link: the raw payload of a github_login
 *        identity carries a non-noreply "email" field matching a commit_email
 *        identity's externalId (confidence 1.0, GitHub says they verified it).
 *
 *   Tier 2 — Human-confirm queue (NEVER auto-merged):
 *     c) Local-part + name similarity (0.8): same local-part of email AND
 *        similar display name → queued (e.g. john.smith@acme vs john.smith@vendor).
 *     d) Fuzzy name match (0.5): similar display names, no email overlap → queued.
 *
 *   Bots: identities with is_bot=true never get a person record and are
 *         excluded from all aggregates by default.
 *
 * Persons are anchored on a stable account reference (GitHub user id, Jira
 * accountId) so an email change does not fragment a person.
 *
 * All merges are reversible (person_id is nullable, never hard-delete).
 */

import { safeJsonParse } from '../json.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId() {
  return crypto.randomUUID()
}

/**
 * Deterministic person id derived from the cluster's STABLE account anchor
 * (`primaryAccountRef`, e.g. `gh:<numericId>` / `jira:<accountId>`). Re-deriving
 * the same cluster always yields the SAME person id, so resolution is idempotent
 * BY CONSTRUCTION and the id is stable across any future detach/re-stitch —
 * rather than a fresh random UUID that would orphan the prior person and dangle
 * anything pinned to its id (e.g. person-scoped snapshots) on re-creation.
 */
function personIdForAnchor(accountRef) {
  return `person:${accountRef}`
}

/**
 * Extract the email field from a github_login identity's raw payload.
 * GitHub's Users API can return a verified email; noreply addresses are excluded.
 */
function extractVerifiedEmail(raw) {
  const parsed = safeJsonParse(raw, {})
  const email = parsed.email
  if (typeof email !== 'string' || !email.includes('@')) return null
  // Exclude GitHub noreply addresses
  if (email.endsWith('@users.noreply.github.com')) return null
  return email.toLowerCase()
}

/**
 * Extract the local part (before @) from an email address.
 * Returns null for obviously invalid emails.
 */
function localPart(email) {
  const idx = email.indexOf('@')
  if (idx <= 0) return null
  return email.slice(0, idx).toLowerCase()
}

/**
 * Generic no-reply / automated-sender local parts. Two unrelated services both
 * sending from `noreply@…` must NOT be stitched into one person on the strength
 * of a shared `noreply` local part — that is a machine address, not an identity.
 */
const NO_REPLY_LOCAL_PARTS = new Set([
  'noreply',
  'no-reply',
  'no.reply',
  'donotreply',
  'do-not-reply',
])
function isNoReplyLocalPart(lp) {
  if (!lp) return true
  const l = lp.toLowerCase()
  return NO_REPLY_LOCAL_PARTS.has(l) || l.startsWith('noreply') || l.startsWith('no-reply')
}

/**
 * Normalise a display name for fuzzy comparison:
 * lowercase, strip punctuation, collapse whitespace.
 */
function normaliseName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Simple name similarity check for the Tier 2d human-review queue.
 *
 * Multi-word names need >= 2 shared tokens, so "John Smith" vs "John Doe"
 * (one shared token) do NOT match. But a mononym (single-token name on either
 * side) can never reach 2 shared tokens, so requiring 2 made identical
 * single-word names (e.g. "Madonna" vs "Madonna") never match at all. For those
 * we require >= 1 shared token instead — these only land in the review queue,
 * never an auto-merge, so a human still confirms.
 */
function namesAreSimilar(a, b) {
  const tokensA = new Set(normaliseName(a).split(' ').filter(Boolean))
  const tokensB = new Set(normaliseName(b).split(' ').filter(Boolean))
  let shared = 0
  for (const t of tokensA) {
    if (tokensB.has(t)) shared++
  }
  return shared >= 2 || (shared >= 1 && (tokensA.size === 1 || tokensB.size === 1))
}

/**
 * Extract a stable account reference from an identity.
 * For github_login: "gh:<numeric id from raw>" or "gh:<login>" fallback.
 * For jira_account: "jira:<accountId>".
 * For commit_email: not a stable account ref (email can change).
 */
function primaryAccountRef(identity) {
  if (identity.kind === 'github_login') {
    const parsed = safeJsonParse(identity.raw, {})
    const numericId = parsed.id
    if (typeof numericId === 'number') return `gh:${numericId}`
    return `gh:${identity.externalId}`
  }
  if (identity.kind === 'jira_account') {
    return `jira:${identity.externalId}`
  }
  // commit_email: no stable account ref
  return null
}

// ---------------------------------------------------------------------------
// Main stitchPersons pass
// ---------------------------------------------------------------------------

/**
 * Create/cluster persons from identities.
 *
 * Pass 1: For every non-bot identity that lacks a person_id AND has a stable
 *         account ref (github_login, jira_account), create a person record.
 *
 * Pass 2: For commit_email identities lacking a person_id:
 *   - Auto-merge if a GitHub-verified email↔login link is found (tier 1b).
 *   - Auto-merge if the email exactly matches the email of an existing person
 *     with a github_login or jira_account anchor (tier 1a).
 *   - Otherwise queue as local-part+name (tier 2c) or fuzzy-name (tier 2d).
 *
 * Pass 3: Cross-kind auto-merge check — if a github_login identity has a
 *         verified email matching a commit_email identity already linked to
 *         a person, merge the github_login identity into that person.
 */
export async function stitchPersons(store, options = {}) {
  const now = options.now ?? new Date().toISOString()
  let personsCreated = 0
  let autoMerged = 0
  let queued = 0

  // Load identities once. The whole pass runs in one transaction (it does
  // thousands of small writes; one WAL fsync per row otherwise dominates).
  const identities = await store.listAllIdentities()
  const nonBots = identities.filter((id) => !id.isBot)

  await store.transaction(async () => {
    // ------------------------------------------------------------------------
    // Pass 1: create persons for non-bot account-anchored identities.
    // We track the post-Pass-1 person id per identity in `personIdOf` instead
    // of reloading the whole identities table (the original reloaded it 3×).
    // ------------------------------------------------------------------------
    const personIdOf = new Map()
    for (const identity of nonBots) personIdOf.set(identity.id, identity.personId)

    for (const identity of nonBots) {
      if (identity.personId !== null) continue
      const accountRef = primaryAccountRef(identity)
      if (!accountRef) continue // commit_email — handled in Pass 2

      const person = {
        id: personIdForAnchor(accountRef),
        displayName: identity.externalId, // will be refined by later data
        primaryAccountRef: accountRef,
        updatedAt: now,
      }
      await store.upsertPerson(person)
      personsCreated++

      // person_id is written ONLY via setIdentityPerson (single-writer invariant);
      // upsertIdentity no longer touches person_id on conflict.
      await store.setIdentityPerson(identity.id, person.id, now)
      personIdOf.set(identity.id, person.id)
      // NOT an auto-merge: this is the initial creation+linking of a person for
      // an account-anchored identity. autoMerged counts only Pass 2/3 merges of a
      // commit_email/github_login into an *existing* person via verified email.
    }

    // ------------------------------------------------------------------------
    // Build lookup indices ONCE from the post-Pass-1 state, replacing the
    // original per-commit-email O(n²) scans (each of which re-JSON.parsed every
    // other identity's raw) with O(1)/O(k) map lookups.
    // ------------------------------------------------------------------------
    // verified github email → person id; jira email → person id (Tier 1a/1b)
    const verifiedEmailToPersonId = new Map()
    const jiraEmailToPersonId = new Map()
    // local-part → commit_email identities (Tier 2c)
    const commitEmailsByLocalPart = new Map()
    // precomputed display name per identity (avoids re-parsing raw in loops)
    const nameOf = new Map()
    // order index for deterministic "first match" selection in Tier 2d
    const orderOf = new Map()
    // inverted index: name token → person-linked identities (Tier 2d candidates)
    const tokenIndex = new Map()

    nonBots.forEach((id, i) => {
      orderOf.set(id.id, i)
    })
    for (const id of nonBots) {
      const pid = personIdOf.get(id.id) ?? null
      const name = nameFromIdentity(id)
      nameOf.set(id.id, name)

      if (id.kind === 'github_login' && pid !== null) {
        const ve = extractVerifiedEmail(id.raw)
        if (ve) verifiedEmailToPersonId.set(ve, pid)
      }
      if (id.kind === 'jira_account' && pid !== null) {
        const jiraEmail = safeJsonParse(id.raw, {}).emailAddress?.toLowerCase()
        if (jiraEmail) jiraEmailToPersonId.set(jiraEmail, pid)
      }
      if (id.kind === 'commit_email') {
        const lp = localPart(id.externalId.toLowerCase())
        // Never index no-reply addresses — two unrelated noreply@ senders must
        // not become local-part stitch candidates (see isNoReplyLocalPart).
        if (lp && !isNoReplyLocalPart(lp)) {
          const list = commitEmailsByLocalPart.get(lp)
          if (list) list.push(id)
          else commitEmailsByLocalPart.set(lp, [id])
        }
      }
      // Index person-linked identities by their name tokens for fuzzy matching.
      if (pid !== null && name) {
        for (const tok of new Set(normaliseName(name).split(' ').filter(Boolean))) {
          const list = tokenIndex.get(tok)
          if (list) list.push(id)
          else tokenIndex.set(tok, [id])
        }
      }
    }

    // ------------------------------------------------------------------------
    // Pass 2: link commit_email identities. All `other`/person reads use the
    // fixed post-Pass-1 state (`personIdOf`), matching the original snapshot
    // semantics — Pass-2 merges are not visible to later iterations.
    // ------------------------------------------------------------------------
    for (const identity of nonBots) {
      if (identity.kind !== 'commit_email') continue
      if (personIdOf.get(identity.id) !== null) continue

      const email = identity.externalId.toLowerCase()

      // Tier 1b: GitHub-verified email↔login.
      const verifiedPersonId = verifiedEmailToPersonId.get(email)
      if (verifiedPersonId) {
        await store.setIdentityPerson(identity.id, verifiedPersonId, now)
        autoMerged++
        continue
      }

      // Tier 1a: Jira account whose emailAddress matches this commit email.
      const jiraPersonId = jiraEmailToPersonId.get(email)
      if (jiraPersonId) {
        await store.setIdentityPerson(identity.id, jiraPersonId, now)
        autoMerged++
        continue
      }

      // Tier 2c: same local-part, different domain → human-confirm queue.
      // Skip no-reply addresses — they are machine senders, not people.
      const lp = localPart(email)
      let queued2c = false
      if (lp && !isNoReplyLocalPart(lp)) {
        for (const other of commitEmailsByLocalPart.get(lp) ?? []) {
          if (other.id === identity.id) continue
          if (other.externalId.toLowerCase() === email) continue
          await appendQueueEntry(store, identity, other, 'local_part_name', 0.8, now)
          queued++
          queued2c = true
          break
        }
      }
      if (queued2c) continue

      // Tier 2d: fuzzy name against person-linked identities. Gather candidates
      // sharing ≥1 name token via the inverted index, then pick the earliest
      // (by original order) that is genuinely similar (≥2 shared tokens).
      const myName = nameOf.get(identity.id)
      if (!myName) continue
      const myTokens = new Set(normaliseName(myName).split(' ').filter(Boolean))
      let best = null
      let bestOrder = Number.POSITIVE_INFINITY
      const seen = new Set()
      for (const tok of myTokens) {
        for (const other of tokenIndex.get(tok) ?? []) {
          if (other.id === identity.id || seen.has(other.id)) continue
          seen.add(other.id)
          const theirName = nameOf.get(other.id)
          if (!theirName || !namesAreSimilar(myName, theirName)) continue
          const ord = orderOf.get(other.id) ?? Number.POSITIVE_INFINITY
          if (ord < bestOrder) {
            bestOrder = ord
            best = other
          }
        }
      }
      if (best) {
        await appendQueueEntry(store, identity, best, 'fuzzy_name', 0.5, now)
        queued++
      }
    }
  })

  return { personsCreated, autoMerged, queued }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nameFromIdentity(identity) {
  const parsed = safeJsonParse(identity.raw, {})
  const name = parsed.name ?? parsed.displayName ?? parsed.login
  return name ?? null
}

async function appendQueueEntry(store, a, b, reason, confidence, now) {
  const match = {
    id: newId(),
    identityIdA: a.id,
    identityIdB: b.id,
    reason,
    confidence,
    status: 'pending',
    decidedAt: null,
    decidedBy: null,
    createdAt: now,
    updatedAt: now,
  }
  await store.appendCandidateMatch(match)
}
