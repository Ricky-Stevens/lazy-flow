/**
 * Cross-source person stitching (GitHub ↔ Jira) — WP-IDENTITY v2 extension.
 *
 * The base `stitchPersons` ladder only bridges sources through a SHARED EMAIL
 * (commit_email ↔ Jira emailAddress / GitHub-verified email). On Jira Cloud the
 * account email is almost always redacted, so real people end up as TWO persons:
 * a GitHub-anchored one (github_login + commit_email) and a Jira-anchored one
 * (jira_account). This pass fuses them using three independent signals:
 *
 *   1. EMAIL (deterministic, conf 1.0) — a GitHub person's email == a Jira
 *      person's emailAddress. Handles instances that DO expose Jira email.
 *   2. NAME (deterministic-ish) — token-set match between the GitHub side's name
 *      bag (login + email local-part + verified profile/commit name) and the Jira
 *      displayName. Corporate `firstname.lastname@` / `firstname-lastname` handles
 *      resolve here even with no Jira email.
 *   3. BEHAVIOURAL (probabilistic, PII-free) — how often a GitHub person's PRs
 *      link (pr_issue_links) to issues ASSIGNED to a Jira person. High, dominant
 *      co-occurrence is strong same-person evidence.
 *
 * Fusion: email alone → auto-merge. Name + corroborating behaviour → auto-merge.
 * Dominant behaviour alone → auto-merge. A single weak signal → the human-confirm
 * queue (candidate_matches), never a silent merge. Every auto-merge is recorded as
 * a confirmed candidate_match (audited + reversible via unmergeIdentities).
 *
 * INCREMENTAL: only "unpaired" persons are considered (a GitHub person with no
 * Jira identity, or vice-versa). After the initial full run, almost everyone is
 * paired/queued/rejected, so iterative syncs only resolve genuinely new handles.
 * Pairs already confirmed or rejected are never re-proposed (human decisions and
 * prior merges are respected). The LLM-adjudication tier for the ambiguous
 * residual is a deliberate follow-up; this pass is fully deterministic.
 */

import { safeJsonParse } from '../json.js'

// Fusion thresholds. Behavioural `share` = co-occurrences with this Jira person /
// total co-occurrences for the GitHub person; `count` = absolute co-occurrences.
//
// History: `BEHAV_AUTO_COUNT` was 2 — a single corroborating PR was enough to
// auto-merge with a name match. Bumped to 5 so at-scale near-namesakes (two
// "Alex Barnes" working on overlapping tickets) need real volume of evidence
// before a name+behaviour merge fires. Behaviour-only (no name) auto-merge has
// been REMOVED entirely; that tier now goes to the human queue regardless of
// share/count, because behaviour can be coincidental at low cohort sizes.
const BEHAV_AUTO_SHARE = 0.5
const BEHAV_AUTO_COUNT = 5
const BEHAV_STRONG_SHARE = 0.7
const BEHAV_STRONG_COUNT = 5
const BEHAV_QUEUE_SHARE = 0.4
const BEHAV_QUEUE_COUNT = 2

// Handle/email tokens that are organisation/role markers, not parts of a name.
const STOPWORDS = new Set(['iph', 'bot', 'dev', 'ext', 'contractor', 'admin', 'team', 'eng'])

function newId() {
  return crypto.randomUUID()
}

function parseRaw(raw) {
  return safeJsonParse(raw, {})
}

/** Split a string into lowercase alphanumeric name tokens. */
function tokenize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** Normalised (A,B) identity-pair key matching the store's dedup order. */
function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * Does the GitHub-side name bag contain the Jira display name? Requires the Jira
 * name to be a real multi-token human name and ALL its tokens to be present on the
 * GitHub side (so "Alex Barnes" ⊆ {alex,barnes,iph} matches, but "Alex" alone or a
 * single shared token does not).
 */
function nameMatches(githubTokens, jiraTokens) {
  if (jiraTokens.length < 2) return false
  for (const t of jiraTokens) {
    if (!githubTokens.has(t)) return false
  }
  return true
}

