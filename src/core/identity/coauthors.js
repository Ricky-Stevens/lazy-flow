import { buildIdentityId } from './resolve.js'

// ---------------------------------------------------------------------------
// Trailer parsing
// ---------------------------------------------------------------------------

/**
 * Parse co-author and signed-off-by trailers from a commit message.
 *
 * Git trailer format:
 *   Co-authored-by: Name <email@example.com>
 *   Signed-off-by:  Name <email@example.com>
 *
 * Returns an array of parsed trailers (may be empty if none found).
 */
export function parseTrailers(message) {
  const trailers = []

  // Match Co-authored-by and Signed-off-by lines anywhere in the message
  const coAuthorRe = /^Co-authored-by:\s+(.+?)\s+<([^>]+)>/gim
  const signedOffRe = /^Signed-off-by:\s+(.+?)\s+<([^>]+)>/gim

  for (const match of message.matchAll(coAuthorRe)) {
    const name = match[1]?.trim()
    const email = match[2]?.trim().toLowerCase()
    if (name && email) {
      trailers.push({ role: 'co_author', name, email })
    }
  }

  for (const match of message.matchAll(signedOffRe)) {
    const name = match[1]?.trim()
    const email = match[2]?.trim().toLowerCase()
    if (name && email) {
      // Signed-off-by is treated as co_author attribution for commit_authors
      trailers.push({ role: 'co_author', name, email })
    }
  }

  return trailers
}

// ---------------------------------------------------------------------------
// Main parseCommitAuthors pass
// ---------------------------------------------------------------------------

/**
 * Parse co-author trailers from all commits in the store and persist
 * `commit_authors` rows + upsert corresponding `identities` rows.
 *
 * For each commit:
 *   - Always inserts a commit_authors row for the primary author (role='author', source='api').
 *   - Parses Co-authored-by / Signed-off-by trailers → role='co_author', source='trailer'.
 *   - Upserts a commit_email identity for each trailer email found.
 *
 * Idempotent: duplicate (repoId, sha, identityId, role) rows are silently ignored
 * via the composite PK.
 */
export async function parseCommitAuthors(store, options = {}) {
  const now = options.now ?? new Date().toISOString()
  let commitAuthorRowsInserted = 0
  let identitiesUpserted = 0

  const orgs = await store.listOrganisations()
  for (const org of orgs) {
    const repos = await store.getRepositoriesByOrg(org.id)
    for (const repo of repos) {
      const commits = await store.getCommitsByRepo(repo.id)
      for (const commit of commits) {
        // Insert primary author row (api source)
        const authorRow = {
          repoId: commit.repoId,
          sha: commit.sha,
          identityId: commit.authorIdentityId,
          role: 'author',
          source: 'api',
        }
        await store.upsertCommitAuthor(authorRow)
        commitAuthorRowsInserted++

        // Parse trailers from the commit message embedded in raw
        const message = extractMessageFromRaw(commit.raw)
        if (!message) continue

        const trailers = parseTrailers(message)
        for (const trailer of trailers) {
          // Upsert a commit_email identity for this trailer
          const identityId = buildIdentityId('commit_email', trailer.email)
          await store.upsertIdentity({
            id: identityId,
            personId: null,
            kind: 'commit_email',
            externalId: trailer.email,
            isBot: false,
            confidence: 1,
            raw: JSON.stringify({ email: trailer.email, name: trailer.name }),
            updatedAt: now,
          })
          identitiesUpserted++

          const coAuthorRow = {
            repoId: commit.repoId,
            sha: commit.sha,
            identityId,
            role: trailer.role,
            source: 'trailer',
          }
          await store.upsertCommitAuthor(coAuthorRow)
          commitAuthorRowsInserted++
        }
      }
    }
  }

  return { commitAuthorRowsInserted, identitiesUpserted }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the commit message from a raw GitHub commit payload.
 * The commit message lives at raw.commit.message or raw.message.
 */
function extractMessageFromRaw(raw) {
  try {
    const parsed = JSON.parse(raw)
    // REST API shape: { commit: { message: '...' } }
    const commit = parsed.commit
    if (typeof commit?.message === 'string') return commit.message
    // Flat shape (used in tests): { message: '...' }
    if (typeof parsed.message === 'string') return parsed.message
    return null
  } catch {
    return null
  }
}