export async function stitchCrossSource(store, options = {}) {
  const now = options.now ?? new Date().toISOString()
  let autoMerged = 0
  let queued = 0

  const identities = (await store.listAllIdentities()).filter((i) => !i.isBot && i.personId)
  if (identities.length === 0) return { autoMerged, queued }

  const personOf = new Map() // identityId -> personId
  const persons = new Map() // personId -> aggregate
  for (const id of identities) {
    personOf.set(id.id, id.personId)
    let p = persons.get(id.personId)
    if (!p) {
      p = {
        id: id.personId,
        hasGithub: false,
        hasJira: false,
        emails: new Set(),
        nameTokens: new Set(),
        githubAnchorId: null,
        jiraAnchorId: null,
        jiraIdentityIds: [],
        humanName: null,
      }
      persons.set(id.personId, p)
    }
    if (id.kind === 'jira_account') {
      p.hasJira = true
      p.jiraAnchorId ??= id.id
      p.jiraIdentityIds.push(id.id)
      const r = parseRaw(id.raw)
      if (r.displayName) {
        p.humanName ??= r.displayName
        for (const t of tokenize(r.displayName)) p.nameTokens.add(t)
      }
      if (r.emailAddress) p.emails.add(String(r.emailAddress).toLowerCase())
    } else if (id.kind === 'github_login') {
      p.hasGithub = true
      p.githubAnchorId ??= id.id
      for (const t of tokenize(id.externalId)) p.nameTokens.add(t)
      const r = parseRaw(id.raw)
      if (typeof r.email === 'string' && r.email.includes('@')) {
        p.emails.add(r.email.toLowerCase())
        for (const t of tokenize(r.email.split('@')[0])) p.nameTokens.add(t)
      }
      if (r.name) {
        p.humanName ??= r.name
        for (const t of tokenize(r.name)) p.nameTokens.add(t)
      }
    } else if (id.kind === 'commit_email') {
      p.hasGithub = true
      const email = id.externalId.toLowerCase()
      p.emails.add(email)
      for (const t of tokenize(email.split('@')[0])) p.nameTokens.add(t)
    }
  }

  // Unpaired persons: a GitHub person with no Jira identity (to resolve) and the
  // Jira-only persons that are valid merge targets.
  const unpairedGithub = []
  const unpairedJira = []
  for (const p of persons.values()) {
    if (p.hasGithub && !p.hasJira && p.githubAnchorId) unpairedGithub.push(p)
    else if (p.hasJira && !p.hasGithub && p.jiraAnchorId) unpairedJira.push(p)
  }
  if (unpairedGithub.length === 0 || unpairedJira.length === 0) {
    return { autoMerged, queued }
  }

  // Indices over Jira targets for cheap candidate lookup (avoid O(gh × jira)).
  const jiraByEmail = new Map() // email -> jira person
  const jiraByToken = new Map() // name token -> [jira persons]
  for (const jp of unpairedJira) {
    for (const e of jp.emails) jiraByEmail.set(e, jp)
    for (const t of jp.nameTokens) {
      const list = jiraByToken.get(t)
      if (list) list.push(jp)
      else jiraByToken.set(t, [jp])
    }
  }

  // Behavioural co-occurrence: githubPerson -> (jiraPerson -> count) via
  // pr_issue_links (PR author person ↔ issue assignee person).
  const prAuthorPerson = new Map() // prId -> personId
  for (const pr of await store.getAllPullRequests()) {
    const pid = personOf.get(pr.authorIdentityId)
    if (pid) prAuthorPerson.set(pr.id, pid)
  }
  const issueAssigneePerson = new Map() // issueId -> personId
  for (const row of await store.getAllIssueAssignees()) {
    if (!row.assigneeIdentityId) continue
    const pid = personOf.get(row.assigneeIdentityId)
    if (pid) issueAssigneePerson.set(row.issueId, pid)
  }
  const cooccur = new Map() // gpid -> Map(jpid -> count)
  const cooccurTotal = new Map() // gpid -> count
  for (const link of await store.getAllPrIssueLinks()) {
    const gp = prAuthorPerson.get(link.prId)
    const jp = issueAssigneePerson.get(link.issueId)
    if (!gp || !jp || gp === jp) continue
    let inner = cooccur.get(gp)
    if (!inner) {
      inner = new Map()
      cooccur.set(gp, inner)
    }
    inner.set(jp, (inner.get(jp) ?? 0) + 1)
    cooccurTotal.set(gp, (cooccurTotal.get(gp) ?? 0) + 1)
  }

  // Existing decisions: never re-propose a confirmed/rejected pair; reuse a
  // pending row's id if the identical (pair, reason) was already queued.
  const decidedPairs = new Set() // normalised pair with a confirmed/rejected row
  const pendingByPairReason = new Map() // `${pair}|${reason}` -> matchId
  for (const m of await store.getCandidateMatches()) {
    const pk = pairKey(m.identityIdA, m.identityIdB)
    if (m.status === 'confirmed' || m.status === 'rejected') decidedPairs.add(pk)
    if (m.status === 'pending') pendingByPairReason.set(`${pk}|${m.reason}`, m.id)
  }

  const claimedJira = new Set() // jira personId already merged this run

  /** Pick the best Jira target + decision for one unpaired GitHub person. */
  function decide(g) {
    // 1. Email — deterministic, highest confidence.
    for (const e of g.emails) {
      const jp = jiraByEmail.get(e)
      if (jp && !claimedJira.has(jp.id)) {
        return { jp, reason: 'xsrc_email', confidence: 1.0, auto: true }
      }
    }

    // Behavioural best candidate for this GitHub person.
    const inner = cooccur.get(g.id)
    const total = cooccurTotal.get(g.id) ?? 0
    let behavJp = null
    let behavCount = 0
    if (inner) {
      for (const [jpid, count] of inner) {
        if (claimedJira.has(jpid)) continue
        if (count > behavCount) {
          behavCount = count
          behavJp = persons.get(jpid)
        }
      }
    }
    const behavShare = total > 0 ? behavCount / total : 0
    const behavIsJiraTarget = behavJp?.hasJira && !behavJp.hasGithub
    const behavName = behavIsJiraTarget && nameMatches(g.nameTokens, [...behavJp.nameTokens])

    // 2. Name + corroborating behaviour → auto-merge.
    if (
      behavIsJiraTarget &&
      behavName &&
      behavShare >= BEHAV_AUTO_SHARE &&
      behavCount >= BEHAV_AUTO_COUNT
    ) {
      return { jp: behavJp, reason: 'xsrc_name_behavioral', confidence: 0.95, auto: true }
    }
    // 3. Dominant behaviour ALONE (no name corroboration) → human queue.
    // Previously this tier auto-merged at share≥0.7 / count≥5 with confidence
    // 0.85. At scale, behaviour-only signals can fuse two genuinely different
    // people (e.g. a tech lead who repeatedly links to a junior's tickets), so
    // any merge without a name or email corroboration must be human-confirmed.
    if (behavIsJiraTarget && behavShare >= BEHAV_STRONG_SHARE && behavCount >= BEHAV_STRONG_COUNT) {
      return { jp: behavJp, reason: 'xsrc_behavioral', confidence: 0.85, auto: false }
    }

    // 4. Name match (single unambiguous candidate) → human queue.
    const nameCands = new Set()
    for (const t of g.nameTokens) {
      for (const jp of jiraByToken.get(t) ?? []) {
        if (!claimedJira.has(jp.id) && nameMatches(g.nameTokens, [...jp.nameTokens])) {
          nameCands.add(jp)
        }
      }
    }
    if (nameCands.size === 1) {
      const jp = [...nameCands][0]
      return { jp, reason: 'xsrc_name', confidence: 0.6, auto: false }
    }
    // 5. Moderate behaviour → human queue.
    if (behavIsJiraTarget && behavShare >= BEHAV_QUEUE_SHARE && behavCount >= BEHAV_QUEUE_COUNT) {
      return { jp: behavJp, reason: 'xsrc_behavioral', confidence: 0.5, auto: false }
    }
    return null
  }

  // Deterministic processing order so a Jira target is claimed reproducibly.
  unpairedGithub.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const g of unpairedGithub) {
    const d = decide(g)
    if (!d) continue
    const pk = pairKey(g.githubAnchorId, d.jp.jiraAnchorId)
    if (decidedPairs.has(pk)) continue // already merged or explicitly rejected

    if (d.auto) {
      // Reuse a prior pending row for the same (pair, reason) if present, else
      // create one; then confirm — which atomically links the Jira anchor to the
      // GitHub person (resolveCandidateMatch targets identityA's person).
      let matchId = pendingByPairReason.get(`${pk}|${d.reason}`)
      if (!matchId) {
        matchId = newId()
        await store.appendCandidateMatch({
          id: matchId,
          identityIdA: g.githubAnchorId,
          identityIdB: d.jp.jiraAnchorId,
          reason: d.reason,
          confidence: d.confidence,
          status: 'pending',
          decidedAt: null,
          decidedBy: null,
          createdAt: now,
          updatedAt: now,
        })
      }
      await store.resolveCandidateMatch(matchId, 'confirmed', 'auto-stitch', now)

      // Repoint any additional Jira identities of the target (rare) onto the
      // canonical GitHub person so the merge is complete.
      for (const jid of d.jp.jiraIdentityIds) {
        if (jid === d.jp.jiraAnchorId) continue
        const ident = await store.findIdentityById(jid)
        if (ident && ident.personId !== g.id) {
          await store.setIdentityPerson(ident.id, g.id, now)
        }
      }

      // Name the canonical person with a human name (prefer the Jira displayName).
      const human = d.jp.humanName ?? g.humanName
      if (human) {
        const person = await store.getPerson(g.id)
        if (person && person.displayName !== human) {
          await store.upsertPerson({ ...person, displayName: human, updatedAt: now })
        }
      }

      claimedJira.add(d.jp.id)
      decidedPairs.add(pk)
      autoMerged++
    } else {
      // Queue for human confirmation — skip if this exact (pair, reason) is
      // already pending.
      if (pendingByPairReason.has(`${pk}|${d.reason}`)) continue
      const matchId = newId()
      await store.appendCandidateMatch({
        id: matchId,
        identityIdA: g.githubAnchorId,
        identityIdB: d.jp.jiraAnchorId,
        reason: d.reason,
        confidence: d.confidence,
        status: 'pending',
        decidedAt: null,
        decidedBy: null,
        createdAt: now,
        updatedAt: now,
      })
      pendingByPairReason.set(`${pk}|${d.reason}`, matchId)
      queued++
    }
  }

  return { autoMerged, queued }
}
